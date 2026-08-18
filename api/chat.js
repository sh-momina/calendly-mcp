import { loadTenants } from '../src/tenants.js';

/**
 * Test-console backend.
 *
 * Deliberately calls the public /mcp endpoint over HTTP rather than invoking the
 * tools in-process. That way the console exercises exactly the same path
 * ElevenLabs and n8n use — if it works here, it works there.
 */

const tenants = loadTenants();
const MAX_ROUNDS = 6;

async function mcp(origin, apiKey, method, params = {}) {
  const res = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });

  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

/** MCP tool definitions are already JSON Schema — hand them straight to OpenAI. */
const toOpenAITools = (tools) =>
  tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema?.properties ? t.inputSchema : { type: 'object', properties: {} }
    }
  }));

const textOf = (result) =>
  (result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n') || '(no output)';

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * ElevenLabs substitutes {{system__time_utc}} and friends into the system prompt
 * at call time. This console has to do the same, or the model reads the literal
 * placeholder text, has no idea what day it is, and picks wrong dates.
 */
function fillTimeVariables(prompt, timezone) {
  const now = new Date();
  const tz = timezone || 'UTC';

  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(now);

  const values = {
    system__time_utc: now.toISOString(),
    system__time: local,
    system__timezone: tz,
    system__date: new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now),
    system__caller_id: 'test-console',
    system__called_number: 'test-console',
    system__conversation_id: 'test-console'
  };

  let filled = prompt ?? '';
  let matched = false;
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g');
    if (pattern.test(filled)) matched = true;
    filled = filled.replace(pattern, value);
  }

  // Any remaining {{...}} would otherwise be read as literal text.
  filled = filled.replace(/\{\{\s*[\w.]+\s*\}\}/g, '(not set in test console)');

  // If the prompt never mentions the time, tell the model anyway — otherwise it
  // guesses at "next Wednesday" and books the wrong day.
  if (!matched) {
    filled += `\n\nCurrent time: ${local} (${tz}). In UTC: ${now.toISOString()}.`;
  }

  return filled;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return res.status(400).json({ error: 'Could not read the request.' });
  }

  const apiKey = String(body.apiKey ?? '').trim();
  if (!tenants.get(apiKey)) {
    return res.status(401).json({ error: 'That API key does not match the one set on this server.' });
  }

  const openaiKey = (body.openaiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!openaiKey) {
    return res.status(400).json({ error: 'Add an OpenAI API key to run the chat. Tools can still be tested individually.' });
  }

  const origin = `https://${req.headers.host}`;
  const model = body.model?.trim() || 'gpt-4o-mini';
  const trace = [];

  try {
    const { tools } = await mcp(origin, apiKey, 'tools/list');
    const openaiTools = toOpenAITools(tools);

    const messages = [
      {
        role: 'system',
        content: fillTimeVariables(body.systemPrompt || 'You are a helpful scheduling assistant.', body.timezone)
      },
      ...(body.messages ?? [])
    ];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const completion = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools: openaiTools, tool_choice: 'auto' })
      });

      const data = await completion.json();
      if (data.error) return res.status(400).json({ error: `OpenAI: ${data.error.message}`, trace });

      const choice = data.choices?.[0]?.message;
      if (!choice) return res.status(500).json({ error: 'No reply from the model.', trace });

      messages.push(choice);

      if (!choice.tool_calls?.length) {
        return res.status(200).json({ reply: choice.content ?? '', trace });
      }

      for (const call of choice.tool_calls) {
        const started = Date.now();
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          /* leave empty; the tool will report what's missing */
        }

        let output;
        let failed = false;
        try {
          const result = await mcp(origin, apiKey, 'tools/call', { name: call.function.name, arguments: args });
          output = textOf(result);
          failed = Boolean(result.isError);
        } catch (err) {
          output = err.message;
          failed = true;
        }

        trace.push({ tool: call.function.name, args, output, failed, ms: Date.now() - started });
        messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
    }

    return res.status(200).json({ reply: 'Stopped after too many tool rounds. Try a simpler request.', trace });
  } catch (err) {
    return res.status(500).json({ error: err.message, trace });
  }
}
