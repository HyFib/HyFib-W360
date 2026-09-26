import 'server-only';
import pg from 'pg';
import type { Logger } from '@w360/core';

/**
 * One LISTEN connection per web process, fanning `w360_tenant_events` notifications (payload: a
 * company id, nothing else) out to that company's open live-update streams. Notifications are only
 * wake-up hints: streams read the durable event log by cursor and also poll on a timer, so a lost
 * notification or a reconnect delays delivery but never drops events.
 */
export interface TenantEventHub {
  subscribe(tenantId: string, onWake: () => void): () => void;
  close(): Promise<void>;
}

const CHANNEL = 'w360_tenant_events';

export function createTenantEventHub(options: {
  connectionString: string;
  logger: Logger;
}): TenantEventHub {
  const subscribers = new Map<string, Set<() => void>>();
  let client: pg.Client | null = null;
  let connecting: Promise<void> | null = null;
  let closed = false;
  let retryMs = 1_000;

  const dispatch = (tenantId: string) => {
    for (const wake of subscribers.get(tenantId) ?? []) wake();
  };

  const connect = async (): Promise<void> => {
    if (closed || client) return;
    const next = new pg.Client({
      connectionString: options.connectionString,
      application_name: 'w360-web-events',
    });
    next.on('notification', (msg) => {
      if (msg.channel === CHANNEL && msg.payload) dispatch(msg.payload);
    });
    next.on('error', (error) => {
      options.logger.warn({ err: error.message }, 'event hub connection error');
      if (client === next) client = null;
      void next.end().catch(() => undefined);
      scheduleReconnect();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${CHANNEL}`);
      client = next;
      retryMs = 1_000;
      // Streams may have missed hints while disconnected; wake everyone to re-read.
      for (const tenantId of subscribers.keys()) dispatch(tenantId);
    } catch (error) {
      options.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'event hub could not listen; streams fall back to polling',
      );
      void next.end().catch(() => undefined);
      scheduleReconnect();
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, 30_000);
    setTimeout(() => {
      connecting = connect().finally(() => {
        connecting = null;
      });
    }, delay).unref();
  };

  const ensureConnected = () => {
    if (!client && !connecting && !closed) {
      connecting = connect().finally(() => {
        connecting = null;
      });
    }
  };

  return {
    subscribe(tenantId, onWake) {
      ensureConnected();
      let set = subscribers.get(tenantId);
      if (!set) {
        set = new Set();
        subscribers.set(tenantId, set);
      }
      set.add(onWake);
      return () => {
        const current = subscribers.get(tenantId);
        current?.delete(onWake);
        if (current && current.size === 0) subscribers.delete(tenantId);
      };
    },
    async close() {
      closed = true;
      subscribers.clear();
      const current = client;
      client = null;
      if (current) await current.end().catch(() => undefined);
    },
  };
}
