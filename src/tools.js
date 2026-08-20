import { z } from 'zod';
import { CalendlyClient, CalendlyError, uuidOf } from './calendly.js';
import { resolveStart, validateBookingTime, speak, DAY } from './dates.js';

const ok = (text, data) => ({
  content: [{ type: 'text', text }],
  structuredContent: data ? { data } : undefined
});

const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

/** Match an event type by name when the agent doesn't have a URI. */
async function resolveEventType(client, { event_type_uri, event_type_name }) {
  if (event_type_uri) return { uri: event_type_uri };

  const types = await client.listEventTypes();
  if (!types.length) throw new Error('This Calendly account has no active event types.');

  if (!event_type_name) {
    if (types.length === 1) return types[0];
    const names = types.map((t) => `"${t.name}" (${t.duration} min)`).join(', ');
    throw new Error(`Multiple meeting types exist — specify which one. Options: ${names}`);
  }

  const needle = event_type_name.toLowerCase().trim();
  const match =
    types.find((t) => t.name.toLowerCase() === needle) ||
    types.find((t) => t.name.toLowerCase().includes(needle)) ||
    types.find((t) => needle.includes(t.name.toLowerCase()));

  if (!match) {
    const names = types.map((t) => `"${t.name}"`).join(', ');
    throw new Error(`No meeting type matching "${event_type_name}". Available: ${names}`);
  }
  return match;
}

/**
 * Registers every Calendly tool on an McpServer instance.
 * `getToken` resolves the caller's Calendly token per request.
 */
/**
 * Calendly rejects a booking when the event type has a location configured and
 * the request omits it: "Specified location kind is not configured for this
 * event type." Agents have no way to know this, so we read the event type's own
 * location settings and fill it in automatically.
 */
const NEEDS_INVITEE_INPUT = new Set(['ask_invitee', 'outbound_call', 'invitee_specified']);

function buildLocation(eventType, { location_kind, location_detail }) {
  const configured = eventType.locations ?? [];

  // An explicit override from the caller always wins.
  if (location_kind) {
    const loc = { kind: location_kind };
    if (location_detail) loc.location = location_detail;
    return { location: loc };
  }

  if (!configured.length) return { location: undefined };

  if (configured.length > 1) {
    const kinds = configured.map((l) => l.kind).join(', ');
    return {
      error: `"${eventType.name}" offers several meeting locations (${kinds}). Ask the caller which they prefer, then retry with location_kind set to one of those.`
    };
  }

  const only = configured[0];
  if (NEEDS_INVITEE_INPUT.has(only.kind) && !location_detail) {
    const asking =
      only.kind === 'outbound_call'
        ? 'a phone number to call them on'
        : 'where the meeting should take place (a phone number or an address)';
    return {
      error: `"${eventType.name}" requires ${asking}. Ask the caller for it, then retry with location_detail set.`
    };
  }

  const loc = { kind: only.kind };
  if (location_detail) loc.location = location_detail;
  return { location: loc };
}

/**
 * Models routinely pass a placeholder like "your_event_uuid" or "event_uuid_here"
 * instead of copying a real one, which Calendly answers with a bare 404. Catch it
 * before the API call and tell the model exactly how to get a real value.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkEventUuid(value) {
  const raw = String(value ?? '').trim();

  if (!raw) {
    return 'No event_uuid was given. Call list_meetings first and copy the event_uuid of the meeting the caller means.';
  }

  if (!UUID_RE.test(raw)) {
    return (
      `"${raw}" is not a real event_uuid — it looks like placeholder text. ` +
      'Call list_meetings, find the meeting the caller is talking about, and copy its event_uuid exactly ' +
      '(it looks like 0bf16009-b996-4052-b74e-ec361e608a00). Never invent or abbreviate this value.'
    );
  }

  return null;
}

export function registerCalendlyTools(server, getToken) {
  const withClient = (handler) => async (args) => {
    try {
      const client = new CalendlyClient(getToken());
      return await handler(client, args ?? {});
    } catch (err) {
      if (err instanceof CalendlyError) return fail(`${err.message}\n\nWhat to do: ${err.hint}`);
      return fail(err.message);
    }
  };

  server.registerTool(
    'whoami',
    {
      title: 'Get the connected Calendly account',
      description:
        'Returns the name, email, timezone and scheduling URL of the Calendly account this agent is acting for. Call this once if you need to know the host\'s timezone.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    withClient(async (client) => {
      const me = await client.me();
      return ok(
        `Connected as ${me.name} (${me.email}). Host timezone: ${me.timezone}. Scheduling page: ${me.scheduling_url}`,
        { name: me.name, email: me.email, timezone: me.timezone, scheduling_url: me.scheduling_url }
      );
    })
  );

  server.registerTool(
    'list_event_types',
    {
      title: 'List bookable meeting types',
      description:
        'Lists the meeting types that can be booked (e.g. "30 Minute Meeting", "Discovery Call") with their duration and URI. Call this first when you do not know which meeting type the caller wants.',
      inputSchema: {
        include_inactive: z.boolean().optional().describe('Include event types that are turned off. Defaults to false.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    withClient(async (client, { include_inactive }) => {
      const types = await client.listEventTypes({ activeOnly: !include_inactive });
      if (!types.length) return ok('This Calendly account has no active meeting types.', []);

      const lines = types.map((t) => {
        const locs = (t.locations ?? []).map((l) => l.kind).join(', ') || 'none configured';
        return `• ${t.name} — ${t.duration} min${t.active ? '' : ' (inactive)'}\n  location: ${locs}\n  uri: ${t.uri}`;
      });
      return ok(
        `${types.length} meeting type(s) available:\n${lines.join('\n')}`,
        types.map((t) => ({ name: t.name, duration: t.duration, uri: t.uri, active: t.active, scheduling_url: t.scheduling_url }))
      );
    })
  );

  server.registerTool(
    'find_available_times',
    {
      title: 'Find open meeting slots',
      description:
        'Finds open time slots for a meeting type. Always call this before booking — never guess a time. Accepts loose dates like "tomorrow", "monday" or "+3 days"; past dates are automatically moved to now, so this never fails on a stale date.',
      inputSchema: {
        event_type_name: z.string().optional().describe('Name of the meeting type, e.g. "Discovery Call". Omit if there is only one.'),
        event_type_uri: z.string().optional().describe('Exact event type URI, if already known.'),
        starting: z.string().optional().describe('When to start looking: "today", "tomorrow", "monday", "+3 days", or an ISO date. Defaults to now.'),
        days: z.number().int().min(1).max(28).optional().describe('How many days ahead to search. Defaults to 7.'),
        timezone: z.string().optional().describe('IANA timezone for displaying times, e.g. "Asia/Karachi". Defaults to the host timezone.'),
        limit: z.number().int().min(1).max(40).optional().describe('Maximum slots to return. Defaults to 10.')
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    withClient(async (client, args) => {
      const me = await client.me();
      const tz = args.timezone || me.timezone || 'UTC';
      const eventType = await resolveEventType(client, args);

      const start = resolveStart(args.starting, tz);
      const end = new Date(start.getTime() + (args.days ?? 7) * DAY);

      const slots = await client.availableTimes(eventType.uri, start.toISOString(), end.toISOString());
      if (!slots.length) {
        return ok(
          `No open slots between ${speak(start.toISOString(), tz)} and ${speak(end.toISOString(), tz)}. Try a later window or a different meeting type.`,
          []
        );
      }

      const shown = slots.slice(0, args.limit ?? 10);
      const lines = shown.map((s) => `• ${speak(s.start_time, tz)}\n  start_time: ${s.start_time}`);
      return ok(
        `${slots.length} open slot(s) for "${eventType.name ?? 'this meeting type'}" (times shown in ${tz}). Offer the caller two or three of these, then pass the exact start_time to book_meeting:\n${lines.join('\n')}`,
        { event_type_uri: eventType.uri, timezone: tz, slots: shown.map((s) => s.start_time) }
      );
    })
  );

  server.registerTool(
    'book_meeting',
    {
      title: 'Book a meeting',
      description:
        'Books a meeting on the connected Calendly account and sends the normal confirmation email and calendar invite. Requires a paid Calendly plan. The start_time must be a slot returned by find_available_times, copied exactly.',
      inputSchema: {
        start_time: z.string().describe('Exact UTC start time from find_available_times, e.g. "2026-08-20T14:30:00Z".'),
        invitee_name: z.string().describe('Full name of the person being booked.'),
        invitee_email: z.string().email().describe('Email address of the person being booked.'),
        event_type_name: z.string().optional().describe('Name of the meeting type. Omit if there is only one.'),
        event_type_uri: z.string().optional().describe('Exact event type URI, if already known.'),
        invitee_timezone: z.string().optional().describe('IANA timezone of the invitee, e.g. "Asia/Karachi".'),
        location_kind: z
          .string()
          .optional()
          .describe('Meeting location kind if the event type requires one, e.g. "zoom_conference", "google_conference", "physical", "ask_invitee".'),
        location_detail: z.string().optional().describe('Location value when the kind needs one, e.g. a phone number or address.'),
        guests: z.array(z.string().email()).optional().describe('Additional email addresses to add to the invite.'),
        notes: z.string().optional().describe('Answer to the event type\'s first question, e.g. what the meeting is about.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    withClient(async (client, args) => {
      const when = validateBookingTime(args.start_time);
      if (!when.ok) return fail(when.error);

      const me = await client.me();
      const tz = args.invitee_timezone || me.timezone || 'UTC';
      let eventType = await resolveEventType(client, args);

      // Ensure we have the full resource — location config lives there.
      if (!eventType.locations) eventType = await client.getEventType(eventType.uri);

      const { location, error } = buildLocation(eventType, args);
      if (error) return fail(error);

      const payload = {
        event_type: eventType.uri,
        start_time: when.iso,
        invitee: { name: args.invitee_name, email: args.invitee_email, timezone: tz }
      };
      if (location) payload.location = location;
      if (args.guests?.length) payload.event_guests = args.guests;
      if (args.notes) payload.questions_and_answers = [{ question: 'Notes', answer: args.notes, position: 1 }];

      let invitee;
      try {
        invitee = await client.createInvitee(payload);
      } catch (err) {
        // Nothing was created, so it is safe to spend an extra call working out
        // why — but only now, not on every successful booking.
        // Calendly caps booking creation separately from the rest of the API.
        // When that cap is hit, direct booking is unavailable for a while, but
        // one-time scheduling links still work — so say that plainly.
        if (err.status === 429) {
          return fail(
            `Calendly is not accepting direct bookings right now (rate limited on booking creation). Nothing was booked. ` +
              `Use create_scheduling_link instead and send the caller the link so they can confirm ${speak(when.iso, tz)} themselves.`
          );
        }

        if (err.status === 400) {
          const nearby = await client
            .availableTimes(
              eventType.uri,
              new Date(Math.max(Date.now() + 2 * 6e4, new Date(when.iso).getTime() - 6e4)).toISOString(),
              new Date(new Date(when.iso).getTime() + 2 * 36e5).toISOString()
            )
            .catch(() => []);

          const weekday = new Date(when.iso).toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
          return fail(
            `Calendly would not accept ${speak(when.iso, tz)}, so nothing was booked. ` +
              (nearby.length
                ? `Open slots near it: ${nearby.slice(0, 3).map((s) => `${speak(s.start_time, tz)} (start_time: ${s.start_time})`).join('; ')}. Offer one of these.`
                : `Nothing is open within two hours of it — that date is a ${weekday}. Check the date is what the caller meant, then call find_available_times.`)
          );
        }
        throw err;
      }

      return ok(
        `Booked. ${args.invitee_name} is confirmed for ${speak(when.iso, tz)}. A confirmation email and calendar invite have been sent to ${args.invitee_email}.\n\nReschedule: ${invitee.reschedule_url}\nCancel: ${invitee.cancel_url}`,
        {
          event_uri: invitee.event,
          event_uuid: uuidOf(invitee.event),
          start_time: when.iso,
          reschedule_url: invitee.reschedule_url,
          cancel_url: invitee.cancel_url
        }
      );
    })
  );

  server.registerTool(
    'list_meetings',
    {
      title: 'List scheduled meetings',
      description:
        'Lists upcoming or past meetings on the connected calendar. Use this to find the meeting a caller wants to move or cancel — it returns the event_uuid the other tools need.',
      inputSchema: {
        invitee_email: z.string().email().optional().describe('Only meetings booked by this person.'),
        status: z.enum(['active', 'canceled']).optional().describe('Defaults to active.'),
        starting: z.string().optional().describe('Earliest start time to include: "today", "tomorrow", or an ISO date. Defaults to now.'),
        days: z.number().int().min(1).max(365).optional().describe('How many days ahead to look. Defaults to 30.'),
        limit: z.number().int().min(1).max(50).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    withClient(async (client, args) => {
      const me = await client.me();
      const tz = me.timezone || 'UTC';
      const start = resolveStart(args.starting, tz);
      const end = new Date(start.getTime() + (args.days ?? 30) * DAY);

      const events = await client.listScheduledEvents({
        status: args.status ?? 'active',
        inviteeEmail: args.invitee_email,
        minStart: start.toISOString(),
        maxStart: end.toISOString(),
        count: args.limit ?? 25
      });

      if (!events.length) return ok('No meetings found in that window.', []);

      const lines = events.map(
        (e) => `• ${e.name} — ${speak(e.start_time, tz)} [${e.status}]\n  event_uuid: ${uuidOf(e.uri)}`
      );
      return ok(
        `${events.length} meeting(s):\n${lines.join('\n')}`,
        events.map((e) => ({ name: e.name, start_time: e.start_time, status: e.status, event_uuid: uuidOf(e.uri) }))
      );
    })
  );

  server.registerTool(
    'get_meeting',
    {
      title: 'Get meeting details',
      description: 'Returns full detail for one meeting, including who booked it and its reschedule and cancel links.',
      inputSchema: { event_uuid: z.string().describe('The exact event_uuid returned by list_meetings or book_meeting. Never invent this value or use a placeholder.') },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    withClient(async (client, { event_uuid }) => {
      const badUuid = checkEventUuid(event_uuid);
      if (badUuid) return fail(badUuid);

      const me = await client.me();
      const tz = me.timezone || 'UTC';
      const [event, invitees] = await Promise.all([
        client.getScheduledEvent(event_uuid),
        client.listEventInvitees(event_uuid).catch(() => [])
      ]);

      const who = invitees.map((i) => `${i.name} <${i.email}>`).join(', ') || 'no invitees listed';
      const links = invitees[0]
        ? `\nReschedule: ${invitees[0].reschedule_url}\nCancel: ${invitees[0].cancel_url}`
        : '';

      return ok(
        `${event.name} — ${speak(event.start_time, tz)} (${event.status})\nWith: ${who}${links}`,
        { name: event.name, start_time: event.start_time, status: event.status, invitees: invitees.map((i) => ({ name: i.name, email: i.email })) }
      );
    })
  );

  server.registerTool(
    'cancel_meeting',
    {
      title: 'Cancel a meeting',
      description:
        'Cancels a scheduled meeting and notifies the invitee. This cannot be undone — confirm with the caller before calling it.',
      inputSchema: {
        event_uuid: z.string().describe('The exact event_uuid returned by list_meetings. Never invent this value or use a placeholder.'),
        reason: z.string().optional().describe('Reason shown to the invitee in the cancellation email.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    },
    withClient(async (client, { event_uuid, reason }) => {
      const badUuid = checkEventUuid(event_uuid);
      if (badUuid) return fail(badUuid);

      await client.cancelEvent(event_uuid, reason);
      return ok(`Meeting cancelled. The invitee has been notified${reason ? ` with the reason: "${reason}"` : ''}.`);
    })
  );

  server.registerTool(
    'reschedule_meeting',
    {
      title: 'Reschedule a meeting',
      description:
        'Moves an existing meeting to a new time. First call list_meetings to get the event_uuid, then find_available_times to get a real slot. The new booking is made before the old one is released, so if anything fails the original meeting is left untouched.',
      inputSchema: {
        event_uuid: z.string().describe('The exact event_uuid returned by list_meetings. Never invent this value or use a placeholder.'),
        new_start_time: z.string().describe('Exact UTC start time from find_available_times.'),
        reason: z.string().optional().describe('Reason for the change.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    withClient(async (client, { event_uuid, new_start_time, reason }) => {
      const badUuid = checkEventUuid(event_uuid);
      if (badUuid) return fail(badUuid);

      const when = validateBookingTime(new_start_time);
      if (!when.ok) return fail(when.error);

      const me = await client.me();
      const tz = me.timezone || 'UTC';
      const event = await client.getScheduledEvent(event_uuid);
      const invitees = await client.listEventInvitees(event_uuid);
      const invitee = invitees[0];

      if (!invitee) {
        return fail('That meeting has no invitee on record, so it cannot be rebooked automatically. Cancel it and book a new meeting instead.');
      }

      if (event.status === 'canceled') {
        return fail('That meeting is already cancelled. Use book_meeting to create a new one instead of rescheduling.');
      }

      const eventType = await client.getEventType(event.event_type);

      if (new Date(event.start_time).getTime() === new Date(when.iso).getTime()) {
        return ok(`That meeting is already at ${speak(when.iso, tz)}. Nothing to change.`);
      }

      const { location } = buildLocation(eventType, {});
      const payload = {
        event_type: event.event_type,
        start_time: when.iso,
        invitee: { name: invitee.name, email: invitee.email, timezone: invitee.timezone || tz }
      };
      if (location) payload.location = location;

      // Book the replacement BEFORE releasing the original. If this fails the
      // caller still has their existing meeting; the reverse order can leave
      // them with nothing at all.
      let booked;
      try {
        booked = await client.createInvitee(payload);
      } catch (err) {
        const nearby = await client
          .availableTimes(
            eventType.uri,
            new Date(Math.max(Date.now() + 2 * 6e4, new Date(when.iso).getTime() - 6e4)).toISOString(),
            new Date(new Date(when.iso).getTime() + 2 * 36e5).toISOString()
          )
          .catch(() => []);

        return fail(
          `Could not book ${speak(when.iso, tz)}, so the existing meeting on ${speak(event.start_time, tz)} is untouched and still stands. Reason: ${err.message}` +
            (nearby.length
              ? ` Other openings: ${nearby.slice(0, 3).map((s) => `${speak(s.start_time, tz)} (start_time: ${s.start_time})`).join('; ')}.`
              : '')
        );
      }

      // The replacement exists. Releasing the old slot is now safe: the worst
      // case is a duplicate booking, which is recoverable, rather than none.
      try {
        await client.cancelEvent(event_uuid, reason || 'Rescheduled');
      } catch (err) {
        return ok(
          `Booked ${speak(when.iso, tz)} for ${invitee.name}, but the old meeting on ${speak(event.start_time, tz)} could not be cancelled (${err.message}). Both are currently on the calendar — call cancel_meeting with event_uuid ${event_uuid} to clear the old one.`,
          { event_uuid: uuidOf(booked.event), start_time: when.iso, stale_event_uuid: event_uuid }
        );
      }

      return ok(
        `Rescheduled. ${invitee.name} is now booked for ${speak(when.iso, tz)} and has been emailed the update.\n\nReschedule: ${booked.reschedule_url}\nCancel: ${booked.cancel_url}`,
        { event_uuid: uuidOf(booked.event), start_time: when.iso }
      );
    })
  );

  server.registerTool(
    'create_scheduling_link',
    {
      title: 'Create a one-time booking link',
      description:
        'Creates a single-use Calendly link the invitee can open to book themselves. Use this as a fallback when book_meeting is unavailable (free Calendly plans) or when the caller wants to choose a time later.',
      inputSchema: {
        event_type_name: z.string().optional().describe('Name of the meeting type. Omit if there is only one.'),
        event_type_uri: z.string().optional().describe('Exact event type URI, if already known.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    withClient(async (client, args) => {
      const eventType = await resolveEventType(client, args);
      const link = await client.createSingleUseLink(eventType.uri);
      return ok(
        `One-time booking link for "${eventType.name ?? 'this meeting type'}": ${link.booking_url}\nIt expires after one booking, or in 90 days if unused.`,
        { booking_url: link.booking_url }
      );
    })
  );
}
























// import { z } from 'zod';
// import { CalendlyClient, CalendlyError, uuidOf } from './calendly.js';
// import { resolveStart, validateBookingTime, speak, DAY } from './dates.js';

// const ok = (text, data) => ({
//   content: [{ type: 'text', text }],
//   structuredContent: data ? { data } : undefined
// });

// const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

// /** Match an event type by name when the agent doesn't have a URI. */
// async function resolveEventType(client, { event_type_uri, event_type_name }) {
//   if (event_type_uri) return { uri: event_type_uri };

//   const types = await client.listEventTypes();
//   if (!types.length) throw new Error('This Calendly account has no active event types.');

//   if (!event_type_name) {
//     if (types.length === 1) return types[0];
//     const names = types.map((t) => `"${t.name}" (${t.duration} min)`).join(', ');
//     throw new Error(`Multiple meeting types exist — specify which one. Options: ${names}`);
//   }

//   const needle = event_type_name.toLowerCase().trim();
//   const match =
//     types.find((t) => t.name.toLowerCase() === needle) ||
//     types.find((t) => t.name.toLowerCase().includes(needle)) ||
//     types.find((t) => needle.includes(t.name.toLowerCase()));

//   if (!match) {
//     const names = types.map((t) => `"${t.name}"`).join(', ');
//     throw new Error(`No meeting type matching "${event_type_name}". Available: ${names}`);
//   }
//   return match;
// }

// /**
//  * Registers every Calendly tool on an McpServer instance.
//  * `getToken` resolves the caller's Calendly token per request.
//  */
// /**
//  * Calendly rejects a booking when the event type has a location configured and
//  * the request omits it: "Specified location kind is not configured for this
//  * event type." Agents have no way to know this, so we read the event type's own
//  * location settings and fill it in automatically.
//  */
// const NEEDS_INVITEE_INPUT = new Set(['ask_invitee', 'outbound_call', 'invitee_specified']);

// function buildLocation(eventType, { location_kind, location_detail }) {
//   const configured = eventType.locations ?? [];

//   // An explicit override from the caller always wins.
//   if (location_kind) {
//     const loc = { kind: location_kind };
//     if (location_detail) loc.location = location_detail;
//     return { location: loc };
//   }

//   if (!configured.length) return { location: undefined };

//   if (configured.length > 1) {
//     const kinds = configured.map((l) => l.kind).join(', ');
//     return {
//       error: `"${eventType.name}" offers several meeting locations (${kinds}). Ask the caller which they prefer, then retry with location_kind set to one of those.`
//     };
//   }

//   const only = configured[0];
//   if (NEEDS_INVITEE_INPUT.has(only.kind) && !location_detail) {
//     const asking =
//       only.kind === 'outbound_call'
//         ? 'a phone number to call them on'
//         : 'where the meeting should take place (a phone number or an address)';
//     return {
//       error: `"${eventType.name}" requires ${asking}. Ask the caller for it, then retry with location_detail set.`
//     };
//   }

//   const loc = { kind: only.kind };
//   if (location_detail) loc.location = location_detail;
//   return { location: loc };
// }

// export function registerCalendlyTools(server, getToken) {
//   const withClient = (handler) => async (args) => {
//     try {
//       const client = new CalendlyClient(getToken());
//       return await handler(client, args ?? {});
//     } catch (err) {
//       if (err instanceof CalendlyError) return fail(`${err.message}\n\nWhat to do: ${err.hint}`);
//       return fail(err.message);
//     }
//   };

//   server.registerTool(
//     'whoami',
//     {
//       title: 'Get the connected Calendly account',
//       description:
//         'Returns the name, email, timezone and scheduling URL of the Calendly account this agent is acting for. Call this once if you need to know the host\'s timezone.',
//       inputSchema: {},
//       annotations: { readOnlyHint: true, openWorldHint: true }
//     },
//     withClient(async (client) => {
//       const me = await client.me();
//       return ok(
//         `Connected as ${me.name} (${me.email}). Host timezone: ${me.timezone}. Scheduling page: ${me.scheduling_url}`,
//         { name: me.name, email: me.email, timezone: me.timezone, scheduling_url: me.scheduling_url }
//       );
//     })
//   );

//   server.registerTool(
//     'list_event_types',
//     {
//       title: 'List bookable meeting types',
//       description:
//         'Lists the meeting types that can be booked (e.g. "30 Minute Meeting", "Discovery Call") with their duration and URI. Call this first when you do not know which meeting type the caller wants.',
//       inputSchema: {
//         include_inactive: z.boolean().optional().describe('Include event types that are turned off. Defaults to false.')
//       },
//       annotations: { readOnlyHint: true, openWorldHint: true }
//     },
//     withClient(async (client, { include_inactive }) => {
//       const types = await client.listEventTypes({ activeOnly: !include_inactive });
//       if (!types.length) return ok('This Calendly account has no active meeting types.', []);

//       const lines = types.map((t) => {
//         const locs = (t.locations ?? []).map((l) => l.kind).join(', ') || 'none configured';
//         return `• ${t.name} — ${t.duration} min${t.active ? '' : ' (inactive)'}\n  location: ${locs}\n  uri: ${t.uri}`;
//       });
//       return ok(
//         `${types.length} meeting type(s) available:\n${lines.join('\n')}`,
//         types.map((t) => ({ name: t.name, duration: t.duration, uri: t.uri, active: t.active, scheduling_url: t.scheduling_url }))
//       );
//     })
//   );

//   server.registerTool(
//     'find_available_times',
//     {
//       title: 'Find open meeting slots',
//       description:
//         'Finds open time slots for a meeting type. Always call this before booking — never guess a time. Accepts loose dates like "tomorrow", "monday" or "+3 days"; past dates are automatically moved to now, so this never fails on a stale date.',
//       inputSchema: {
//         event_type_name: z.string().optional().describe('Name of the meeting type, e.g. "Discovery Call". Omit if there is only one.'),
//         event_type_uri: z.string().optional().describe('Exact event type URI, if already known.'),
//         starting: z.string().optional().describe('When to start looking: "today", "tomorrow", "monday", "+3 days", or an ISO date. Defaults to now.'),
//         days: z.number().int().min(1).max(28).optional().describe('How many days ahead to search. Defaults to 7.'),
//         timezone: z.string().optional().describe('IANA timezone for displaying times, e.g. "Asia/Karachi". Defaults to the host timezone.'),
//         limit: z.number().int().min(1).max(40).optional().describe('Maximum slots to return. Defaults to 10.')
//       },
//       annotations: { readOnlyHint: true, openWorldHint: true }
//     },
//     withClient(async (client, args) => {
//       const me = await client.me();
//       const tz = args.timezone || me.timezone || 'UTC';
//       const eventType = await resolveEventType(client, args);

//       const start = resolveStart(args.starting, tz);
//       const end = new Date(start.getTime() + (args.days ?? 7) * DAY);

//       const slots = await client.availableTimes(eventType.uri, start.toISOString(), end.toISOString());
//       if (!slots.length) {
//         return ok(
//           `No open slots between ${speak(start.toISOString(), tz)} and ${speak(end.toISOString(), tz)}. Try a later window or a different meeting type.`,
//           []
//         );
//       }

//       const shown = slots.slice(0, args.limit ?? 10);
//       const lines = shown.map((s) => `• ${speak(s.start_time, tz)}\n  start_time: ${s.start_time}`);
//       return ok(
//         `${slots.length} open slot(s) for "${eventType.name ?? 'this meeting type'}" (times shown in ${tz}). Offer the caller two or three of these, then pass the exact start_time to book_meeting:\n${lines.join('\n')}`,
//         { event_type_uri: eventType.uri, timezone: tz, slots: shown.map((s) => s.start_time) }
//       );
//     })
//   );

//   server.registerTool(
//     'book_meeting',
//     {
//       title: 'Book a meeting',
//       description:
//         'Books a meeting on the connected Calendly account and sends the normal confirmation email and calendar invite. Requires a paid Calendly plan. The start_time must be a slot returned by find_available_times, copied exactly.',
//       inputSchema: {
//         start_time: z.string().describe('Exact UTC start time from find_available_times, e.g. "2026-08-20T14:30:00Z".'),
//         invitee_name: z.string().describe('Full name of the person being booked.'),
//         invitee_email: z.string().email().describe('Email address of the person being booked.'),
//         event_type_name: z.string().optional().describe('Name of the meeting type. Omit if there is only one.'),
//         event_type_uri: z.string().optional().describe('Exact event type URI, if already known.'),
//         invitee_timezone: z.string().optional().describe('IANA timezone of the invitee, e.g. "Asia/Karachi".'),
//         location_kind: z
//           .string()
//           .optional()
//           .describe('Meeting location kind if the event type requires one, e.g. "zoom_conference", "google_conference", "physical", "ask_invitee".'),
//         location_detail: z.string().optional().describe('Location value when the kind needs one, e.g. a phone number or address.'),
//         guests: z.array(z.string().email()).optional().describe('Additional email addresses to add to the invite.'),
//         notes: z.string().optional().describe('Answer to the event type\'s first question, e.g. what the meeting is about.')
//       },
//       annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
//     },
//     withClient(async (client, args) => {
//       const when = validateBookingTime(args.start_time);
//       if (!when.ok) return fail(when.error);

//       const me = await client.me();
//       const tz = args.invitee_timezone || me.timezone || 'UTC';
//       let eventType = await resolveEventType(client, args);

//       // Ensure we have the full resource — location config lives there.
//       if (!eventType.locations) eventType = await client.getEventType(eventType.uri);

//       const { location, error } = buildLocation(eventType, args);
//       if (error) return fail(error);

//       const payload = {
//         event_type: eventType.uri,
//         start_time: when.iso,
//         invitee: { name: args.invitee_name, email: args.invitee_email, timezone: tz }
//       };
//       if (location) payload.location = location;
//       if (args.guests?.length) payload.event_guests = args.guests;
//       if (args.notes) payload.questions_and_answers = [{ question: 'Notes', answer: args.notes, position: 1 }];

//       let invitee;
//       try {
//         invitee = await client.createInvitee(payload);
//       } catch (err) {
//         // Nothing was created, so it is safe to spend an extra call working out
//         // why — but only now, not on every successful booking.
//         // Calendly caps booking creation separately from the rest of the API.
//         // When that cap is hit, direct booking is unavailable for a while, but
//         // one-time scheduling links still work — so say that plainly.
//         if (err.status === 429) {
//           return fail(
//             `Calendly is not accepting direct bookings right now (rate limited on booking creation). Nothing was booked. ` +
//               `Use create_scheduling_link instead and send the caller the link so they can confirm ${speak(when.iso, tz)} themselves.`
//           );
//         }

//         if (err.status === 400) {
//           const nearby = await client
//             .availableTimes(
//               eventType.uri,
//               new Date(Math.max(Date.now() + 2 * 6e4, new Date(when.iso).getTime() - 6e4)).toISOString(),
//               new Date(new Date(when.iso).getTime() + 2 * 36e5).toISOString()
//             )
//             .catch(() => []);

//           const weekday = new Date(when.iso).toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
//           return fail(
//             `Calendly would not accept ${speak(when.iso, tz)}, so nothing was booked. ` +
//               (nearby.length
//                 ? `Open slots near it: ${nearby.slice(0, 3).map((s) => `${speak(s.start_time, tz)} (start_time: ${s.start_time})`).join('; ')}. Offer one of these.`
//                 : `Nothing is open within two hours of it — that date is a ${weekday}. Check the date is what the caller meant, then call find_available_times.`)
//           );
//         }
//         throw err;
//       }

//       return ok(
//         `Booked. ${args.invitee_name} is confirmed for ${speak(when.iso, tz)}. A confirmation email and calendar invite have been sent to ${args.invitee_email}.\n\nReschedule: ${invitee.reschedule_url}\nCancel: ${invitee.cancel_url}`,
//         {
//           event_uri: invitee.event,
//           event_uuid: uuidOf(invitee.event),
//           start_time: when.iso,
//           reschedule_url: invitee.reschedule_url,
//           cancel_url: invitee.cancel_url
//         }
//       );
//     })
//   );

//   server.registerTool(
//     'list_meetings',
//     {
//       title: 'List scheduled meetings',
//       description:
//         'Lists upcoming or past meetings on the connected calendar. Use this to find the meeting a caller wants to move or cancel — it returns the event_uuid the other tools need.',
//       inputSchema: {
//         invitee_email: z.string().email().optional().describe('Only meetings booked by this person.'),
//         status: z.enum(['active', 'canceled']).optional().describe('Defaults to active.'),
//         starting: z.string().optional().describe('Earliest start time to include: "today", "tomorrow", or an ISO date. Defaults to now.'),
//         days: z.number().int().min(1).max(365).optional().describe('How many days ahead to look. Defaults to 30.'),
//         limit: z.number().int().min(1).max(50).optional()
//       },
//       annotations: { readOnlyHint: true, openWorldHint: true }
//     },
//     withClient(async (client, args) => {
//       const me = await client.me();
//       const tz = me.timezone || 'UTC';
//       const start = resolveStart(args.starting, tz);
//       const end = new Date(start.getTime() + (args.days ?? 30) * DAY);

//       const events = await client.listScheduledEvents({
//         status: args.status ?? 'active',
//         inviteeEmail: args.invitee_email,
//         minStart: start.toISOString(),
//         maxStart: end.toISOString(),
//         count: args.limit ?? 25
//       });

//       if (!events.length) return ok('No meetings found in that window.', []);

//       const lines = events.map(
//         (e) => `• ${e.name} — ${speak(e.start_time, tz)} [${e.status}]\n  event_uuid: ${uuidOf(e.uri)}`
//       );
//       return ok(
//         `${events.length} meeting(s):\n${lines.join('\n')}`,
//         events.map((e) => ({ name: e.name, start_time: e.start_time, status: e.status, event_uuid: uuidOf(e.uri) }))
//       );
//     })
//   );

//   server.registerTool(
//     'get_meeting',
//     {
//       title: 'Get meeting details',
//       description: 'Returns full detail for one meeting, including who booked it and its reschedule and cancel links.',
//       inputSchema: { event_uuid: z.string().describe('The event_uuid from list_meetings or book_meeting.') },
//       annotations: { readOnlyHint: true, openWorldHint: true }
//     },
//     withClient(async (client, { event_uuid }) => {
//       const me = await client.me();
//       const tz = me.timezone || 'UTC';
//       const [event, invitees] = await Promise.all([
//         client.getScheduledEvent(event_uuid),
//         client.listEventInvitees(event_uuid).catch(() => [])
//       ]);

//       const who = invitees.map((i) => `${i.name} <${i.email}>`).join(', ') || 'no invitees listed';
//       const links = invitees[0]
//         ? `\nReschedule: ${invitees[0].reschedule_url}\nCancel: ${invitees[0].cancel_url}`
//         : '';

//       return ok(
//         `${event.name} — ${speak(event.start_time, tz)} (${event.status})\nWith: ${who}${links}`,
//         { name: event.name, start_time: event.start_time, status: event.status, invitees: invitees.map((i) => ({ name: i.name, email: i.email })) }
//       );
//     })
//   );

//   server.registerTool(
//     'cancel_meeting',
//     {
//       title: 'Cancel a meeting',
//       description:
//         'Cancels a scheduled meeting and notifies the invitee. This cannot be undone — confirm with the caller before calling it.',
//       inputSchema: {
//         event_uuid: z.string().describe('The event_uuid from list_meetings.'),
//         reason: z.string().optional().describe('Reason shown to the invitee in the cancellation email.')
//       },
//       annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
//     },
//     withClient(async (client, { event_uuid, reason }) => {
//       await client.cancelEvent(event_uuid, reason);
//       return ok(`Meeting cancelled. The invitee has been notified${reason ? ` with the reason: "${reason}"` : ''}.`);
//     })
//   );

//   server.registerTool(
//     'reschedule_meeting',
//     {
//       title: 'Reschedule a meeting',
//       description:
//         'Moves an existing meeting to a new time by cancelling the old one and booking the new one. Call find_available_times first and pass a slot it returned. If the rebooking step fails, the old meeting stays cancelled and this tool returns a reschedule link to fall back on.',
//       inputSchema: {
//         event_uuid: z.string().describe('The event_uuid of the meeting to move.'),
//         new_start_time: z.string().describe('Exact UTC start time from find_available_times.'),
//         reason: z.string().optional().describe('Reason for the change.')
//       },
//       annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
//     },
//     withClient(async (client, { event_uuid, new_start_time, reason }) => {
//       const when = validateBookingTime(new_start_time);
//       if (!when.ok) return fail(when.error);

//       const me = await client.me();
//       const tz = me.timezone || 'UTC';
//       const event = await client.getScheduledEvent(event_uuid);
//       const invitees = await client.listEventInvitees(event_uuid);
//       const invitee = invitees[0];

//       if (!invitee) {
//         return fail('That meeting has no invitee on record, so it cannot be rebooked automatically. Cancel it and book a new meeting instead.');
//       }

//       if (event.status === 'canceled') {
//         return fail('That meeting is already cancelled. Use book_meeting to create a new one instead of rescheduling.');
//       }

//       const eventType = await client.getEventType(event.event_type);

//       if (new Date(event.start_time).getTime() === new Date(when.iso).getTime()) {
//         return ok(`That meeting is already at ${speak(when.iso, tz)}. Nothing to change.`);
//       }

//       const { location } = buildLocation(eventType, {});
//       const payload = {
//         event_type: event.event_type,
//         start_time: when.iso,
//         invitee: { name: invitee.name, email: invitee.email, timezone: invitee.timezone || tz }
//       };
//       if (location) payload.location = location;

//       // Book the replacement BEFORE releasing the original. If this fails the
//       // caller still has their existing meeting; the reverse order can leave
//       // them with nothing at all.
//       let booked;
//       try {
//         booked = await client.createInvitee(payload);
//       } catch (err) {
//         const nearby = await client
//           .availableTimes(
//             eventType.uri,
//             new Date(Math.max(Date.now() + 2 * 6e4, new Date(when.iso).getTime() - 6e4)).toISOString(),
//             new Date(new Date(when.iso).getTime() + 2 * 36e5).toISOString()
//           )
//           .catch(() => []);

//         return fail(
//           `Could not book ${speak(when.iso, tz)}, so the existing meeting on ${speak(event.start_time, tz)} is untouched and still stands. Reason: ${err.message}` +
//             (nearby.length
//               ? ` Other openings: ${nearby.slice(0, 3).map((s) => `${speak(s.start_time, tz)} (start_time: ${s.start_time})`).join('; ')}.`
//               : '')
//         );
//       }

//       // The replacement exists. Releasing the old slot is now safe: the worst
//       // case is a duplicate booking, which is recoverable, rather than none.
//       try {
//         await client.cancelEvent(event_uuid, reason || 'Rescheduled');
//       } catch (err) {
//         return ok(
//           `Booked ${speak(when.iso, tz)} for ${invitee.name}, but the old meeting on ${speak(event.start_time, tz)} could not be cancelled (${err.message}). Both are currently on the calendar — call cancel_meeting with event_uuid ${event_uuid} to clear the old one.`,
//           { event_uuid: uuidOf(booked.event), start_time: when.iso, stale_event_uuid: event_uuid }
//         );
//       }

//       return ok(
//         `Rescheduled. ${invitee.name} is now booked for ${speak(when.iso, tz)} and has been emailed the update.\n\nReschedule: ${booked.reschedule_url}\nCancel: ${booked.cancel_url}`,
//         { event_uuid: uuidOf(booked.event), start_time: when.iso }
//       );
//     })
//   );

//   server.registerTool(
//     'create_scheduling_link',
//     {
//       title: 'Create a one-time booking link',
//       description:
//         'Creates a single-use Calendly link the invitee can open to book themselves. Use this as a fallback when book_meeting is unavailable (free Calendly plans) or when the caller wants to choose a time later.',
//       inputSchema: {
//         event_type_name: z.string().optional().describe('Name of the meeting type. Omit if there is only one.'),
//         event_type_uri: z.string().optional().describe('Exact event type URI, if already known.')
//       },
//       annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
//     },
//     withClient(async (client, args) => {
//       const eventType = await resolveEventType(client, args);
//       const link = await client.createSingleUseLink(eventType.uri);
//       return ok(
//         `One-time booking link for "${eventType.name ?? 'this meeting type'}": ${link.booking_url}\nIt expires after one booking, or in 90 days if unused.`,
//         { booking_url: link.booking_url }
//       );
//     })
//   );
// }



















































// // import { z } from 'zod';
// // import { CalendlyClient, CalendlyError, uuidOf } from './calendly.js';
// // import { resolveStart, validateBookingTime, speak, DAY } from './dates.js';

// // const ok = (text, data) => ({
// //   content: [{ type: 'text', text }],
// //   structuredContent: data ? { data } : undefined
// // });

// // const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

// // /** Match an event type by name when the agent doesn't have a URI. */
// // async function resolveEventType(client, { event_type_uri, event_type_name }) {
// //   if (event_type_uri) return { uri: event_type_uri };

// //   const types = await client.listEventTypes();
// //   if (!types.length) throw new Error('This Calendly account has no active event types.');

// //   if (!event_type_name) {
// //     if (types.length === 1) return types[0];
// //     const names = types.map((t) => `"${t.name}" (${t.duration} min)`).join(', ');
// //     throw new Error(`Multiple meeting types exist — specify which one. Options: ${names}`);
// //   }

// //   const needle = event_type_name.toLowerCase().trim();
// //   const match =
// //     types.find((t) => t.name.toLowerCase() === needle) ||
// //     types.find((t) => t.name.toLowerCase().includes(needle)) ||
// //     types.find((t) => needle.includes(t.name.toLowerCase()));

// //   if (!match) {
// //     const names = types.map((t) => `"${t.name}"`).join(', ');
// //     throw new Error(`No meeting type matching "${event_type_name}". Available: ${names}`);
// //   }
// //   return match;
// // }

// // /**
// //  * Registers every Calendly tool on an McpServer instance.
// //  * `getToken` resolves the caller's Calendly token per request.
// //  */
// // /**
// //  * Calendly rejects a booking when the event type has a location configured and
// //  * the request omits it: "Specified location kind is not configured for this
// //  * event type." Agents have no way to know this, so we read the event type's own
// //  * location settings and fill it in automatically.
// //  */
// // const NEEDS_INVITEE_INPUT = new Set(['ask_invitee', 'outbound_call', 'invitee_specified']);

// // function buildLocation(eventType, { location_kind, location_detail }) {
// //   const configured = eventType.locations ?? [];

// //   // An explicit override from the caller always wins.
// //   if (location_kind) {
// //     const loc = { kind: location_kind };
// //     if (location_detail) loc.location = location_detail;
// //     return { location: loc };
// //   }

// //   if (!configured.length) return { location: undefined };

// //   if (configured.length > 1) {
// //     const kinds = configured.map((l) => l.kind).join(', ');
// //     return {
// //       error: `"${eventType.name}" offers several meeting locations (${kinds}). Ask the caller which they prefer, then retry with location_kind set to one of those.`
// //     };
// //   }

// //   const only = configured[0];
// //   if (NEEDS_INVITEE_INPUT.has(only.kind) && !location_detail) {
// //     const asking =
// //       only.kind === 'outbound_call'
// //         ? 'a phone number to call them on'
// //         : 'where the meeting should take place (a phone number or an address)';
// //     return {
// //       error: `"${eventType.name}" requires ${asking}. Ask the caller for it, then retry with location_detail set.`
// //     };
// //   }

// //   const loc = { kind: only.kind };
// //   if (location_detail) loc.location = location_detail;
// //   return { location: loc };
// // }

// // export function registerCalendlyTools(server, getToken) {
// //   const withClient = (handler) => async (args) => {
// //     try {
// //       const client = new CalendlyClient(getToken());
// //       return await handler(client, args ?? {});
// //     } catch (err) {
// //       if (err instanceof CalendlyError) return fail(`${err.message}\n\nWhat to do: ${err.hint}`);
// //       return fail(err.message);
// //     }
// //   };

// //   server.registerTool(
// //     'whoami',
// //     {
// //       title: 'Get the connected Calendly account',
// //       description:
// //         'Returns the name, email, timezone and scheduling URL of the Calendly account this agent is acting for. Call this once if you need to know the host\'s timezone.',
// //       inputSchema: {},
// //       annotations: { readOnlyHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client) => {
// //       const me = await client.me();
// //       return ok(
// //         `Connected as ${me.name} (${me.email}). Host timezone: ${me.timezone}. Scheduling page: ${me.scheduling_url}`,
// //         { name: me.name, email: me.email, timezone: me.timezone, scheduling_url: me.scheduling_url }
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'list_event_types',
// //     {
// //       title: 'List bookable meeting types',
// //       description:
// //         'Lists the meeting types that can be booked (e.g. "30 Minute Meeting", "Discovery Call") with their duration and URI. Call this first when you do not know which meeting type the caller wants.',
// //       inputSchema: {
// //         include_inactive: z.boolean().optional().describe('Include event types that are turned off. Defaults to false.')
// //       },
// //       annotations: { readOnlyHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client, { include_inactive }) => {
// //       const types = await client.listEventTypes({ activeOnly: !include_inactive });
// //       if (!types.length) return ok('This Calendly account has no active meeting types.', []);

// //       const lines = types.map((t) => {
// //         const locs = (t.locations ?? []).map((l) => l.kind).join(', ') || 'none configured';
// //         return `• ${t.name} — ${t.duration} min${t.active ? '' : ' (inactive)'}\n  location: ${locs}\n  uri: ${t.uri}`;
// //       });
// //       return ok(
// //         `${types.length} meeting type(s) available:\n${lines.join('\n')}`,
// //         types.map((t) => ({ name: t.name, duration: t.duration, uri: t.uri, active: t.active, scheduling_url: t.scheduling_url }))
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'find_available_times',
// //     {
// //       title: 'Find open meeting slots',
// //       description:
// //         'Finds open time slots for a meeting type. Always call this before booking — never guess a time. Accepts loose dates like "tomorrow", "monday" or "+3 days"; past dates are automatically moved to now, so this never fails on a stale date.',
// //       inputSchema: {
// //         event_type_name: z.string().optional().describe('Name of the meeting type, e.g. "Discovery Call". Omit if there is only one.'),
// //         event_type_uri: z.string().optional().describe('Exact event type URI, if already known.'),
// //         starting: z.string().optional().describe('When to start looking: "today", "tomorrow", "monday", "+3 days", or an ISO date. Defaults to now.'),
// //         days: z.number().int().min(1).max(28).optional().describe('How many days ahead to search. Defaults to 7.'),
// //         timezone: z.string().optional().describe('IANA timezone for displaying times, e.g. "Asia/Karachi". Defaults to the host timezone.'),
// //         limit: z.number().int().min(1).max(40).optional().describe('Maximum slots to return. Defaults to 10.')
// //       },
// //       annotations: { readOnlyHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client, args) => {
// //       const me = await client.me();
// //       const tz = args.timezone || me.timezone || 'UTC';
// //       const eventType = await resolveEventType(client, args);

// //       const start = resolveStart(args.starting, tz);
// //       const end = new Date(start.getTime() + (args.days ?? 7) * DAY);

// //       const slots = await client.availableTimes(eventType.uri, start.toISOString(), end.toISOString());
// //       if (!slots.length) {
// //         return ok(
// //           `No open slots between ${speak(start.toISOString(), tz)} and ${speak(end.toISOString(), tz)}. Try a later window or a different meeting type.`,
// //           []
// //         );
// //       }

// //       const shown = slots.slice(0, args.limit ?? 10);
// //       const lines = shown.map((s) => `• ${speak(s.start_time, tz)}\n  start_time: ${s.start_time}`);
// //       return ok(
// //         `${slots.length} open slot(s) for "${eventType.name ?? 'this meeting type'}" (times shown in ${tz}). Offer the caller two or three of these, then pass the exact start_time to book_meeting:\n${lines.join('\n')}`,
// //         { event_type_uri: eventType.uri, timezone: tz, slots: shown.map((s) => s.start_time) }
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'book_meeting',
// //     {
// //       title: 'Book a meeting',
// //       description:
// //         'Books a meeting on the connected Calendly account and sends the normal confirmation email and calendar invite. Requires a paid Calendly plan. The start_time must be a slot returned by find_available_times, copied exactly.',
// //       inputSchema: {
// //         start_time: z.string().describe('Exact UTC start time from find_available_times, e.g. "2026-08-20T14:30:00Z".'),
// //         invitee_name: z.string().describe('Full name of the person being booked.'),
// //         invitee_email: z.string().email().describe('Email address of the person being booked.'),
// //         event_type_name: z.string().optional().describe('Name of the meeting type. Omit if there is only one.'),
// //         event_type_uri: z.string().optional().describe('Exact event type URI, if already known.'),
// //         invitee_timezone: z.string().optional().describe('IANA timezone of the invitee, e.g. "Asia/Karachi".'),
// //         location_kind: z
// //           .string()
// //           .optional()
// //           .describe('Meeting location kind if the event type requires one, e.g. "zoom_conference", "google_conference", "physical", "ask_invitee".'),
// //         location_detail: z.string().optional().describe('Location value when the kind needs one, e.g. a phone number or address.'),
// //         guests: z.array(z.string().email()).optional().describe('Additional email addresses to add to the invite.'),
// //         notes: z.string().optional().describe('Answer to the event type\'s first question, e.g. what the meeting is about.')
// //       },
// //       annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
// //     },
// //     withClient(async (client, args) => {
// //       const when = validateBookingTime(args.start_time);
// //       if (!when.ok) return fail(when.error);

// //       const me = await client.me();
// //       const tz = args.invitee_timezone || me.timezone || 'UTC';
// //       let eventType = await resolveEventType(client, args);

// //       // Ensure we have the full resource — location config lives there.
// //       if (!eventType.locations) eventType = await client.getEventType(eventType.uri);

// //       const { location, error } = buildLocation(eventType, args);
// //       if (error) return fail(error);

// //       const payload = {
// //         event_type: eventType.uri,
// //         start_time: when.iso,
// //         invitee: { name: args.invitee_name, email: args.invitee_email, timezone: tz }
// //       };
// //       if (location) payload.location = location;
// //       if (args.guests?.length) payload.event_guests = args.guests;
// //       if (args.notes) payload.questions_and_answers = [{ question: 'Notes', answer: args.notes, position: 1 }];

// //       let invitee;
// //       try {
// //         invitee = await client.createInvitee(payload);
// //       } catch (err) {
// //         // Nothing was created, so it is safe to spend an extra call working out
// //         // why — but only now, not on every successful booking.
// //         // Calendly caps booking creation separately from the rest of the API.
// //         // When that cap is hit, direct booking is unavailable for a while, but
// //         // one-time scheduling links still work — so say that plainly.
// //         if (err.status === 429) {
// //           return fail(
// //             `Calendly is not accepting direct bookings right now (rate limited on booking creation). Nothing was booked. ` +
// //               `Use create_scheduling_link instead and send the caller the link so they can confirm ${speak(when.iso, tz)} themselves.`
// //           );
// //         }

// //         if (err.status === 400) {
// //           const nearby = await client
// //             .availableTimes(
// //               eventType.uri,
// //               new Date(Math.max(Date.now() + 2 * 6e4, new Date(when.iso).getTime() - 6e4)).toISOString(),
// //               new Date(new Date(when.iso).getTime() + 2 * 36e5).toISOString()
// //             )
// //             .catch(() => []);

// //           const weekday = new Date(when.iso).toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
// //           return fail(
// //             `Calendly would not accept ${speak(when.iso, tz)}, so nothing was booked. ` +
// //               (nearby.length
// //                 ? `Open slots near it: ${nearby.slice(0, 3).map((s) => `${speak(s.start_time, tz)} (start_time: ${s.start_time})`).join('; ')}. Offer one of these.`
// //                 : `Nothing is open within two hours of it — that date is a ${weekday}. Check the date is what the caller meant, then call find_available_times.`)
// //           );
// //         }
// //         throw err;
// //       }

// //       return ok(
// //         `Booked. ${args.invitee_name} is confirmed for ${speak(when.iso, tz)}. A confirmation email and calendar invite have been sent to ${args.invitee_email}.\n\nReschedule: ${invitee.reschedule_url}\nCancel: ${invitee.cancel_url}`,
// //         {
// //           event_uri: invitee.event,
// //           event_uuid: uuidOf(invitee.event),
// //           start_time: when.iso,
// //           reschedule_url: invitee.reschedule_url,
// //           cancel_url: invitee.cancel_url
// //         }
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'list_meetings',
// //     {
// //       title: 'List scheduled meetings',
// //       description:
// //         'Lists upcoming or past meetings on the connected calendar. Use this to find the meeting a caller wants to move or cancel — it returns the event_uuid the other tools need.',
// //       inputSchema: {
// //         invitee_email: z.string().email().optional().describe('Only meetings booked by this person.'),
// //         status: z.enum(['active', 'canceled']).optional().describe('Defaults to active.'),
// //         starting: z.string().optional().describe('Earliest start time to include: "today", "tomorrow", or an ISO date. Defaults to now.'),
// //         days: z.number().int().min(1).max(365).optional().describe('How many days ahead to look. Defaults to 30.'),
// //         limit: z.number().int().min(1).max(50).optional()
// //       },
// //       annotations: { readOnlyHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client, args) => {
// //       const me = await client.me();
// //       const tz = me.timezone || 'UTC';
// //       const start = resolveStart(args.starting, tz);
// //       const end = new Date(start.getTime() + (args.days ?? 30) * DAY);

// //       const events = await client.listScheduledEvents({
// //         status: args.status ?? 'active',
// //         inviteeEmail: args.invitee_email,
// //         minStart: start.toISOString(),
// //         maxStart: end.toISOString(),
// //         count: args.limit ?? 25
// //       });

// //       if (!events.length) return ok('No meetings found in that window.', []);

// //       const lines = events.map(
// //         (e) => `• ${e.name} — ${speak(e.start_time, tz)} [${e.status}]\n  event_uuid: ${uuidOf(e.uri)}`
// //       );
// //       return ok(
// //         `${events.length} meeting(s):\n${lines.join('\n')}`,
// //         events.map((e) => ({ name: e.name, start_time: e.start_time, status: e.status, event_uuid: uuidOf(e.uri) }))
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'get_meeting',
// //     {
// //       title: 'Get meeting details',
// //       description: 'Returns full detail for one meeting, including who booked it and its reschedule and cancel links.',
// //       inputSchema: { event_uuid: z.string().describe('The event_uuid from list_meetings or book_meeting.') },
// //       annotations: { readOnlyHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client, { event_uuid }) => {
// //       const me = await client.me();
// //       const tz = me.timezone || 'UTC';
// //       const [event, invitees] = await Promise.all([
// //         client.getScheduledEvent(event_uuid),
// //         client.listEventInvitees(event_uuid).catch(() => [])
// //       ]);

// //       const who = invitees.map((i) => `${i.name} <${i.email}>`).join(', ') || 'no invitees listed';
// //       const links = invitees[0]
// //         ? `\nReschedule: ${invitees[0].reschedule_url}\nCancel: ${invitees[0].cancel_url}`
// //         : '';

// //       return ok(
// //         `${event.name} — ${speak(event.start_time, tz)} (${event.status})\nWith: ${who}${links}`,
// //         { name: event.name, start_time: event.start_time, status: event.status, invitees: invitees.map((i) => ({ name: i.name, email: i.email })) }
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'cancel_meeting',
// //     {
// //       title: 'Cancel a meeting',
// //       description:
// //         'Cancels a scheduled meeting and notifies the invitee. This cannot be undone — confirm with the caller before calling it.',
// //       inputSchema: {
// //         event_uuid: z.string().describe('The event_uuid from list_meetings.'),
// //         reason: z.string().optional().describe('Reason shown to the invitee in the cancellation email.')
// //       },
// //       annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client, { event_uuid, reason }) => {
// //       await client.cancelEvent(event_uuid, reason);
// //       return ok(`Meeting cancelled. The invitee has been notified${reason ? ` with the reason: "${reason}"` : ''}.`);
// //     })
// //   );

// //   server.registerTool(
// //     'reschedule_meeting',
// //     {
// //       title: 'Reschedule a meeting',
// //       description:
// //         'Moves an existing meeting to a new time by cancelling the old one and booking the new one. Call find_available_times first and pass a slot it returned. If the rebooking step fails, the old meeting stays cancelled and this tool returns a reschedule link to fall back on.',
// //       inputSchema: {
// //         event_uuid: z.string().describe('The event_uuid of the meeting to move.'),
// //         new_start_time: z.string().describe('Exact UTC start time from find_available_times.'),
// //         reason: z.string().optional().describe('Reason for the change.')
// //       },
// //       annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
// //     },
// //     withClient(async (client, { event_uuid, new_start_time, reason }) => {
// //       const when = validateBookingTime(new_start_time);
// //       if (!when.ok) return fail(when.error);

// //       const me = await client.me();
// //       const tz = me.timezone || 'UTC';
// //       const event = await client.getScheduledEvent(event_uuid);
// //       const invitees = await client.listEventInvitees(event_uuid);
// //       const invitee = invitees[0];

// //       if (!invitee) {
// //         return fail('That meeting has no invitee on record, so it cannot be rebooked automatically. Cancel it and book a new meeting instead.');
// //       }

// //       if (event.status === 'canceled') {
// //         return fail('That meeting is already cancelled. Use book_meeting to create a new one instead of rescheduling.');
// //       }

// //       const eventType = await client.getEventType(event.event_type);

// //       if (new Date(event.start_time).getTime() === new Date(when.iso).getTime()) {
// //         return ok(`That meeting is already at ${speak(when.iso, tz)}. Nothing to change.`);
// //       }

// //       const { location } = buildLocation(eventType, {});
// //       const payload = {
// //         event_type: event.event_type,
// //         start_time: when.iso,
// //         invitee: { name: invitee.name, email: invitee.email, timezone: invitee.timezone || tz }
// //       };
// //       if (location) payload.location = location;

// //       // Book the replacement BEFORE releasing the original. If this fails the
// //       // caller still has their existing meeting; the reverse order can leave
// //       // them with nothing at all.
// //       let booked;
// //       try {
// //         booked = await client.createInvitee(payload);
// //       } catch (err) {
// //         const nearby = await client
// //           .availableTimes(
// //             eventType.uri,
// //             new Date(Math.max(Date.now() + 2 * 6e4, new Date(when.iso).getTime() - 6e4)).toISOString(),
// //             new Date(new Date(when.iso).getTime() + 2 * 36e5).toISOString()
// //           )
// //           .catch(() => []);

// //         return fail(
// //           `Could not book ${speak(when.iso, tz)}, so the existing meeting on ${speak(event.start_time, tz)} is untouched and still stands. Reason: ${err.message}` +
// //             (nearby.length
// //               ? ` Other openings: ${nearby.slice(0, 3).map((s) => `${speak(s.start_time, tz)} (start_time: ${s.start_time})`).join('; ')}.`
// //               : '')
// //         );
// //       }

// //       // The replacement exists. Releasing the old slot is now safe: the worst
// //       // case is a duplicate booking, which is recoverable, rather than none.
// //       try {
// //         await client.cancelEvent(event_uuid, reason || 'Rescheduled');
// //       } catch (err) {
// //         return ok(
// //           `Booked ${speak(when.iso, tz)} for ${invitee.name}, but the old meeting on ${speak(event.start_time, tz)} could not be cancelled (${err.message}). Both are currently on the calendar — call cancel_meeting with event_uuid ${event_uuid} to clear the old one.`,
// //           { event_uuid: uuidOf(booked.event), start_time: when.iso, stale_event_uuid: event_uuid }
// //         );
// //       }

// //       return ok(
// //         `Rescheduled. ${invitee.name} is now booked for ${speak(when.iso, tz)} and has been emailed the update.\n\nReschedule: ${booked.reschedule_url}\nCancel: ${booked.cancel_url}`,
// //         { event_uuid: uuidOf(booked.event), start_time: when.iso }
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'create_scheduling_link',
// //     {
// //       title: 'Create a one-time booking link',
// //       description:
// //         'Creates a single-use Calendly link the invitee can open to book themselves. Use this as a fallback when book_meeting is unavailable (free Calendly plans) or when the caller wants to choose a time later.',
// //       inputSchema: {
// //         event_type_name: z.string().optional().describe('Name of the meeting type. Omit if there is only one.'),
// //         event_type_uri: z.string().optional().describe('Exact event type URI, if already known.')
// //       },
// //       annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
// //     },
// //     withClient(async (client, args) => {
// //       const eventType = await resolveEventType(client, args);
// //       const link = await client.createSingleUseLink(eventType.uri);
// //       return ok(
// //         `One-time booking link for "${eventType.name ?? 'this meeting type'}": ${link.booking_url}\nIt expires after one booking, or in 90 days if unused.`,
// //         { booking_url: link.booking_url }
// //       );
// //     })
// //   );
// // }











































// // import { z } from 'zod';
// // import { CalendlyClient, CalendlyError, uuidOf } from './calendly.js';
// // import { resolveStart, validateBookingTime, speak, DAY } from './dates.js';

// // const ok = (text, data) => ({
// //   content: [{ type: 'text', text }],
// //   structuredContent: data ? { data } : undefined
// // });

// // const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

// // /** Match an event type by name when the agent doesn't have a URI. */
// // async function resolveEventType(client, { event_type_uri, event_type_name }) {
// //   if (event_type_uri) return { uri: event_type_uri };

// //   const types = await client.listEventTypes();
// //   if (!types.length) throw new Error('This Calendly account has no active event types.');

// //   if (!event_type_name) {
// //     if (types.length === 1) return types[0];
// //     const names = types.map((t) => `"${t.name}" (${t.duration} min)`).join(', ');
// //     throw new Error(`Multiple meeting types exist — specify which one. Options: ${names}`);
// //   }

// //   const needle = event_type_name.toLowerCase().trim();
// //   const match =
// //     types.find((t) => t.name.toLowerCase() === needle) ||
// //     types.find((t) => t.name.toLowerCase().includes(needle)) ||
// //     types.find((t) => needle.includes(t.name.toLowerCase()));

// //   if (!match) {
// //     const names = types.map((t) => `"${t.name}"`).join(', ');
// //     throw new Error(`No meeting type matching "${event_type_name}". Available: ${names}`);
// //   }
// //   return match;
// // }

// // /**
// //  * Registers every Calendly tool on an McpServer instance.
// //  * `getToken` resolves the caller's Calendly token per request.
// //  */
// // /**
// //  * Calendly rejects a booking when the event type has a location configured and
// //  * the request omits it: "Specified location kind is not configured for this
// //  * event type." Agents have no way to know this, so we read the event type's own
// //  * location settings and fill it in automatically.
// //  */
// // const NEEDS_INVITEE_INPUT = new Set(['ask_invitee', 'outbound_call', 'invitee_specified']);

// // function buildLocation(eventType, { location_kind, location_detail }) {
// //   const configured = eventType.locations ?? [];

// //   // An explicit override from the caller always wins.
// //   if (location_kind) {
// //     const loc = { kind: location_kind };
// //     if (location_detail) loc.location = location_detail;
// //     return { location: loc };
// //   }

// //   if (!configured.length) return { location: undefined };

// //   if (configured.length > 1) {
// //     const kinds = configured.map((l) => l.kind).join(', ');
// //     return {
// //       error: `"${eventType.name}" offers several meeting locations (${kinds}). Ask the caller which they prefer, then retry with location_kind set to one of those.`
// //     };
// //   }

// //   const only = configured[0];
// //   if (NEEDS_INVITEE_INPUT.has(only.kind) && !location_detail) {
// //     const asking =
// //       only.kind === 'outbound_call'
// //         ? 'a phone number to call them on'
// //         : 'where the meeting should take place (a phone number or an address)';
// //     return {
// //       error: `"${eventType.name}" requires ${asking}. Ask the caller for it, then retry with location_detail set.`
// //     };
// //   }

// //   const loc = { kind: only.kind };
// //   if (location_detail) loc.location = location_detail;
// //   return { location: loc };
// // }

// // export function registerCalendlyTools(server, getToken) {
// //   const withClient = (handler) => async (args) => {
// //     try {
// //       const client = new CalendlyClient(getToken());
// //       return await handler(client, args ?? {});
// //     } catch (err) {
// //       if (err instanceof CalendlyError) return fail(`${err.message}\n\nWhat to do: ${err.hint}`);
// //       return fail(err.message);
// //     }
// //   };

// //   server.registerTool(
// //     'whoami',
// //     {
// //       title: 'Get the connected Calendly account',
// //       description:
// //         'Returns the name, email, timezone and scheduling URL of the Calendly account this agent is acting for. Call this once if you need to know the host\'s timezone.',
// //       inputSchema: {},
// //       annotations: { readOnlyHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client) => {
// //       const me = await client.me();
// //       return ok(
// //         `Connected as ${me.name} (${me.email}). Host timezone: ${me.timezone}. Scheduling page: ${me.scheduling_url}`,
// //         { name: me.name, email: me.email, timezone: me.timezone, scheduling_url: me.scheduling_url }
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'list_event_types',
// //     {
// //       title: 'List bookable meeting types',
// //       description:
// //         'Lists the meeting types that can be booked (e.g. "30 Minute Meeting", "Discovery Call") with their duration and URI. Call this first when you do not know which meeting type the caller wants.',
// //       inputSchema: {
// //         include_inactive: z.boolean().optional().describe('Include event types that are turned off. Defaults to false.')
// //       },
// //       annotations: { readOnlyHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client, { include_inactive }) => {
// //       const types = await client.listEventTypes({ activeOnly: !include_inactive });
// //       if (!types.length) return ok('This Calendly account has no active meeting types.', []);

// //       const lines = types.map((t) => {
// //         const locs = (t.locations ?? []).map((l) => l.kind).join(', ') || 'none configured';
// //         return `• ${t.name} — ${t.duration} min${t.active ? '' : ' (inactive)'}\n  location: ${locs}\n  uri: ${t.uri}`;
// //       });
// //       return ok(
// //         `${types.length} meeting type(s) available:\n${lines.join('\n')}`,
// //         types.map((t) => ({ name: t.name, duration: t.duration, uri: t.uri, active: t.active, scheduling_url: t.scheduling_url }))
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'find_available_times',
// //     {
// //       title: 'Find open meeting slots',
// //       description:
// //         'Finds open time slots for a meeting type. Always call this before booking — never guess a time. Accepts loose dates like "tomorrow", "monday" or "+3 days"; past dates are automatically moved to now, so this never fails on a stale date.',
// //       inputSchema: {
// //         event_type_name: z.string().optional().describe('Name of the meeting type, e.g. "Discovery Call". Omit if there is only one.'),
// //         event_type_uri: z.string().optional().describe('Exact event type URI, if already known.'),
// //         starting: z.string().optional().describe('When to start looking: "today", "tomorrow", "monday", "+3 days", or an ISO date. Defaults to now.'),
// //         days: z.number().int().min(1).max(28).optional().describe('How many days ahead to search. Defaults to 7.'),
// //         timezone: z.string().optional().describe('IANA timezone for displaying times, e.g. "Asia/Karachi". Defaults to the host timezone.'),
// //         limit: z.number().int().min(1).max(40).optional().describe('Maximum slots to return. Defaults to 10.')
// //       },
// //       annotations: { readOnlyHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client, args) => {
// //       const me = await client.me();
// //       const tz = args.timezone || me.timezone || 'UTC';
// //       const eventType = await resolveEventType(client, args);

// //       const start = resolveStart(args.starting, tz);
// //       const end = new Date(start.getTime() + (args.days ?? 7) * DAY);

// //       const slots = await client.availableTimes(eventType.uri, start.toISOString(), end.toISOString());
// //       if (!slots.length) {
// //         return ok(
// //           `No open slots between ${speak(start.toISOString(), tz)} and ${speak(end.toISOString(), tz)}. Try a later window or a different meeting type.`,
// //           []
// //         );
// //       }

// //       const shown = slots.slice(0, args.limit ?? 10);
// //       const lines = shown.map((s) => `• ${speak(s.start_time, tz)}\n  start_time: ${s.start_time}`);
// //       return ok(
// //         `${slots.length} open slot(s) for "${eventType.name ?? 'this meeting type'}" (times shown in ${tz}). Offer the caller two or three of these, then pass the exact start_time to book_meeting:\n${lines.join('\n')}`,
// //         { event_type_uri: eventType.uri, timezone: tz, slots: shown.map((s) => s.start_time) }
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'book_meeting',
// //     {
// //       title: 'Book a meeting',
// //       description:
// //         'Books a meeting on the connected Calendly account and sends the normal confirmation email and calendar invite. Requires a paid Calendly plan. The start_time must be a slot returned by find_available_times, copied exactly.',
// //       inputSchema: {
// //         start_time: z.string().describe('Exact UTC start time from find_available_times, e.g. "2026-08-20T14:30:00Z".'),
// //         invitee_name: z.string().describe('Full name of the person being booked.'),
// //         invitee_email: z.string().email().describe('Email address of the person being booked.'),
// //         event_type_name: z.string().optional().describe('Name of the meeting type. Omit if there is only one.'),
// //         event_type_uri: z.string().optional().describe('Exact event type URI, if already known.'),
// //         invitee_timezone: z.string().optional().describe('IANA timezone of the invitee, e.g. "Asia/Karachi".'),
// //         location_kind: z
// //           .string()
// //           .optional()
// //           .describe('Meeting location kind if the event type requires one, e.g. "zoom_conference", "google_conference", "physical", "ask_invitee".'),
// //         location_detail: z.string().optional().describe('Location value when the kind needs one, e.g. a phone number or address.'),
// //         guests: z.array(z.string().email()).optional().describe('Additional email addresses to add to the invite.'),
// //         notes: z.string().optional().describe('Answer to the event type\'s first question, e.g. what the meeting is about.')
// //       },
// //       annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
// //     },
// //     withClient(async (client, args) => {
// //       const when = validateBookingTime(args.start_time);
// //       if (!when.ok) return fail(when.error);

// //       const me = await client.me();
// //       const tz = args.invitee_timezone || me.timezone || 'UTC';
// //       let eventType = await resolveEventType(client, args);

// //       // Ensure we have the full resource — location config lives there.
// //       if (!eventType.locations) eventType = await client.getEventType(eventType.uri);

// //       const { location, error } = buildLocation(eventType, args);
// //       if (error) return fail(error);

// //       const payload = {
// //         event_type: eventType.uri,
// //         start_time: when.iso,
// //         invitee: { name: args.invitee_name, email: args.invitee_email, timezone: tz }
// //       };
// //       if (location) payload.location = location;
// //       if (args.guests?.length) payload.event_guests = args.guests;
// //       if (args.notes) payload.questions_and_answers = [{ question: 'Notes', answer: args.notes, position: 1 }];

// //       let invitee;
// //       try {
// //         invitee = await client.createInvitee(payload);
// //       } catch (err) {
// //         // Nothing was created, so it is safe to spend an extra call working out
// //         // why — but only now, not on every successful booking.
// //         if (err.status === 400) {
// //           const nearby = await client
// //             .availableTimes(
// //               eventType.uri,
// //               new Date(Math.max(Date.now() + 2 * 6e4, new Date(when.iso).getTime() - 6e4)).toISOString(),
// //               new Date(new Date(when.iso).getTime() + 2 * 36e5).toISOString()
// //             )
// //             .catch(() => []);

// //           const weekday = new Date(when.iso).toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
// //           return fail(
// //             `Calendly would not accept ${speak(when.iso, tz)}, so nothing was booked. ` +
// //               (nearby.length
// //                 ? `Open slots near it: ${nearby.slice(0, 3).map((s) => `${speak(s.start_time, tz)} (start_time: ${s.start_time})`).join('; ')}. Offer one of these.`
// //                 : `Nothing is open within two hours of it — that date is a ${weekday}. Check the date is what the caller meant, then call find_available_times.`)
// //           );
// //         }
// //         throw err;
// //       }

// //       return ok(
// //         `Booked. ${args.invitee_name} is confirmed for ${speak(when.iso, tz)}. A confirmation email and calendar invite have been sent to ${args.invitee_email}.\n\nReschedule: ${invitee.reschedule_url}\nCancel: ${invitee.cancel_url}`,
// //         {
// //           event_uri: invitee.event,
// //           event_uuid: uuidOf(invitee.event),
// //           start_time: when.iso,
// //           reschedule_url: invitee.reschedule_url,
// //           cancel_url: invitee.cancel_url
// //         }
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'list_meetings',
// //     {
// //       title: 'List scheduled meetings',
// //       description:
// //         'Lists upcoming or past meetings on the connected calendar. Use this to find the meeting a caller wants to move or cancel — it returns the event_uuid the other tools need.',
// //       inputSchema: {
// //         invitee_email: z.string().email().optional().describe('Only meetings booked by this person.'),
// //         status: z.enum(['active', 'canceled']).optional().describe('Defaults to active.'),
// //         starting: z.string().optional().describe('Earliest start time to include: "today", "tomorrow", or an ISO date. Defaults to now.'),
// //         days: z.number().int().min(1).max(365).optional().describe('How many days ahead to look. Defaults to 30.'),
// //         limit: z.number().int().min(1).max(50).optional()
// //       },
// //       annotations: { readOnlyHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client, args) => {
// //       const me = await client.me();
// //       const tz = me.timezone || 'UTC';
// //       const start = resolveStart(args.starting, tz);
// //       const end = new Date(start.getTime() + (args.days ?? 30) * DAY);

// //       const events = await client.listScheduledEvents({
// //         status: args.status ?? 'active',
// //         inviteeEmail: args.invitee_email,
// //         minStart: start.toISOString(),
// //         maxStart: end.toISOString(),
// //         count: args.limit ?? 25
// //       });

// //       if (!events.length) return ok('No meetings found in that window.', []);

// //       const lines = events.map(
// //         (e) => `• ${e.name} — ${speak(e.start_time, tz)} [${e.status}]\n  event_uuid: ${uuidOf(e.uri)}`
// //       );
// //       return ok(
// //         `${events.length} meeting(s):\n${lines.join('\n')}`,
// //         events.map((e) => ({ name: e.name, start_time: e.start_time, status: e.status, event_uuid: uuidOf(e.uri) }))
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'get_meeting',
// //     {
// //       title: 'Get meeting details',
// //       description: 'Returns full detail for one meeting, including who booked it and its reschedule and cancel links.',
// //       inputSchema: { event_uuid: z.string().describe('The event_uuid from list_meetings or book_meeting.') },
// //       annotations: { readOnlyHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client, { event_uuid }) => {
// //       const me = await client.me();
// //       const tz = me.timezone || 'UTC';
// //       const [event, invitees] = await Promise.all([
// //         client.getScheduledEvent(event_uuid),
// //         client.listEventInvitees(event_uuid).catch(() => [])
// //       ]);

// //       const who = invitees.map((i) => `${i.name} <${i.email}>`).join(', ') || 'no invitees listed';
// //       const links = invitees[0]
// //         ? `\nReschedule: ${invitees[0].reschedule_url}\nCancel: ${invitees[0].cancel_url}`
// //         : '';

// //       return ok(
// //         `${event.name} — ${speak(event.start_time, tz)} (${event.status})\nWith: ${who}${links}`,
// //         { name: event.name, start_time: event.start_time, status: event.status, invitees: invitees.map((i) => ({ name: i.name, email: i.email })) }
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'cancel_meeting',
// //     {
// //       title: 'Cancel a meeting',
// //       description:
// //         'Cancels a scheduled meeting and notifies the invitee. This cannot be undone — confirm with the caller before calling it.',
// //       inputSchema: {
// //         event_uuid: z.string().describe('The event_uuid from list_meetings.'),
// //         reason: z.string().optional().describe('Reason shown to the invitee in the cancellation email.')
// //       },
// //       annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
// //     },
// //     withClient(async (client, { event_uuid, reason }) => {
// //       await client.cancelEvent(event_uuid, reason);
// //       return ok(`Meeting cancelled. The invitee has been notified${reason ? ` with the reason: "${reason}"` : ''}.`);
// //     })
// //   );

// //   server.registerTool(
// //     'reschedule_meeting',
// //     {
// //       title: 'Reschedule a meeting',
// //       description:
// //         'Moves an existing meeting to a new time by cancelling the old one and booking the new one. Call find_available_times first and pass a slot it returned. If the rebooking step fails, the old meeting stays cancelled and this tool returns a reschedule link to fall back on.',
// //       inputSchema: {
// //         event_uuid: z.string().describe('The event_uuid of the meeting to move.'),
// //         new_start_time: z.string().describe('Exact UTC start time from find_available_times.'),
// //         reason: z.string().optional().describe('Reason for the change.')
// //       },
// //       annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
// //     },
// //     withClient(async (client, { event_uuid, new_start_time, reason }) => {
// //       const when = validateBookingTime(new_start_time);
// //       if (!when.ok) return fail(when.error);

// //       const me = await client.me();
// //       const tz = me.timezone || 'UTC';
// //       const event = await client.getScheduledEvent(event_uuid);
// //       const invitees = await client.listEventInvitees(event_uuid);
// //       const invitee = invitees[0];

// //       if (!invitee) {
// //         return fail('That meeting has no invitee on record, so it cannot be rebooked automatically. Cancel it and book a new meeting instead.');
// //       }

// //       if (event.status === 'canceled') {
// //         return fail('That meeting is already cancelled. Use book_meeting to create a new one instead of rescheduling.');
// //       }

// //       const eventType = await client.getEventType(event.event_type);

// //       if (new Date(event.start_time).getTime() === new Date(when.iso).getTime()) {
// //         return ok(`That meeting is already at ${speak(when.iso, tz)}. Nothing to change.`);
// //       }

// //       const { location } = buildLocation(eventType, {});
// //       const payload = {
// //         event_type: event.event_type,
// //         start_time: when.iso,
// //         invitee: { name: invitee.name, email: invitee.email, timezone: invitee.timezone || tz }
// //       };
// //       if (location) payload.location = location;

// //       // Book the replacement BEFORE releasing the original. If this fails the
// //       // caller still has their existing meeting; the reverse order can leave
// //       // them with nothing at all.
// //       let booked;
// //       try {
// //         booked = await client.createInvitee(payload);
// //       } catch (err) {
// //         const nearby = await client
// //           .availableTimes(
// //             eventType.uri,
// //             new Date(Math.max(Date.now() + 2 * 6e4, new Date(when.iso).getTime() - 6e4)).toISOString(),
// //             new Date(new Date(when.iso).getTime() + 2 * 36e5).toISOString()
// //           )
// //           .catch(() => []);

// //         return fail(
// //           `Could not book ${speak(when.iso, tz)}, so the existing meeting on ${speak(event.start_time, tz)} is untouched and still stands. Reason: ${err.message}` +
// //             (nearby.length
// //               ? ` Other openings: ${nearby.slice(0, 3).map((s) => `${speak(s.start_time, tz)} (start_time: ${s.start_time})`).join('; ')}.`
// //               : '')
// //         );
// //       }

// //       // The replacement exists. Releasing the old slot is now safe: the worst
// //       // case is a duplicate booking, which is recoverable, rather than none.
// //       try {
// //         await client.cancelEvent(event_uuid, reason || 'Rescheduled');
// //       } catch (err) {
// //         return ok(
// //           `Booked ${speak(when.iso, tz)} for ${invitee.name}, but the old meeting on ${speak(event.start_time, tz)} could not be cancelled (${err.message}). Both are currently on the calendar — call cancel_meeting with event_uuid ${event_uuid} to clear the old one.`,
// //           { event_uuid: uuidOf(booked.event), start_time: when.iso, stale_event_uuid: event_uuid }
// //         );
// //       }

// //       return ok(
// //         `Rescheduled. ${invitee.name} is now booked for ${speak(when.iso, tz)} and has been emailed the update.\n\nReschedule: ${booked.reschedule_url}\nCancel: ${booked.cancel_url}`,
// //         { event_uuid: uuidOf(booked.event), start_time: when.iso }
// //       );
// //     })
// //   );

// //   server.registerTool(
// //     'create_scheduling_link',
// //     {
// //       title: 'Create a one-time booking link',
// //       description:
// //         'Creates a single-use Calendly link the invitee can open to book themselves. Use this as a fallback when book_meeting is unavailable (free Calendly plans) or when the caller wants to choose a time later.',
// //       inputSchema: {
// //         event_type_name: z.string().optional().describe('Name of the meeting type. Omit if there is only one.'),
// //         event_type_uri: z.string().optional().describe('Exact event type URI, if already known.')
// //       },
// //       annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
// //     },
// //     withClient(async (client, args) => {
// //       const eventType = await resolveEventType(client, args);
// //       const link = await client.createSingleUseLink(eventType.uri);
// //       return ok(
// //         `One-time booking link for "${eventType.name ?? 'this meeting type'}": ${link.booking_url}\nIt expires after one booking, or in 90 days if unused.`,
// //         { booking_url: link.booking_url }
// //       );
// //     })
// //   );
// // }
