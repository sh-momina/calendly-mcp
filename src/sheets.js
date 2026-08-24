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
 * Always appends a new row — one row per event (booked / rescheduled /
 * cancelled), even for the same contact. Nothing existing is ever
 * modified or removed.
 */
export function registerSheetsTool(server, getTenant) {
  server.registerTool(
    'log_meeting_status',
    {
      title: 'Log meeting status to Google Sheets',
      description:
        'Adds a new row to the connected Google Sheet recording this contact and their meeting status. Call this every time a meeting is booked, rescheduled, or cancelled, right after the corresponding Calendly action succeeds. Always adds a fresh row — never modifies or removes any existing row, even for a repeat contact.',
      inputSchema: {
        name: z.string().describe('Full name of the contact.'),
        phone: z.string().optional().describe('Use "N/A" if not provided.'),
        email: z.string().email().describe('Email address of the contact.'),
        status: z
          .enum(['Meeting Booked', 'Meeting Rescheduled', 'Meeting Cancelled'])
          .describe('The status of this specific event.'),
        time: z.string().describe('ISO 8601 timestamp of the meeting (the new time for a reschedule, or the meeting time for a booking/cancellation).'),
        previous_time: z
          .string()
          .optional()
          .describe(
            'For a reschedule or cancellation, the ORIGINAL start_time of the specific meeting being changed (from list_meetings/get_meeting). Required whenever the contact could have more than one meeting on record, so the log shows exactly which booking this refers to.'
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
        let changeNote = status === 'Meeting Booked' ? '' : status.replace('Meeting ', '');
        if (previous_time) changeNote += ` (was ${previous_time})`;
        const rowValues = [name, phone || 'N/A', email, status, time, changeNote];

        const appendRes = await sheetsFetch(
          `/${tenant.sheetId}/values/A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
          accessToken,
          { method: 'POST', body: JSON.stringify({ values: [rowValues] }) }
        );
        const rowNumber = parseInt(appendRes.updates.updatedRange.match(/(\d+):/)[1], 10);

        const color = STATUS_COLORS[status] || STATUS_COLORS['Meeting Booked'];
        await colorRow(tenant.sheetId, rowNumber, color, accessToken);

        return ok(`Logged "${status}" for ${name} (${email}) as a new row.`, { row: rowNumber, status });
      } catch (err) {
        return fail(err.message);
      }
    }
  );
}
