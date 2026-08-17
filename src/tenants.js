import fs from 'node:fs';

/**
 * Maps an API key -> the Calendly token it may act with.
 *
 * Single tenant (start here):
 *   MCP_API_KEY=sk_something_long
 *   CALENDLY_TOKEN=eyJ...
 *
 * Multiple customers (the SecondBrainOS model — each user brings their own key):
 *   TENANTS_JSON='[{"api_key":"sk_alice","calendly_token":"eyJ...","label":"Alice"}]'
 *   or TENANTS_FILE=/data/tenants.json
 *
 * Swap loadTenants() for a database lookup when you outgrow this.
 */
export function loadTenants() {
  const tenants = new Map();

  const add = (apiKey, calendlyToken, label) => {
    if (!apiKey || !calendlyToken) return;
    if (String(apiKey).length < 16) {
      console.warn(`[tenants] api key for "${label ?? 'default'}" is short — use at least 32 random characters.`);
    }
    tenants.set(String(apiKey), { calendlyToken: String(calendlyToken), label: label ?? 'default' });
  };

  add(process.env.MCP_API_KEY, process.env.CALENDLY_TOKEN, 'default');

  let raw = process.env.TENANTS_JSON;
  if (!raw && process.env.TENANTS_FILE && fs.existsSync(process.env.TENANTS_FILE)) {
    raw = fs.readFileSync(process.env.TENANTS_FILE, 'utf8');
  }

  if (raw) {
    try {
      for (const t of JSON.parse(raw)) add(t.api_key, t.calendly_token, t.label);
    } catch (err) {
      console.error('[tenants] could not parse tenant config:', err.message);
    }
  }

  if (!tenants.size) {
    console.error('[tenants] no tenants configured — every request will return 401.');
    console.error('          set MCP_API_KEY and CALENDLY_TOKEN, or TENANTS_JSON.');
  }

  return tenants;
}
