import fs from 'node:fs';

/**
 * Maps an API key -> everything that tenant's requests should use:
 * their Calendly token, their Google Sheet, optional Slack notifications,
 * and (optionally) their own Google service account credentials.
 *
 * TENANTS_JSON example:
 *
 * [
 *   {
 *     "api_key": "sk_me_...",
 *     "calendly_token": "eyJ...",
 *     "label": "me",
 *     "sheet_id": "1AbC...xyz",
 *     "slack_webhook_url": "https://hooks.slack.com/services/T000/B000/xxxx"
 *   },
 *   {
 *     "api_key": "sk_clientA_...",
 *     "calendly_token": "eyJ...",
 *     "label": "Client A",
 *     "sheet_id": "1DeF...uvw"
 *     // no slack_webhook_url -> Slack step is simply skipped for this tenant
 *     // no google_service_account -> falls back to GOOGLE_SERVICE_ACCOUNT_JSON
 *   }
 * ]
 *
 * Swap loadTenants() for a database lookup when you outgrow this.
 */
export function loadTenants() {
  const tenants = new Map();

  const add = (apiKey, calendlyToken, label, sheetId, googleServiceAccount, slackWebhookUrl) => {
    if (!apiKey || !calendlyToken) return;
    const key = String(apiKey).trim();
    const token = String(calendlyToken).trim();
    if (key.length < 16) {
      console.warn(`[tenants] api key for "${label ?? 'default'}" is short — use at least 32 random characters.`);
    }
    tenants.set(key, {
      calendlyToken: token,
      label: label ?? 'default',
      keyLength: key.length,
      sheetId: sheetId ? String(sheetId).trim() : undefined,
      googleServiceAccount: googleServiceAccount || undefined,
      slackWebhookUrl: slackWebhookUrl ? String(slackWebhookUrl).trim() : undefined
    });
  };

  add(
    process.env.MCP_API_KEY,
    process.env.CALENDLY_TOKEN,
    'default',
    process.env.DEFAULT_SHEET_ID,
    undefined,
    process.env.DEFAULT_SLACK_WEBHOOK_URL
  );

  let raw = process.env.TENANTS_JSON;
  if (!raw && process.env.TENANTS_FILE && fs.existsSync(process.env.TENANTS_FILE)) {
    raw = fs.readFileSync(process.env.TENANTS_FILE, 'utf8');
  }

  if (raw) {
    try {
      for (const t of JSON.parse(raw)) {
        add(
          t.api_key,
          t.calendly_token,
          t.label,
          t.sheet_id,
          t.google_service_account,
          t.slack_webhook_url
        );
      }
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
