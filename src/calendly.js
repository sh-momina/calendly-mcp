/**
 * Thin Calendly API v2 client.
 * Docs: https://developer.calendly.com/api-docs
 */

const BASE = 'https://api.calendly.com';

export class CalendlyError extends Error {
  constructor(status, body, endpoint) {
    const detail =
      body?.message ||
      body?.title ||
      body?.details?.[0]?.message ||
      (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300));
    super(`Calendly ${status} on ${endpoint}: ${detail}`);
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }

  /** Turn API errors into something an LLM agent can actually recover from. */
  get hint() {
    switch (this.status) {
      case 400:
        if (/location/i.test(this.message)) {
          return 'The meeting location did not match what this event type allows. Call list_event_types to see the configured location, then pass location_kind (and location_detail if it needs a phone number or address).';
        }
        return 'The request was rejected. Check that start_time is a real open slot in the future and in UTC (ending in Z).';
      case 401:
        return 'The Calendly token is invalid or expired. The account owner needs to generate a new personal access token.';
      case 403:
        return 'This action is not permitted on the current Calendly plan. Booking via API (the Scheduling API) requires a paid Calendly plan.';
      case 404:
        return 'That event type or meeting no longer exists. Re-check availability and offer different times.';
      case 429:
        return 'Rate limited by Calendly. Wait a few seconds and try again.';
      default:
        return 'Calendly had a temporary problem. Retry once, then fall back to sending a scheduling link.';
    }
  }
}

export class CalendlyClient {
  constructor(token) {
    if (!token) throw new Error('CalendlyClient requires an access token');
    this.token = token;
    this._me = null;
  }

  async request(method, path, { query, body } = {}) {
    const url = new URL(path.startsWith('http') ? path : `${BASE}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
        else url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }

    if (!res.ok) throw new CalendlyError(res.status, parsed, `${method} ${url.pathname}`);
    return parsed;
  }

  /** Cached current user — needed for nearly every other call. */
  async me() {
    if (!this._me) {
      const { resource } = await this.request('GET', '/users/me');
      this._me = resource;
    }
    return this._me;
  }

  async listEventTypes({ activeOnly = true } = {}) {
    const me = await this.me();
    const { collection } = await this.request('GET', '/event_types', {
      query: { user: me.uri, count: 100, active: activeOnly ? 'true' : undefined }
    });
    return collection;
  }

  /** Full detail for one event type — includes its configured locations. */
  async getEventType(uri) {
    const { resource } = await this.request('GET', uri);
    return resource;
  }

  /**
   * Calendly caps each availability request to a short window and rejects any
   * window that starts in the past. We chunk into 7-day slices to stay inside
   * the limit regardless of which cap the account is on.
   */
  async availableTimes(eventTypeUri, startISO, endISO) {
    const slots = [];
    let cursor = new Date(startISO);
    const end = new Date(endISO);

    while (cursor < end) {
      const sliceEnd = new Date(Math.min(cursor.getTime() + 7 * 864e5 - 6e4, end.getTime()));
      const { collection } = await this.request('GET', '/event_type_available_times', {
        query: {
          event_type: eventTypeUri,
          start_time: cursor.toISOString(),
          end_time: sliceEnd.toISOString()
        }
      });
      slots.push(...collection.filter((s) => s.status === 'available'));
      cursor = new Date(sliceEnd.getTime() + 6e4);
    }
    return slots;
  }

  /** Scheduling API — the only way to create a booking without a browser. */
  async createInvitee(payload) {
    const { resource } = await this.request('POST', '/invitees', { body: payload });
    return resource;
  }

  async createSingleUseLink(eventTypeUri, maxEventCount = 1) {
    const { resource } = await this.request('POST', '/scheduling_links', {
      body: { max_event_count: maxEventCount, owner: eventTypeUri, owner_type: 'EventType' }
    });
    return resource;
  }

  async listScheduledEvents({ status, inviteeEmail, minStart, maxStart, count = 25 } = {}) {
    const me = await this.me();
    const { collection } = await this.request('GET', '/scheduled_events', {
      query: {
        user: me.uri,
        status,
        invitee_email: inviteeEmail,
        min_start_time: minStart,
        max_start_time: maxStart,
        sort: 'start_time:asc',
        count
      }
    });
    return collection;
  }

  async getScheduledEvent(uuid) {
    const { resource } = await this.request('GET', `/scheduled_events/${uuid}`);
    return resource;
  }

  async listEventInvitees(uuid) {
    const { collection } = await this.request('GET', `/scheduled_events/${uuid}/invitees`);
    return collection;
  }

  async cancelEvent(uuid, reason) {
    const { resource } = await this.request('POST', `/scheduled_events/${uuid}/cancellation`, {
      body: reason ? { reason } : {}
    });
    return resource;
  }
}

export const uuidOf = (uri = '') => uri.split('/').filter(Boolean).pop();
