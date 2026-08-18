/**
 * Date handling for LLM-driven scheduling.
 *
 * Voice and chat agents routinely emit stale or vague dates ("next Tuesday",
 * a date from their training data, yesterday). Calendly rejects any availability
 * window that starts in the past, which surfaces as:
 *   "Requested window is entirely in the past"
 *
 * Everything here exists to make that error unreachable.
 */

const DAY = 864e5;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Smallest start time Calendly will accept, with a safety margin. */
export const earliestValidStart = () => new Date(Date.now() + 2 * 6e4);

/**
 * Resolve a loose date expression into a concrete UTC instant.
 * Accepts: undefined, "now", "today", "tomorrow", "next week",
 * "monday".."sunday", "+3 days", or any ISO 8601 string.
 * Always returns a time at or after now.
 */
export function resolveStart(input, timezone = 'UTC') {
  const floor = earliestValidStart();
  if (!input) return floor;

  const raw = String(input).trim().toLowerCase();

  if (raw === 'now' || raw === 'today') return floor;
  if (raw === 'tomorrow') return startOfLocalDay(new Date(Date.now() + DAY), timezone, floor);
  if (raw === 'next week') return startOfLocalDay(new Date(Date.now() + 7 * DAY), timezone, floor);

  const relative = raw.match(/^\+?\s*(\d+)\s*(day|days|week|weeks)$/);
  if (relative) {
    const n = Number(relative[1]) * (relative[2].startsWith('week') ? 7 : 1);
    return startOfLocalDay(new Date(Date.now() + n * DAY), timezone, floor);
  }

  const weekdayIndex = WEEKDAYS.indexOf(raw.replace(/^next\s+/, ''));
  if (weekdayIndex !== -1) {
    const now = new Date();
    let delta = (weekdayIndex - now.getUTCDay() + 7) % 7;
    if (delta === 0 || raw.startsWith('next')) delta = delta === 0 ? 7 : delta;
    return startOfLocalDay(new Date(now.getTime() + delta * DAY), timezone, floor);
  }

  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return floor;

  // The critical clamp: a date in the past becomes "now" instead of an error.
  return parsed < floor ? floor : parsed;
}

/** Offset in ms between the given timezone and UTC at a specific instant. */
function tzOffset(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
    .formatToParts(date)
    .reduce((acc, p) => (p.type !== 'literal' ? { ...acc, [p.type]: Number(p.value) } : acc), {});

  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asUTC - date.getTime();
}

/** Midnight of the given day in the target timezone, never earlier than `floor`. */
function startOfLocalDay(date, timezone, floor) {
  try {
    const offset = tzOffset(date, timezone);
    const local = new Date(date.getTime() + offset);
    const midnightGuess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset;
    // Second pass catches DST transitions between the guess and the real instant.
    const corrected = new Date(midnightGuess);
    const result = new Date(midnightGuess - (tzOffset(corrected, timezone) - offset));
    return result < floor ? floor : result;
  } catch {
    return date < floor ? floor : date;
  }
}

/** Validate a booking time: must parse, and must be in the future. */
export function validateBookingTime(input) {
  if (input === undefined || input === null || input === '') {
    return { ok: false, error: 'No time was given. Call find_available_times and pass one of its start_time values exactly.' };
  }

  const raw = String(input).trim();
  const when = new Date(raw);

  if (Number.isNaN(when.getTime())) {
    return {
      ok: false,
      error: `"${raw}" is not a valid date. Use the exact start_time string from find_available_times, e.g. 2026-08-20T14:30:00Z.`
    };
  }

  // A bare local time ("2026-08-20T14:30:00") is ambiguous and silently shifts
  // the booking by the server's offset. Insist on an explicit zone.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    return {
      ok: false,
      error: `"${raw}" has no timezone. Add Z for UTC, or copy the start_time from find_available_times unchanged.`
    };
  }

  if (when <= new Date()) {
    return {
      ok: false,
      error: `${when.toISOString()} is in the past (now is ${new Date().toISOString()}). Call find_available_times and book one of the slots it returns verbatim.`
    };
  }

  return { ok: true, iso: when.toISOString() };
}

/** Human-readable time in the invitee's timezone — what the agent should say aloud. */
export function speak(iso, timezone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}

export { DAY };























// /**
//  * Date handling for LLM-driven scheduling.
//  *
//  * Voice and chat agents routinely emit stale or vague dates ("next Tuesday",
//  * a date from their training data, yesterday). Calendly rejects any availability
//  * window that starts in the past, which surfaces as:
//  *   "Requested window is entirely in the past"
//  *
//  * Everything here exists to make that error unreachable.
//  */

// const DAY = 864e5;
// const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// /** Smallest start time Calendly will accept, with a safety margin. */
// export const earliestValidStart = () => new Date(Date.now() + 2 * 6e4);

// /**
//  * Resolve a loose date expression into a concrete UTC instant.
//  * Accepts: undefined, "now", "today", "tomorrow", "next week",
//  * "monday".."sunday", "+3 days", or any ISO 8601 string.
//  * Always returns a time at or after now.
//  */
// export function resolveStart(input, timezone = 'UTC') {
//   const floor = earliestValidStart();
//   if (!input) return floor;

//   const raw = String(input).trim().toLowerCase();

//   if (raw === 'now' || raw === 'today') return floor;
//   if (raw === 'tomorrow') return startOfLocalDay(new Date(Date.now() + DAY), timezone, floor);
//   if (raw === 'next week') return startOfLocalDay(new Date(Date.now() + 7 * DAY), timezone, floor);

//   const relative = raw.match(/^\+?\s*(\d+)\s*(day|days|week|weeks)$/);
//   if (relative) {
//     const n = Number(relative[1]) * (relative[2].startsWith('week') ? 7 : 1);
//     return startOfLocalDay(new Date(Date.now() + n * DAY), timezone, floor);
//   }

//   const weekdayIndex = WEEKDAYS.indexOf(raw.replace(/^next\s+/, ''));
//   if (weekdayIndex !== -1) {
//     const now = new Date();
//     let delta = (weekdayIndex - now.getUTCDay() + 7) % 7;
//     if (delta === 0 || raw.startsWith('next')) delta = delta === 0 ? 7 : delta;
//     return startOfLocalDay(new Date(now.getTime() + delta * DAY), timezone, floor);
//   }

//   const parsed = new Date(input);
//   if (Number.isNaN(parsed.getTime())) return floor;

//   // The critical clamp: a date in the past becomes "now" instead of an error.
//   return parsed < floor ? floor : parsed;
// }

// /** Offset in ms between the given timezone and UTC at a specific instant. */
// function tzOffset(date, timezone) {
//   const parts = new Intl.DateTimeFormat('en-US', {
//     timeZone: timezone,
//     hour12: false,
//     year: 'numeric',
//     month: '2-digit',
//     day: '2-digit',
//     hour: '2-digit',
//     minute: '2-digit',
//     second: '2-digit'
//   })
//     .formatToParts(date)
//     .reduce((acc, p) => (p.type !== 'literal' ? { ...acc, [p.type]: Number(p.value) } : acc), {});

//   const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
//   return asUTC - date.getTime();
// }

// /** Midnight of the given day in the target timezone, never earlier than `floor`. */
// function startOfLocalDay(date, timezone, floor) {
//   try {
//     const offset = tzOffset(date, timezone);
//     const local = new Date(date.getTime() + offset);
//     const midnightGuess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset;
//     // Second pass catches DST transitions between the guess and the real instant.
//     const corrected = new Date(midnightGuess);
//     const result = new Date(midnightGuess - (tzOffset(corrected, timezone) - offset));
//     return result < floor ? floor : result;
//   } catch {
//     return date < floor ? floor : date;
//   }
// }

// /** Validate a booking time: must parse, and must be in the future. */
// export function validateBookingTime(input) {
//   if (input === undefined || input === null || input === '') {
//     return { ok: false, error: 'No time was given. Call find_available_times and pass one of its start_time values exactly.' };
//   }

//   const raw = String(input).trim();
//   const when = new Date(raw);

//   if (Number.isNaN(when.getTime())) {
//     return {
//       ok: false,
//       error: `"${raw}" is not a valid date. Use the exact start_time string from find_available_times, e.g. 2026-08-20T14:30:00Z.`
//     };
//   }

//   // A bare local time ("2026-08-20T14:30:00") is ambiguous and silently shifts
//   // the booking by the server's offset. Insist on an explicit zone.
//   if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
//     return {
//       ok: false,
//       error: `"${raw}" has no timezone. Add Z for UTC, or copy the start_time from find_available_times unchanged.`
//     };
//   }

//   if (when <= new Date()) {
//     return {
//       ok: false,
//       error: `${when.toISOString()} is in the past (now is ${new Date().toISOString()}). Call find_available_times and book one of the slots it returns verbatim.`
//     };
//   }

//   return { ok: true, iso: when.toISOString() };
// }

// /** Human-readable time in the invitee's timezone — what the agent should say aloud. */
// export function speak(iso, timezone = 'UTC') {
//   try {
//     return new Intl.DateTimeFormat('en-US', {
//       timeZone: timezone,
//       weekday: 'short',
//       month: 'short',
//       day: 'numeric',
//       hour: 'numeric',
//       minute: '2-digit',
//       timeZoneName: 'short'
//     }).format(new Date(iso));
//   } catch {
//     return new Date(iso).toISOString();
//   }
// }

// export { DAY };
