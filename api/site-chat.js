import { loadTenants } from '../src/tenants.js';
import { getPrompt, isKnownAgent, DEFAULT_AGENT } from '../src/prompts.js';

/**
 * Public chat endpoint for the Zenvya website.
 *
 * Differs from /api/chat (the private test console) in three ways:
 *   1. No secret is required from the browser. Access is gated by Origin.
 *   2. The OpenAI key and the MCP key are held server-side only.
 *   3. The system prompt lives here, not in the client, so visitors can't
 *      rewrite the agent's instructions.
 */

const tenants = loadTenants();
const MAX_ROUNDS = 6;
const MAX_MESSAGES = 24;

/** Comma-separated list, e.g. "https://zenvya.com,https://www.zenvya.com" */
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

/* Prompts live in src/prompts.js — one named prompt per agent. */

/** Very small in-memory throttle. Best-effort only; instances are not shared. */
const hits = new Map();
function throttled(ip) {
  const now = Date.now();
  const window = 60_000;
  const limit = 12;
  const record = hits.get(ip);

  if (!record || now - record.start > window) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  record.count += 1;
  return record.count > limit;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

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

function withCurrentTime(prompt, timezone) {
  const tz = timezone || 'UTC';
  const now = new Date();
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

  return `${prompt}\n\nCurrent time: ${local} (${tz}). In UTC: ${now.toISOString()}. The visitor is in ${tz} — speak in their timezone.`;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export default async function handler(req, res) {
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  const allowed = ALLOWED.length === 0 || ALLOWED.includes(origin);

  if (req.method === 'OPTIONS') {
    if (allowed) for (const [k, v] of Object.entries(corsHeaders(origin || '*'))) res.setHeader(k, v);
    return res.status(allowed ? 204 : 403).end();
  }

  if (!allowed) {
    return res.status(403).json({ error: 'This origin is not allowed to use this endpoint.' });
  }
  for (const [k, v] of Object.entries(corsHeaders(origin || '*'))) res.setHeader(k, v);

  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (throttled(ip)) {
    return res.status(429).json({ reply: "You're sending messages faster than I can keep up. Give me a moment." });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return res.status(400).json({ error: 'Could not read the request.' });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  const mcpKey = process.env.MCP_API_KEY;

  if (!openaiKey) return res.status(500).json({ error: 'The site chat is not configured yet.' });
  if (!mcpKey || !tenants.get(String(mcpKey).trim())) {
    return res.status(500).json({ error: 'The scheduling tools are not configured yet.' });
  }

  const selfOrigin = `https://${req.headers.host}`;
  const model = process.env.SITE_CHAT_MODEL || 'gpt-4o-mini';
  // The browser names an agent; the prompt itself never leaves the server.
  const agent = isKnownAgent(body.agent) ? String(body.agent).trim() : DEFAULT_AGENT;
  const prompt = getPrompt(agent);

  // Only user/assistant turns are accepted from the browser — a visitor cannot
  // inject system messages or forge tool results.
  const incoming = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (!incoming.length) return res.status(400).json({ error: 'No message was sent.' });

  try {
    const { tools } = await mcp(selfOrigin, mcpKey, 'tools/list');
    const openaiTools = toOpenAITools(tools);

    const messages = [
      { role: 'system', content: withCurrentTime(prompt, body.timezone) },
      ...incoming
    ];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const completion = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools: openaiTools, tool_choice: 'auto' })
      });

      const data = await completion.json();
      if (data.error) {
        console.error('[site-chat] openai:', data.error.message);
        return res.status(200).json({ reply: "I'm having trouble right now — please try again in a moment." });
      }

      const choice = data.choices?.[0]?.message;
      if (!choice) return res.status(200).json({ reply: 'Sorry, could you say that again?' });

      messages.push(choice);

      if (!choice.tool_calls?.length) {
        return res.status(200).json({ reply: choice.content ?? '' });
      }

      for (const call of choice.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          /* the tool will report what's missing */
        }

        let output;
        try {
          const result = await mcp(selfOrigin, mcpKey, 'tools/call', {
            name: call.function.name,
            arguments: args
          });
          output = textOf(result);
        } catch (err) {
          output = err.message;
        }

        // Tool detail stays server-side; the visitor only sees the reply.
        console.log(`[site-chat:${agent}] ${call.function.name}`, JSON.stringify(args).slice(0, 200));
        messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
    }

    return res.status(200).json({ reply: 'Let me hand this to the team — could you email us the details?' });
  } catch (err) {
    console.error('[site-chat] failed:', err);
    return res.status(200).json({ reply: "I'm having trouble reaching the calendar right now. Please try again shortly." });
  }
}




















// import { loadTenants } from '../src/tenants.js';

// /**
//  * Public chat endpoint for the Zenvya website.
//  *
//  * Differs from /api/chat (the private test console) in three ways:
//  *   1. No secret is required from the browser. Access is gated by Origin.
//  *   2. The OpenAI key and the MCP key are held server-side only.
//  *   3. The system prompt lives here, not in the client, so visitors can't
//  *      rewrite the agent's instructions.
//  */

// const tenants = loadTenants();
// const MAX_ROUNDS = 6;
// const MAX_MESSAGES = 24;

// /** Comma-separated list, e.g. "https://zenvya.com,https://www.zenvya.com" */
// const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
//   .split(',')
//   .map((o) => o.trim().replace(/\/$/, ''))
//   .filter(Boolean);

// const DEFAULT_PROMPT = `You are the assistant for Zenvya, which builds AI voice, WhatsApp and Instagram agents for appointment-driven businesses.

// Answer questions about what Zenvya does and book strategy calls.

// Scheduling rules:
// - Always call find_available_times before offering any time. Never guess.
// - Offer two or three options, never a long list.
// - Get the caller's name and email before booking.
// - Never say a booking is confirmed until the booking tool has returned success.
// - If direct booking fails, create a one-time scheduling link and send it. Never mention technical problems.

// Keep replies short and conversational — two or three sentences.`;

// /** Very small in-memory throttle. Best-effort only; instances are not shared. */
// const hits = new Map();
// function throttled(ip) {
//   const now = Date.now();
//   const window = 60_000;
//   const limit = 12;
//   const record = hits.get(ip);

//   if (!record || now - record.start > window) {
//     hits.set(ip, { start: now, count: 1 });
//     return false;
//   }
//   record.count += 1;
//   return record.count > limit;
// }

// function corsHeaders(origin) {
//   return {
//     'Access-Control-Allow-Origin': origin,
//     'Access-Control-Allow-Methods': 'POST, OPTIONS',
//     'Access-Control-Allow-Headers': 'Content-Type',
//     'Access-Control-Max-Age': '86400',
//     Vary: 'Origin'
//   };
// }

// async function mcp(origin, apiKey, method, params = {}) {
//   const res = await fetch(`${origin}/mcp`, {
//     method: 'POST',
//     headers: {
//       Authorization: `Bearer ${apiKey}`,
//       'Content-Type': 'application/json',
//       Accept: 'application/json, text/event-stream'
//     },
//     body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
//   });
//   const json = await res.json();
//   if (json.error) throw new Error(json.error.message);
//   return json.result;
// }

// const toOpenAITools = (tools) =>
//   tools.map((t) => ({
//     type: 'function',
//     function: {
//       name: t.name,
//       description: t.description,
//       parameters: t.inputSchema?.properties ? t.inputSchema : { type: 'object', properties: {} }
//     }
//   }));

// const textOf = (result) =>
//   (result?.content ?? [])
//     .filter((c) => c.type === 'text')
//     .map((c) => c.text)
//     .join('\n') || '(no output)';

// function withCurrentTime(prompt, timezone) {
//   const tz = timezone || 'UTC';
//   const now = new Date();
//   const local = new Intl.DateTimeFormat('en-US', {
//     timeZone: tz,
//     weekday: 'long',
//     year: 'numeric',
//     month: 'long',
//     day: 'numeric',
//     hour: 'numeric',
//     minute: '2-digit',
//     timeZoneName: 'short'
//   }).format(now);

//   return `${prompt}\n\nCurrent time: ${local} (${tz}). In UTC: ${now.toISOString()}. The visitor is in ${tz} — speak in their timezone.`;
// }

// async function readBody(req) {
//   if (req.body && typeof req.body === 'object') return req.body;
//   if (typeof req.body === 'string') return JSON.parse(req.body);
//   const chunks = [];
//   for await (const c of req) chunks.push(c);
//   return JSON.parse(Buffer.concat(chunks).toString('utf8'));
// }

// export default async function handler(req, res) {
//   const origin = (req.headers.origin || '').replace(/\/$/, '');
//   const allowed = ALLOWED.length === 0 || ALLOWED.includes(origin);

//   if (req.method === 'OPTIONS') {
//     if (allowed) for (const [k, v] of Object.entries(corsHeaders(origin || '*'))) res.setHeader(k, v);
//     return res.status(allowed ? 204 : 403).end();
//   }

//   if (!allowed) {
//     return res.status(403).json({ error: 'This origin is not allowed to use this endpoint.' });
//   }
//   for (const [k, v] of Object.entries(corsHeaders(origin || '*'))) res.setHeader(k, v);

//   if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

//   const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
//   if (throttled(ip)) {
//     return res.status(429).json({ reply: "You're sending messages faster than I can keep up. Give me a moment." });
//   }

//   let body;
//   try {
//     body = await readBody(req);
//   } catch {
//     return res.status(400).json({ error: 'Could not read the request.' });
//   }

//   const openaiKey = process.env.OPENAI_API_KEY;
//   const mcpKey = process.env.MCP_API_KEY;

//   if (!openaiKey) return res.status(500).json({ error: 'The site chat is not configured yet.' });
//   if (!mcpKey || !tenants.get(String(mcpKey).trim())) {
//     return res.status(500).json({ error: 'The scheduling tools are not configured yet.' });
//   }

//   const selfOrigin = `https://${req.headers.host}`;
//   const model = process.env.SITE_CHAT_MODEL || 'gpt-4o-mini';
//   const prompt = process.env.SITE_SYSTEM_PROMPT || DEFAULT_PROMPT;

//   // Only user/assistant turns are accepted from the browser — a visitor cannot
//   // inject system messages or forge tool results.
//   const incoming = (Array.isArray(body.messages) ? body.messages : [])
//     .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
//     .slice(-MAX_MESSAGES)
//     .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

//   if (!incoming.length) return res.status(400).json({ error: 'No message was sent.' });

//   try {
//     const { tools } = await mcp(selfOrigin, mcpKey, 'tools/list');
//     const openaiTools = toOpenAITools(tools);

//     const messages = [
//       { role: 'system', content: withCurrentTime(prompt, body.timezone) },
//       ...incoming
//     ];

//     for (let round = 0; round < MAX_ROUNDS; round++) {
//       const completion = await fetch('https://api.openai.com/v1/chat/completions', {
//         method: 'POST',
//         headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
//         body: JSON.stringify({ model, messages, tools: openaiTools, tool_choice: 'auto' })
//       });

//       const data = await completion.json();
//       if (data.error) {
//         console.error('[site-chat] openai:', data.error.message);
//         return res.status(200).json({ reply: "I'm having trouble right now — please try again in a moment." });
//       }

//       const choice = data.choices?.[0]?.message;
//       if (!choice) return res.status(200).json({ reply: 'Sorry, could you say that again?' });

//       messages.push(choice);

//       if (!choice.tool_calls?.length) {
//         return res.status(200).json({ reply: choice.content ?? '' });
//       }

//       for (const call of choice.tool_calls) {
//         let args = {};
//         try {
//           args = JSON.parse(call.function.arguments || '{}');
//         } catch {
//           /* the tool will report what's missing */
//         }

//         let output;
//         try {
//           const result = await mcp(selfOrigin, mcpKey, 'tools/call', {
//             name: call.function.name,
//             arguments: args
//           });
//           output = textOf(result);
//         } catch (err) {
//           output = err.message;
//         }

//         // Tool detail stays server-side; the visitor only sees the reply.
//         console.log(`[site-chat] ${call.function.name}`, JSON.stringify(args).slice(0, 200));
//         messages.push({ role: 'tool', tool_call_id: call.id, content: output });
//       }
//     }

//     return res.status(200).json({ reply: 'Let me hand this to the team — could you email us the details?' });
//   } catch (err) {
//     console.error('[site-chat] failed:', err);
//     return res.status(200).json({ reply: "I'm having trouble reaching the calendar right now. Please try again shortly." });
//   }
// }
