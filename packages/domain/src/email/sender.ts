import nodemailer, { type Transporter } from 'nodemailer';
import type { SmtpConfig } from '@w360/core';
import type { RenderedEmail } from './templates';

/**
 * Transactional email provider adapter. One provider is configured per deployment through SMTP
 * (see docs/DECISIONS.md ADR-009); swapping providers means changing SMTP credentials, not code.
 */
export interface EmailSender {
  send(message: { to: string } & RenderedEmail): Promise<{ providerMessageId: string | null }>;
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EmailSendError';
  }
}

export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: SmtpConfig) {
    this.from = config.from;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.password ?? '' } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: { to: string } & RenderedEmail): Promise<{ providerMessageId: string | null }> {
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return { providerMessageId: typeof info.messageId === 'string' ? info.messageId : null };
    } catch (error) {
      const code = (error as { responseCode?: number }).responseCode;
      // SMTP 5xx replies are permanent (bad recipient, policy); everything else is retried.
      throw new EmailSendError('SMTP delivery failed', typeof code === 'number' && code >= 500 && code < 600, {
        cause: error,
      });
    }
  }
}
