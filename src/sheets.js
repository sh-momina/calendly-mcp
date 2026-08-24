import { z } from 'zod';
import { JWT } from 'google-auth-library';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// Column layout: A Name | B Phone | C Email | D Status | E Time | F Changes
const STATUS_COLORS = {
  'Meeting Booked': { red: 1, green: 1, blue: 1 },           // white/default
  'Meeting Rescheduled': { red: 1, green: 0.95, blue: 0.6 }, // yellow
  'Meeting Cancelled': { red: 0.96, green: 0.78, blue: 0.78 } // red
};

const ok = (text, data) => ({
  content: [{ type: 'text', text }],
  structuredContent: data ? { data } : undefined
});

const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

function authClientFor(rawServiceAccountJson) {
  const creds = typeof rawServiceAccountJson === 'string'
    ? JSON.parse(rawServiceAccountJson)
    : rawServiceAccountJson;
  return new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

async function getAccessToken(tenant) {
  const raw = tenant.googleServiceAccount || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      'No Google service account is configured for this tenant, and no shared default (GOOGLE_SERVICE_ACCOUNT_JSON) is set.'
    );
  }
  const client = authClientFor(raw);
  const { token } = await client.getAccessToken();
  return token;
}

async function sheetsFetch(path, accessToken, options = {}) {
  const res = await fetch(`${SHEETS_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Sheets API error (${res.status}): ${body}`);
  }
  return res.json();
}

// Finds the row for THIS specific meeting — matched by email AND the
// meeting's current time in the sheet — not just "any row for this email".
// Needed because one contact can have several separate bookings/rows.
async function findRowByEmailAndTime(sheetId, email, time, accessToken) {
  const data = await sheetsFetch(`/${sheetId}/values/A:F`, accessToken);
  const rows = data.values || [];
  const targetEmail = email.trim().toLowerCase();
  const targetTime = time.trim();
  for (let i = 1; i < rows.length; i++) { // skip header row
    const rowEmail = (rows[i][2] || '').trim().toLowerCase();
    const rowTime = (rows[i][4] || '').trim();
    if (rowEmail === targetEmail && rowTime === targetTime) return i + 1; // 1-indexed
  }
  return null;
}

async function getGridId(sheetId, accessToken) {
  const meta = await sheetsFetch(`/${sheetId}?fields=sheets.properties`, accessToken);
  return meta.sheets[0].properties.sheetId;
}

async function colorRow(sheetId, rowNumber, color, accessToken) {
  const gridId = await getGridId(sheetId, accessToken);
  await sheetsFetch(`/${sheetId}:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        repeatCell: {
          range: {
            sheetId: gridId,
            startRowIndex: rowNumber - 1,
            endRowIndex: rowNumber,
            startColumnIndex: 0,
            endColumnIndex: 6
          },
          cell: { userEnteredFormat: { backgroundColor: color } },
          fields: 'userEnteredFormat.backgroundColor'
        }
      }]
    })
  });
}

/**
 * New bookings always get a fresh row. Reschedules and cancellations
 * update the SAME row for that specific meeting (found via email +
 * previous_time), leaving every other row completely untouched.
 */
export function registerSheetsTool(server, getTenant) {
  server.registerTool(
    'log_meeting_status',
    {
      title: 'Log meeting status to Google Sheets',
      description:
        'For a new booking, adds a fresh row to the connected Google Sheet. For a reschedule or cancellation, updates the existing row for that specific meeting in place (found via email and previous_time) — every other row, including other meetings for the same contact, is left untouched. Call this right after the corresponding Calendly action succeeds.',
      inputSchema: {
        name: z.string().describe('Full name of the contact.'),
        phone: z.string().optional().describe('Use "N/A" if not provided.'),
        email: z.string().email().describe('Email address of the contact.'),
        status: z
          .enum(['Meeting Booked', 'Meeting Rescheduled', 'Meeting Cancelled'])
          .describe('The status of this specific event.'),
        time: z.string().describe('ISO 8601 timestamp of the meeting (the new time for a reschedule; the meeting time being cancelled for a cancellation; the booked time for a new booking).'),
        previous_time: z
          .string()
          .optional()
          .describe(
            'REQUIRED for Meeting Rescheduled and Meeting Cancelled: the ORIGINAL start_time of the specific meeting being changed (from list_meetings/get_meeting), exactly as it was passed when that meeting was first booked. Used to find and update the correct row. Omit only for a new Meeting Booked.'
          )
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ name, phone, email, status, time, previous_time }) => {
      try {
        const tenant = getTenant();
        if (!tenant.sheetId) {
          return fail('No Google Sheet is configured for this account.');
        }

        const accessToken = await getAccessToken(tenant);

        if (status === 'Meeting Booked') {
          const rowValues = [name, phone || 'N/A', email, status, time, ''];
          const appendRes = await sheetsFetch(
            `/${tenant.sheetId}/values/A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
            accessToken,
            { method: 'POST', body: JSON.stringify({ values: [rowValues] }) }
          );
          const rowNumber = parseInt(appendRes.updates.updatedRange.match(/(\d+):/)[1], 10);
          await colorRow(tenant.sheetId, rowNumber, STATUS_COLORS[status], accessToken);
          return ok(`Logged new booking for ${name} (${email}).`, { row: rowNumber, status });
        }

        // Rescheduled or Cancelled: update the matching row in place.
        if (!previous_time) {
          return fail('previous_time is required for a reschedule or cancellation, so the correct row can be found.');
        }

        const existingRow = await findRowByEmailAndTime(tenant.sheetId, email, previous_time, accessToken);
        const changeNote = `${status.replace('Meeting ', '')} (was ${previous_time})`;

        if (existingRow) {
          const rowValues = [name, phone || 'N/A', email, status, time, changeNote];
          await sheetsFetch(
            `/${tenant.sheetId}/values/A${existingRow}:F${existingRow}?valueInputOption=USER_ENTERED`,
            accessToken,
            { method: 'PUT', body: JSON.stringify({ values: [rowValues] }) }
          );
          await colorRow(tenant.sheetId, existingRow, STATUS_COLORS[status], accessToken);
          return ok(`Updated the existing row for ${name} (${email}).`, { row: existingRow, status });
        }

        // No matching original row found (e.g. it predates this sheet, or
        // was booked before logging existed) — append instead of losing the event.
        const rowValues = [name, phone || 'N/A', email, status, time, `${changeNote} — original row not found, added as new`];
        const appendRes = await sheetsFetch(
          `/${tenant.sheetId}/values/A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
          accessToken,
          { method: 'POST', body: JSON.stringify({ values: [rowValues] }) }
        );
        const rowNumber = parseInt(appendRes.updates.updatedRange.match(/(\d+):/)[1], 10);
        await colorRow(tenant.sheetId, rowNumber, STATUS_COLORS[status], accessToken);
        return ok(`No existing row found for that meeting — added as a new row instead.`, { row: rowNumber, status });
      } catch (err) {
        return fail(err.message);
      }
    }
  );
}
