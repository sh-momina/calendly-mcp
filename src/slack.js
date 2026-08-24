import { z } from 'zod';

const STATUS_EMOJI = {
  'Meeting Booked': '✅',
  'Meeting Rescheduled': '🔄',
  'Meeting Cancelled': '❌'
};

const ok = (text, data) => ({
  content: [{ type: 'text', text }],
  structuredContent: data ? { data } : undefined
});

const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * Registers notify_slack on an McpServer instance, matching the same
 * registerTool/Zod/ok-fail pattern used in tools.js and sheets.js.
 * `getTenant` returns the current tenant object (needs slackWebhookUrl).
 */
export function registerSlackTool(server, getTenant) {
  server.registerTool(
    'notify_slack',
    {
      title: 'Send a Slack notification for a meeting update',
      description:
        'Posts a Slack message with the contact\'s details whenever a meeting is booked, rescheduled, or cancelled. Call this right after the corresponding Calendly action succeeds — independently of any sheet logging.',
      inputSchema: {
        name: z.string().describe('Full name of the contact.'),
        phone: z.string().optional().describe('Use "N/A" if not provided.'),
        email: z.string().email().describe('Email address of the contact.'),
        status: z
          .enum(['Meeting Booked', 'Meeting Rescheduled', 'Meeting Cancelled'])
          .describe('The current status of the meeting.'),
        time: z.string().describe('ISO 8601 timestamp of the meeting.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ name, phone, email, status, time }) => {
      try {
        const tenant = getTenant();
        if (!tenant.slackWebhookUrl) {
          return fail('No Slack webhook is configured for this account.');
        }

        const emoji = STATUS_EMOJI[status] || '📅';
        const text =
          `${emoji} *${status}*\n` +
          `*Name:* ${name}\n` +
          `*Email:* ${email}\n` +
          `*Phone:* ${phone || 'N/A'}\n` +
          `*Time:* ${time}`;

        const res = await fetch(tenant.slackWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });

        if (!res.ok) {
          const body = await res.text();
          return fail(`Slack webhook error (${res.status}): ${body}`);
        }

        return ok(`Slack notified for ${name} — ${status}.`);
      } catch (err) {
        return fail(err.message);
      }
    }
  );
}
