# calendly-mcp

A remote MCP server that gives AI agents real control of a Calendly account — check availability, book, reschedule, cancel — plus a browser test console and a public chat endpoint for a website widget.

One deployment serves five things:

| URL | What it is | Who calls it |
|---|---|---|
| `POST /mcp` | The MCP server | ElevenLabs, n8n, Claude Desktop |
| `GET /` | Test console | You, in a browser |
| `POST /api/chat` | Test console backend | The console page |
| `POST /api/site-chat` | Public website chat | Your website's chat widget |
| `GET /health` | Status check | You, for debugging |

---

## Why this exists

Calendly hosts its own MCP server at `mcp.calendly.com`, but it only accepts OAuth 2.1 with Dynamic Client Registration and rejects personal access tokens. n8n and ElevenLabs both authenticate with a static bearer token, so they cannot connect to it.

This server bridges that gap: bearer token in, Calendly API calls out. It also fixes a set of problems that appear when a language model drives a calendar — wrong dates, missing meeting locations, invented event IDs, destructive reschedule ordering. Those fixes are the real value here; see **Why the code is shaped this way**.

---

## Quick reference — where everything lives

**This is the section to read when you want to change something.**

| What you want to change | Where it lives | Redeploy needed? |
|---|---|---|
| Your Calendly account | `CALENDLY_TOKEN` env var in Vercel | Yes |
| The password protecting your server | `MCP_API_KEY` env var in Vercel | Yes |
| The OpenAI key powering the website chat | `OPENAI_API_KEY` env var in Vercel | Yes |
| Which websites may use the chat | `ALLOWED_ORIGINS` env var in Vercel | Yes |
| Which OpenAI model the website chat uses | `SITE_CHAT_MODEL` env var (default `gpt-4o-mini`) | Yes |
| **The system prompts** | `src/prompts.js` | Auto on commit |
| What the tools do / adding a tool | `src/tools.js` | Auto on commit |
| How Calendly is called | `src/calendly.js` | Auto on commit |
| Date and timezone handling | `src/dates.js` | Auto on commit |
| The test console UI | `src/dashboard.js` | Auto on commit |
| Which API key maps to which Calendly account | `src/tenants.js` | Auto on commit |
| The website widget's appearance | `zenvya-chat-widget.html`, in your **website** repo | Website deploy |
| Which prompt the widget uses | `var AGENT` in the widget script | Website deploy |

**No secret is ever in the repo.** All keys live in Vercel environment variables.

---

## Environment variables

Set these in Vercel: project → **Environments** → **Production**. After adding or editing any of them you must **redeploy** — Vercel keeps serving the old build until you do.

### Required

| Name | What it is | Where to get it |
|---|---|---|
| `MCP_API_KEY` | A password you invent, around 40 random characters. Protects your server. This is what you paste into n8n and ElevenLabs. | `openssl rand -hex 16`, prefixed however you like |
| `CALENDLY_TOKEN` | Calendly personal access token | calendly.com/integrations/api_webhooks → Generate New Token |

### Required only for the website chat

| Name | What it is |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI secret key. **Must start with `sk-`.** A value starting `proj-` is a project ID, not a key, and will fail. |
| `ALLOWED_ORIGINS` | Comma-separated list of sites allowed to use `/api/site-chat`, e.g. `https://zenvya.com,https://www.zenvya.com`. No trailing slashes. An empty value allows every origin — set it before going live. |

### Optional

| Name | Default | Purpose |
|---|---|---|
| `SITE_CHAT_MODEL` | `gpt-4o-mini` | Model for the website chat |
| `TENANTS_JSON` | — | Multi-account mode, see below |
| `TENANTS_FILE` | — | Path to a JSON file, same shape as `TENANTS_JSON` |
| `PORT` | `3000` | Only used when running as a long-lived server |

---

## The tools

All nine are exposed to any connected MCP client.

| Tool | Type | What it does |
|---|---|---|
| `whoami` | read | The connected account's name, email, timezone |
| `list_event_types` | read | Bookable meeting types with duration, **location kind**, and URI |
| `find_available_times` | read | Open slots. Accepts `"tomorrow"`, `"monday"`, `"+3 days"`, or ISO dates |
| `book_meeting` | write | Creates a real booking and sends the normal confirmation email |
| `list_meetings` | read | Upcoming or past meetings; returns the `event_uuid` other tools need |
| `get_meeting` | read | Full detail for one meeting, plus its reschedule and cancel links |
| `cancel_meeting` | destructive | Cancels exactly one meeting and notifies the invitee |
| `reschedule_meeting` | destructive | Moves a meeting: books the new time first, then releases the old one |
| `create_scheduling_link` | write | One-time booking link — the fallback when direct booking is unavailable |

Read-only tools carry `readOnlyHint`; destructive ones carry `destructiveHint`, so clients offering per-tool approval can distinguish them.

---

## Setup from scratch

### 1. Deploy the server

1. Push this repo to GitHub (private is fine)
2. vercel.com → **Add New → Project** → import the repo
3. Before deploying, expand **Environment Variables** and add `MCP_API_KEY` and `CALENDLY_TOKEN`
4. Deploy
5. Open `https://your-app.vercel.app/health`

You should see:

```json
{"status":"ok","tenants":1,"transport":"streamable-http","runtime":"vercel",
 "keyLengths":[{"label":"default","keyLength":39}]}
```

`tenants: 1` means both variables loaded. `tenants: 0` means one is missing or misspelled. `keyLength` is the length of the stored key — compare it against your own to catch a stray space from pasting.

### 2. Connect a client

**n8n** — MCP Client Tool node:
- Endpoint: `https://your-app.vercel.app/mcp`
- Server Transport: **HTTP Streamable**
- Authentication: **Bearer Auth**, credential value = your `MCP_API_KEY` (the key only — do not type the word `Bearer`)
- Tools to Include: All

**ElevenLabs Agents** — Integrations → Add Custom MCP Server:
- Server URL: `https://your-app.vercel.app/mcp`
- Type: **Streamable HTTP** (not the default SSE)
- Header: `Authorization` = `Bearer <your MCP_API_KEY>`
- Tool Approval: `No Approval` for testing; in production use fine-grained and require approval on `cancel_meeting` and `reschedule_meeting`
- Paste the `zenvya-voice` prompt from `src/prompts.js` into the agent's system prompt field

**Claude Desktop / Claude Code** — any client supporting a remote server with a bearer header.

### 3. Wire up the website chat (optional)

1. Add `OPENAI_API_KEY` and `ALLOWED_ORIGINS` in Vercel, redeploy
2. Copy `zenvya-chat-widget.html` into your website's HTML
3. In it, set `CHAT_API` to `https://your-app.vercel.app/api/site-chat`
4. Set `AGENT` to a key from `PROMPTS` in `src/prompts.js`
5. Deploy the website

---

## The test console

Open `https://your-app.vercel.app` in a browser.

Paste your `MCP_API_KEY` into **Server API key** — the dot next to the endpoint turns green and the tool list fills. Then either:

- **Run one tool directly** — pick a tool, edit the JSON arguments, hit Run. No model involved. This is how you tell "the server is broken" apart from "the model is confused."
- **Chat** — add an OpenAI key and talk to the agent as a customer would. Every tool call appears in the trace on the right with its arguments, output and timing.

Keys are stored in your browser only. The console page is public but useless without your `MCP_API_KEY`, and `/api/chat` rejects requests that don't carry it.

---

## Prompts

Prompts live in `src/prompts.js`, one named prompt per agent:

```js
export const PROMPTS = {
  'zenvya-site':    `...`,   // website chat bubble
  'zenvya-voice':   `...`,   // ElevenLabs voice agent
  'zenvya-support': `...`    // example second agent
};
```

The browser sends only an agent **name**. The server looks it up and uses the matching text — so a visitor can never inject or read your prompt. An unknown name falls back to the default.

**To add an agent:** add a key to `PROMPTS`, then set `var AGENT = "your-key"` in that widget's script. Nothing else changes.

**One rule when editing prompts:** never write a real clock time into an example. Models copy literal times out of examples into live conversations and offer slots that do not exist. Use `[time]` placeholders — the existing examples show the pattern.

---

## Multiple Calendly accounts

By default one API key maps to one Calendly token. For several customers:

```
TENANTS_JSON=[
  {"api_key":"sk_alice_...","calendly_token":"eyJ...","label":"Alice"},
  {"api_key":"sk_bob_...","calendly_token":"eyJ...","label":"Bob"}
]
```

Each customer gets their own API key and only ever touches their own calendar. When you outgrow env vars, replace `loadTenants()` in `src/tenants.js` with a database lookup — it is the only place that knows how keys map to tokens.

---

## Why the code is shaped this way

Every item here is a bug that reached production during testing. Removing any of them brings the bug back.

**Location is filled in automatically.** Calendly rejects a booking when the event type has a location configured and the request omits it, with the misleading message "Specified location kind is not configured for this event type." The agent has no way to know your event type is set to Google Meet. `buildLocation()` in `src/tools.js` reads the event type's own settings and supplies it. If the location needs invitee input (a phone number), the tool asks for it instead of failing.

**Reschedule books before it cancels.** The obvious order — cancel the old meeting, then book the new one — loses the customer's slot entirely whenever the second step fails. It failed often, through rate limits and closed slots. Now the replacement is created first; the original is released only once the new booking exists. Worst case is a duplicate booking, which is recoverable. Zero bookings is not.

**Dates are clamped and validated.** Calendly rejects any availability window starting in the past: "Requested window is entirely in the past." Models routinely send stale dates. `src/dates.js` moves any past or unparseable date to now, resolves `"monday"` and `"tomorrow"` correctly per timezone, and rejects a time with no timezone marker — because a bare `2026-08-20T14:30:00` silently shifts by the server's offset.

**Event IDs are validated before use.** Models pass placeholder text like `your_event_uuid` instead of copying a real ID, which Calendly answers with a bare 404. `checkEventUuid()` rejects anything that isn't a real UUID and tells the model to call `list_meetings` and copy one.

**Failures never suggest substitutes.** When a booking is refused, the tool lists nearby openings but explicitly says *do not book a different time on your own*. Without that line, models silently book a time the customer never agreed to.

**Cancel says what it cancelled.** `cancel_meeting` names the single meeting it removed and states that others are untouched — otherwise a model handling someone with two bookings reads one success as "all done" and cancels both.

**Calls are cached and retried.** Calendly allows 60 requests per minute on Free, Standard and Teams plans. A chatty agent blows through that easily. The account and event-type list are cached across requests, and 429s are retried with backoff. A successful booking costs one Calendly call instead of four.

**The server is stateless.** A fresh MCP server per request, no session to lose. This matters because ElevenLabs drops idle connections after about 30 seconds — there is no long-lived stream here to drop.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/health` shows `tenants: 0` | `MCP_API_KEY` or `CALENDLY_TOKEN` missing or misspelled | Fix the variable, then **redeploy** |
| `Invalid API key` from a client | Key mismatch, or the word `Bearer` typed into a token-only field | Compare the length in the error against `keyLength` at `/health` |
| `Cannot GET /` | Root route not deployed | Confirm `src/dashboard.js` exists and `vercel.json` is current |
| `The site chat is not configured yet` | `OPENAI_API_KEY` not reaching the function | Add it, redeploy |
| `Incorrect API key provided: proj-...` | You pasted a project ID, not a key | Use a key starting `sk-` |
| `429 on POST /invitees` while GETs work | Calendly caps booking creation separately | Wait, and let the scheduling-link fallback handle it |
| Agent offers times that don't exist | A clock time was written into a prompt example | Replace with `[time]` placeholders |
| Changes don't take effect | Committed but not deployed | Compare the commit hash in Vercel's build log against GitHub |

**Reading logs:** Vercel → your project → **Logs**. Search for `[site-chat]` to see the website chat's tool calls and any OpenAI errors. A `405` on `/favicon.ico` is harmless.

---

## Known limitations

- **Direct booking needs a paid Calendly plan.** The Scheduling API (`POST /invitees`) is gated behind paid plans. On a free plan everything else works; `create_scheduling_link` lets the invitee book themselves.
- **Booking creation is rate limited separately** from the rest of the Calendly API, and more aggressively. The scheduling-link fallback exists for this.
- **There is no reschedule endpoint** in the Calendly API. Rescheduling is cancel plus rebook, done in the safe order.
- **The website chat throttle is best-effort.** It is in-memory, and serverless instances do not share state. For real traffic, move it to Vercel KV or similar.
- **No conversation persistence.** Each website chat lives in the browser tab only.

---

## Local development

```bash
npm install
cp .env.example .env      # fill in MCP_API_KEY and CALENDLY_TOKEN
npm start                 # http://localhost:3000
```

`src/server.js` runs the same tools as an Express server, serving the console at `/` and MCP at `/mcp`. The `api/` files are the Vercel serverless equivalents. Both import from `src/`, so a change to a tool applies to both.

Quick check without a browser:

```bash
curl -X POST localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## Adding a tool

`src/tools.js` is the only file that needs to change. Each tool is a `server.registerTool(name, config, handler)` call with a zod input schema:

```js
server.registerTool(
  'my_tool',
  {
    title: 'Short human title',
    description: 'What it does, and when the agent should call it.',
    inputSchema: {
      some_field: z.string().describe('What this is, and where the value comes from.')
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  withClient(async (client, args) => ok('Result text the agent will read.'))
);
```

Two things matter more than the code:

- **The description is a prompt.** The model decides whether to call your tool based on it. Say when to use it and what it needs.
- **Error messages are prompts too.** Return text telling the model what to do next — "call `list_meetings` and copy the `event_uuid`" — not just what went wrong. Most of this project's reliability comes from that.

For a different service, add a client alongside `src/calendly.js` and register its tools the same way. The transport, auth and tenant layers do not change.

---

## Security notes

- `MCP_API_KEY` is the only thing between the internet and your calendar. Use 32+ random characters and rotate it if it ever appears in a screenshot, a chat, or a commit.
- Prefer the `Authorization` header over query parameters — URLs end up in logs and browser history.
- The Calendly token never leaves the server. The website widget only sends an agent name.
- Set `ALLOWED_ORIGINS` before going live, or any site can spend your OpenAI credit.
- Never commit a `.env` file. `.gitignore` covers it; if one slipped in earlier, rotate everything in it.

---

## Project layout

```
api/
  index.js        MCP endpoint + /health + serves the console (Vercel)
  chat.js         Test console backend — needs your MCP key
  site-chat.js    Public website chat — origin-gated, keys server-side
src/
  calendly.js     Calendly API client: caching, retries, error hints
  dates.js        Date parsing, timezone handling, validation
  tools.js        The nine tools — the file you edit most
  prompts.js      System prompts, one per agent
  tenants.js      API key → Calendly token mapping
  dashboard.js    Test console HTML
  server.js       Express version, for local development
zenvya-chat-widget.html   Copy this into your website
vercel.json               Routing and function timeouts
Dockerfile                For hosts other than Vercel
```
