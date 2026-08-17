import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerCalendlyTools } from './tools.js';
import { loadTenants } from './tenants.js';

const PORT = process.env.PORT || 3000;
const tenants = loadTenants();

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', tenants: tenants.size, transport: 'streamable-http' });
});

/**
 * Resolve the caller to a tenant.
 * Preferred:  Authorization: Bearer <api_key>
 * Also works: ?api_key=...  (some no-code clients can only pass query params)
 */
function authenticate(req) {
  const header = req.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  const key = bearer || req.query.api_key || req.query.user_id;

  if (!key) return { error: 'Missing credentials. Send "Authorization: Bearer <your api key>".' };

  const tenant = tenants.get(String(key));
  if (!tenant) return { error: 'Invalid API key.' };
  return { tenant };
}

/**
 * Stateless request handling: a fresh server and transport per request.
 * This is what makes the endpoint safe behind load balancers and compatible
 * with clients like n8n and ElevenLabs that do not persist MCP sessions.
 */
app.post('/mcp', async (req, res) => {
  const { tenant, error } = authenticate(req);
  if (error) {
    res.set('WWW-Authenticate', 'Bearer realm="mcp"');
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: error },
      id: req.body?.id ?? null
    });
  }

  const server = new McpServer(
    { name: 'calendly-mcp', version: '1.0.0' },
    {
      instructions:
        'Scheduling tools for a Calendly account. Never invent a meeting time: call find_available_times, offer the caller a couple of the slots it returns, then pass one of those start_time values to book_meeting exactly as given. Confirm with the caller before cancelling or rescheduling anything.'
    }
  );

  registerCalendlyTools(server, () => tenant.calendlyToken);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true // plain JSON replies; avoids SSE idle-timeout issues
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: req.body?.id ?? null
      });
    }
  }
});

// Stateless mode has no server-initiated stream and no session to delete.
const notAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

app.listen(PORT, () => {
  console.log(`calendly-mcp listening on :${PORT}`);
  console.log(`  endpoint  POST /mcp   (streamable http)`);
  console.log(`  tenants   ${tenants.size} configured`);
});
