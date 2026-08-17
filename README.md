# calendly-mcp

A remote MCP server that gives an AI agent real control of a Calendly account — check availability, book, reschedule, cancel.

Speaks **streamable HTTP** with **bearer auth**, which is exactly what n8n's MCP Client Tool node and ElevenLabs Agents expect. Point either at `https://your-host/mcp` and every tool below appears automatically.

## Why not just use Calendly's own MCP server?

Calendly hosts one at `mcp.calendly.com`, but it only accepts OAuth 2.1 with Dynamic Client Registration and explicitly rejects personal access tokens. n8n and ElevenLabs both authenticate with a static bearer token, so they can't connect to it. This server bridges that gap: bearer token in, Calendly API calls out.

## Tools

| Tool | What it does |
|---|---|
| `whoami` | Returns the connected account and its timezone |
| `list_event_types` | Lists bookable meeting types with durations |
| `find_available_times` | Finds open slots — accepts `"tomorrow"`, `"monday"`, `"+3 days"`, or ISO |
| `book_meeting` | Creates a real booking; sends the normal invite and confirmation email |
| `list_meetings` | Lists upcoming or past meetings, filterable by invitee email |
| `get_meeting` | Full detail for one meeting including reschedule/cancel links |
| `cancel_meeting` | Cancels and notifies the invitee |
| `reschedule_meeting` | Cancels and rebooks at a new time in one call |
| `create_scheduling_link` | One-time booking link — fallback for free Calendly plans |

Read-only tools are annotated `readOnlyHint`, destructive ones `destructiveHint`, so clients that surface approval prompts can distinguish them.

## Requirements

- Node 20+
- A Calendly **personal access token** — https://calendly.com/integrations/api_webhooks
- A **paid Calendly plan** for `book_meeting` and `reschedule_meeting`. Calendly gates its Scheduling API behind paid plans. On a free plan everything else still works; use `create_scheduling_link` to let the invitee book themselves.

## Run locally

```bash
npm install
cp .env.example .env      # fill in MCP_API_KEY and CALENDLY_TOKEN
npm start
```

Generate a key with `openssl rand -hex 32`. Verify:

```bash
curl localhost:3000/health

curl -X POST localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Deploy

The Dockerfile works as-is on Railway, Render, Fly.io, or any container host. Set `MCP_API_KEY` and `CALENDLY_TOKEN` as environment variables. Railway:

```bash
railway init && railway up
railway variables set MCP_API_KEY=... CALENDLY_TOKEN=...
```

Your endpoint is then `https://<your-app>.up.railway.app/mcp`.

## Connect it

**n8n** — MCP Client Tool node:
- Endpoint: `https://your-host/mcp`
- Server Transport: `HTTP Streamable`
- Authentication: `Bearer Auth`, credential value = your `MCP_API_KEY`
- Tools to Include: `All`

**ElevenLabs Agents** — Integrations → Add Custom MCP Server:
- Server URL: `https://your-host/mcp`
- Type: **Streamable HTTP** (not the default SSE)
- Header: `Authorization` = `Bearer <your MCP_API_KEY>`
- Tool Approval Mode: `No Approval` for a live demo, or fine-grained to require approval on `cancel_meeting` and `reschedule_meeting`

**Claude Desktop / Claude Code** — any client that supports remote servers with a bearer header.

## Multiple customers

Each customer gets their own API key mapped to their own Calendly token:

```bash
TENANTS_JSON='[
  {"api_key":"sk_alice_...","calendly_token":"eyJ...","label":"Alice"},
  {"api_key":"sk_bob_...","calendly_token":"eyJ...","label":"Bob"}
]'
```

Or point `TENANTS_FILE` at a JSON file. When you outgrow this, replace `loadTenants()` in `src/tenants.js` with a database lookup — it's the only place that knows how keys map to tokens.

## Notes on agent behaviour

Voice agents get dates wrong constantly — they'll ask for availability in a window that has already passed, which Calendly rejects with *"Requested window is entirely in the past."* `src/dates.js` makes that error unreachable: any past or unparseable date silently becomes "now", and `book_meeting` refuses a past time with an instruction telling the model to re-check availability first.

Availability requests are chunked into 7-day slices so a 3-week search still works within Calendly's per-request window cap.

The server runs **stateless** — a fresh MCP server per request, no session to lose. That matters because ElevenLabs drops idle connections after about 30 seconds; there's no long-lived stream here to drop.

## Adding more tools

`src/tools.js` is the only file you touch. Each tool is a `server.registerTool(name, config, handler)` call with a zod input schema. Add a Gmail or CRM client alongside `src/calendly.js` and register its tools the same way — the transport, auth, and tenant layers don't change.

## Security

- The API key is the only thing standing between the internet and the Calendly account. Use 32+ random characters and rotate it if it's ever pasted into a screenshot or a chat.
- Prefer the `Authorization` header over a query param — URLs end up in logs and browser history.
- Put it behind HTTPS. Every host listed above terminates TLS for you.
