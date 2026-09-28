import { z } from 'zod';

/**
 * Transactional email templates. Text and HTML are generated from typed payloads; every
 * interpolated value is HTML-escaped. Copy is original HyFib W360 wording.
 */
export const emailPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('auth.verify_email'), name: z.string().max(200), url: z.url() }),
  z.object({ kind: z.literal('auth.reset_password'), name: z.string().max(200), url: z.url() }),
  z.object({ kind: z.literal('auth.password_changed'), name: z.string().max(200) }),
  z.object({
    kind: z.literal('tenant.invitation'),
    companyName: z.string().max(120),
    inviterName: z.string().max(200),
    roles: z.array(z.string()).max(7),
    url: z.url(),
    expiresAt: z.string(),
  }),
  z.object({
    kind: z.literal('crm.task_reminder'),
    companyName: z.string().max(120),
    name: z.string().max(200),
    taskTitle: z.string().max(200),
    /** When the task is due, already formatted in the company's time zone. */
    due: z.string().max(80).nullable(),
    url: z.url(),
  }),
  z.object({
    kind: z.literal('billing.notice'),
    companyName: z.string().max(120),
    subject: z.string().max(200),
    lines: z.array(z.string().max(500)).max(10),
    url: z.url().optional(),
  }),
  z.object({
    kind: z.literal('tenant.notice'),
    companyName: z.string().max(120),
    subject: z.string().max(200),
    lines: z.array(z.string().max(600)).max(12),
    url: z.url().optional(),
    actionLabel: z.string().max(60).optional(),
  }),
  z.object({
    kind: z.literal('webhook.endpoint_disabled'),
    companyName: z.string().max(120),
    /** The endpoint's host only, never its full URL. */
    host: z.string().max(253),
    url: z.url(),
  }),
]);

export type EmailPayload = z.infer<typeof emailPayloadSchema>;

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(
  title: string,
  paragraphs: string[],
  action?: { label: string; url: string },
): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join('');
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#0f766e;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a></p>
       <p style="margin:0 0 16px;font-size:12px;color:#57534e">If the button does not work, copy this link into your browser:<br>${escapeHtml(action.url)}</p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1c1917;background:#fafaf9;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px;padding:32px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${body}${button}
<p style="margin:32px 0 0;font-size:12px;color:#78716c">HyFib W360 · You are receiving this because of an action on your account.</p>
</div></body></html>`;
}

export function renderEmail(payload: EmailPayload): RenderedEmail {
  switch (payload.kind) {
    case 'auth.verify_email': {
      const lines = [
        `Hi ${payload.name},`,
        'Confirm your email address to finish setting up your HyFib W360 account. The link expires in 24 hours.',
      ];
      return {
        subject: 'Confirm your email address',
        text: `${lines.join('\n\n')}\n\n${payload.url}\n\nIf you did not create an account, you can ignore this email.`,
        html: layout(
          'Confirm your email address',
          [...lines, 'If you did not create an account, you can ignore this email.'],
          {
            label: 'Confirm email',
            url: payload.url,
          },
        ),
      };
    }
    case 'auth.reset_password': {
      const lines = [
        `Hi ${payload.name},`,
        'We received a request to reset your password. The link expires in 1 hour and can be used once.',
      ];
      return {
        subject: 'Reset your password',
        text: `${lines.join('\n\n')}\n\n${payload.url}\n\nIf you did not request this, you can ignore this email; your password stays the same.`,
        html: layout(
          'Reset your password',
          [
            ...lines,
            'If you did not request this, you can ignore this email; your password stays the same.',
          ],
          {
            label: 'Choose a new password',
            url: payload.url,
          },
        ),
      };
    }
    case 'auth.password_changed': {
      const lines = [
        `Hi ${payload.name},`,
        'Your password was just changed and your other sessions were signed out.',
        'If this was not you, reset your password immediately and contact your administrator.',
      ];
      return {
        subject: 'Your password was changed',
        text: lines.join('\n\n'),
        html: layout('Your password was changed', lines),
      };
    }
    case 'tenant.invitation': {
      const roleText = payload.roles.join(', ');
      const lines = [
        `${payload.inviterName} invited you to join ${payload.companyName} on HyFib W360 as: ${roleText}.`,
        `This invitation expires on ${payload.expiresAt}. Sign in (or create an account) with this email address to accept it.`,
      ];
      return {
        subject: `You're invited to ${payload.companyName} on HyFib W360`,
        text: `${lines.join('\n\n')}\n\n${payload.url}`,
        html: layout(`Join ${payload.companyName}`, lines, {
          label: 'Review invitation',
          url: payload.url,
        }),
      };
    }
    case 'crm.task_reminder': {
      const lines = [
        `Hi ${payload.name},`,
        `A reminder about your task in ${payload.companyName}: ${payload.taskTitle}`,
        payload.due ? `The task is due ${payload.due}.` : 'The task has no due date.',
      ];
      return {
        subject: `Reminder: ${payload.taskTitle}`,
        text: `${lines.join('\n\n')}\n\n${payload.url}`,
        html: layout('Task reminder', lines, { label: 'Open your tasks', url: payload.url }),
      };
    }
    case 'billing.notice': {
      return {
        subject: `${payload.subject} · ${payload.companyName}`,
        text: `${payload.lines.join('\n\n')}${payload.url ? `\n\n${payload.url}` : ''}`,
        html: layout(
          payload.subject,
          payload.lines,
          payload.url ? { label: 'Open billing', url: payload.url } : undefined,
        ),
      };
    }
    case 'tenant.notice': {
      return {
        subject: `${payload.subject} · ${payload.companyName}`,
        text: `${payload.lines.join('\n\n')}${payload.url ? `\n\n${payload.url}` : ''}`,
        html: layout(
          payload.subject,
          payload.lines,
          payload.url
            ? { label: payload.actionLabel ?? 'Open HyFib W360', url: payload.url }
            : undefined,
        ),
      };
    }
    case 'webhook.endpoint_disabled': {
      const lines = [
        `A webhook endpoint of ${payload.companyName} (${payload.host}) was turned off because every delivery to it failed for more than 72 hours.`,
        'Deliveries that were waiting for it are marked failed. When the endpoint works again, turn it back on in Settings, Webhooks, and replay the deliveries you need.',
      ];
      return {
        subject: `Webhook endpoint turned off · ${payload.companyName}`,
        text: `${lines.join('\n\n')}\n\n${payload.url}`,
        html: layout('Webhook endpoint turned off', lines, {
          label: 'Open webhook settings',
          url: payload.url,
        }),
      };
    }
  }
}
