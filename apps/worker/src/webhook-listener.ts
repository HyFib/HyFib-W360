import pg from 'pg';
import { toError } from '@w360/core';
import { dispatchDueWebhooks } from '@w360/domain';
import type { WorkerRuntime } from './runtime';

/**
 * Starts webhook delivery as soon as deliveries are created: one LISTEN connection per worker
 * process on `w360_webhooks`. A notification carries nothing and is only a wake-up: it prompts a
 * lookup of which active companies have due deliveries (from the database, never from the
 * notification), bursts coalesce into at most one lookup per quarter second, and a notification
 * lost while disconnected waits for the minute sweep at most.
 */
export interface WebhookListener {
  close(): Promise<void>;
}

const CHANNEL = 'w360_webhooks';
/** Lookups start at least this far apart while notifications keep arriving. */
const MIN_INTERVAL_MS = 250;

export function startWebhookListener(rt: WorkerRuntime): WebhookListener {
  let client: pg.Client | null = null;
  let closed = false;
  let retryMs = 1_000;
  let wanted = false;
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastStart = 0;

  const dispatch = async () => {
    wanted = false;
    lastStart = Date.now();
    try {
      await dispatchDueWebhooks(rt);
    } catch (error) {
      rt.logger.error({ err: toError(error) }, 'webhook dispatch failed; the minute sweep retries');
    }
  };

  const wake = () => {
    if (closed) return;
    wanted = true;
    if (running || timer) return;
    timer = setTimeout(
      () => {
        timer = null;
        if (closed || !wanted) return;
        running = dispatch().finally(() => {
          running = null;
          if (wanted) wake();
        });
      },
      Math.max(0, lastStart + MIN_INTERVAL_MS - Date.now()),
    );
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, 30_000);
    setTimeout(() => void connect(), delay).unref();
  };

  const connect = async (): Promise<void> => {
    if (closed || client) return;
    const next = new pg.Client({
      connectionString: rt.config.DATABASE_URL_APP,
      application_name: 'w360-worker-webhooks',
    });
    next.on('notification', (msg) => {
      if (msg.channel === CHANNEL) wake();
    });
    next.on('error', (error) => {
      rt.logger.warn({ err: error.message }, 'webhook listener connection error');
      if (client === next) client = null;
      void next.end().catch(() => undefined);
      scheduleReconnect();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${CHANNEL}`);
      if (closed) {
        await next.end();
        return;
      }
      client = next;
      retryMs = 1_000;
      // Deliveries may have been created while disconnected.
      wake();
    } catch (error) {
      rt.logger.warn(
        { err: toError(error).message },
        'webhook listener could not listen; the minute sweep still wakes delivery',
      );
      void next.end().catch(() => undefined);
      scheduleReconnect();
    }
  };

  void connect();

  return {
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const current = client;
      client = null;
      if (current) await current.end().catch(() => undefined);
      if (running) await running;
    },
  };
}
