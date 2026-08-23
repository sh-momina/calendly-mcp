import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerCalendlyTools } from '../src/tools.js';
import { loadTenants } from '../src/tenants.js';
import { DASHBOARD_HTML } from '../src/dashboard.js';
import { registerSheetsTool } from '../src/sheets.js';

/**
 * Vercel serverless entrypoint.
 *
 * Deliberately avoids Express: Vercel's Node runtime may have already consumed
 * the request stream, which makes body-parser hang. We read the body defensively
 * and hand the parsed object straight to the MCP transport.
 */

const tenants = loadTenants();

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return undefined;
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function authenticate(req, url) {
  const header = req.headers.authorization || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : null;
  let key = bearer || url.searchParams.get('api_key') || url.searchParams.get('user_id');

  if (!key) return { error: 'Missing credentials. Send "Authorization: Bearer <your api key>".' };

  key = String(key).trim();
  // Some clients ask for the token only, others for the whole header value. If the
  // user pasted "Bearer sk_..." into a token-only field, strip the extra prefix.
  if (key.toLowerCase().startsWith('bearer ')) key = key.slice(7).trim();
  // Strip quotes someone may have wrapped around the value.
  key = key.replace(/^["']|["']$/g, '');

  const tenant = tenants.get(key);
  if (!tenant) {
    return {
      error: `Invalid API key. The server received a key of length ${key.length}. Compare that against the key length shown at /health — if they differ, one side has extra characters or whitespace.`
    };
  }
  return { tenant };
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);

  // Test console. Served from the function itself so it works regardless of
  // how static files are routed.
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send ? res.status(200).send(DASHBOARD_HTML) : res.end(DASHBOARD_HTML);
  }

  if (url.pathname === '/health' || url.pathname === '/api/health') {
    return res.status(200).json({
      status: 'ok',
      tenants: tenants.size,
      transport: 'streamable-http',
      runtime: 'vercel',
      // Length only — never the key itself. Lets you spot a stray space or a
      // half-pasted value without exposing the secret.
      keyLengths: [...tenants.values()].map((t) => ({ label: t.label, keyLength: t.keyLength }))
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST for MCP requests.' }, id: null });
  }

  const body = await readBody(req);
  const { tenant, error } = authenticate(req, url);

  if (error) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="mcp"');
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: error }, id: body?.id ?? null });
  }

  const server = new McpServer(
    { name: 'calendly-mcp', version: '1.0.0' },
    {
      instructions:
        'Scheduling tools for a Calendly account. Never invent a meeting time: call find_available_times, offer the caller a couple of the slots it returns, then pass one of those start_time values to book_meeting exactly as given. Confirm with the caller before cancelling or rescheduling anything.'
    }
  );

  registerCalendlyTools(server, () => tenant.calendlyToken);
  registerSheetsTool(server, () => tenant);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: body?.id ?? null });
    }
  } finally {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  }
}
