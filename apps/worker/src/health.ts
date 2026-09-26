import { createServer, type Server } from 'node:http';
import { sql, systemScope } from '@w360/db';
import type { WorkerRuntime } from './runtime';

/** Liveness and readiness probes for orchestrators. Bound to the configured port only. */
export function startHealthServer(rt: WorkerRuntime, isStopping: () => boolean): Server {
  const server = createServer((req, res) => {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/live') return send(200, { status: 'ok' });
    if (req.url === '/ready') {
      if (isStopping()) return send(503, { status: 'stopping' });
      const started = Date.now();
      rt.db
        .run(systemScope, (tx) => tx.execute(sql`select 1`), { accessMode: 'read only' })
        .then(() => send(200, { status: 'ready', dbLatencyMs: Date.now() - started }))
        .catch(() => send(503, { status: 'unavailable' }));
      return;
    }
    send(404, { status: 'not_found' });
  });
  server.listen(rt.config.WORKER_HEALTH_PORT);
  return server;
}
