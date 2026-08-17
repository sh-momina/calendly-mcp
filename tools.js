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

      const lines = types.map(
        (t) => `• ${t.name} — ${t.duration} min${t.active ? '' : ' (inactive)'}\n  uri: ${t.uri}`
      );
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
      const eventType = await resolveEventType(client, args);

      const payload = {
        event_type: eventType.uri,
        start_time: when.iso,
        invitee: { name: args.invitee_name, email: args.invitee_email, timezone: tz }
      };
      if (args.location_kind) {
        payload.location = { kind: args.location_kind };
        if (args.location_detail) payload.location.location = args.location_detail;
      }
      if (args.guests?.length) payload.event_guests = args.guests;
      if (args.notes) payload.questions_and_answers = [{ question: 'Notes', answer: args.notes, position: 1 }];

      const invitee = await client.createInvitee(payload);

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
      inputSchema: { event_uuid: z.string().describe('The event_uuid from list_meetings or book_meeting.') },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    withClient(async (client, { event_uuid }) => {
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
        event_uuid: z.string().describe('The event_uuid from list_meetings.'),
        reason: z.string().optional().describe('Reason shown to the invitee in the cancellation email.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    },
    withClient(async (client, { event_uuid, reason }) => {
      await client.cancelEvent(event_uuid, reason);
      return ok(`Meeting cancelled. The invitee has been notified${reason ? ` with the reason: "${reason}"` : ''}.`);
    })
  );

  server.registerTool(
    'reschedule_meeting',
    {
      title: 'Reschedule a meeting',
      description:
        'Moves an existing meeting to a new time by cancelling the old one and booking the new one. Call find_available_times first and pass a slot it returned. If the rebooking step fails, the old meeting stays cancelled and this tool returns a reschedule link to fall back on.',
      inputSchema: {
        event_uuid: z.string().describe('The event_uuid of the meeting to move.'),
        new_start_time: z.string().describe('Exact UTC start time from find_available_times.'),
        reason: z.string().optional().describe('Reason for the change.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    withClient(async (client, { event_uuid, new_start_time, reason }) => {
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

      // Prefer Calendly's own reschedule link when the invitee should drive it.
      await client.cancelEvent(event_uuid, reason || 'Rescheduled');

      try {
        const booked = await client.createInvitee({
          event_type: event.event_type,
          start_time: when.iso,
          invitee: { name: invitee.name, email: invitee.email, timezone: invitee.timezone || tz }
        });
        return ok(
          `Rescheduled. ${invitee.name} is now booked for ${speak(when.iso, tz)} and has been emailed the update.\n\nReschedule: ${booked.reschedule_url}\nCancel: ${booked.cancel_url}`,
          { event_uuid: uuidOf(booked.event), start_time: when.iso }
        );
      } catch (err) {
        return fail(
          `The original meeting was cancelled but the new time could not be booked (${err.message}). Send the invitee this link so they can pick a new time themselves: ${event.event_type ? '' : ''}${invitee.reschedule_url || 'use create_scheduling_link'}`
        );
      }
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
