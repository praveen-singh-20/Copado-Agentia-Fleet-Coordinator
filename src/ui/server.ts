// Local web UI. Binds to 127.0.0.1 only. POST endpoints require JSON and an
// X-Fleet header, so a page on another site cannot submit approvals (no simple CORS form posts).
// The UI can simulate, approve and preview; live execution stays in the terminal.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FleetCoordinator } from '../coordinator/coordinator.ts';
import type { AgentiaClient } from '../agentia/client.ts';
import { AuditLog } from '../audit/auditLog.ts';
import { startRun, type StartRunParams } from '../app.ts';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page.html');

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error('request too large');
  }
  return data ? (JSON.parse(data) as Record<string, unknown>) : {};
}

export function handler(fleet: FleetCoordinator, agentia?: AgentiaClient) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, obj: unknown, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(obj) : (obj as string));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'POST' && (req.headers['x-fleet'] !== '1' || !String(req.headers['content-type']).includes('application/json'))) {
        return send(403, { error: 'POST requests need Content-Type: application/json and X-Fleet: 1' });
      }
      if (req.method === 'GET' && url.pathname === '/') return send(200, readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        const dir = path.join(fleet.opts.workDir, 'runs');
        const ids = existsSync(dir) ? readdirSync(dir).sort() : [];
        return send(200, ids.filter((id) => existsSync(path.join(dir, id, 'run.json'))).map((id) => {
          const r = fleet.loadRun(id);
          return { runId: id, batch: r.batch, status: r.status, decision: r.risk?.decision ?? '—', approved: !!fleet.loadApproval(id) };
        }));
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const b = (await body(req)) as StartRunParams;
        const run = await startRun(fleet, b, agentia);
        return send(200, { runId: run.runId, status: run.status, decision: run.risk?.decision });
      }
      if (parts[0] === 'api' && parts[1] === 'runs' && parts[2]) {
        const id = decodeURIComponent(parts[2]);
        if (!/^run-[\w-]+$/.test(id)) return send(400, { error: 'bad run id' });
        if (req.method === 'GET' && parts.length === 3) return send(200, { run: fleet.loadRun(id), approval: fleet.loadApproval(id) ?? null });
        if (req.method === 'POST' && parts[3] === 'approve') {
          const b = await body(req);
          const a = fleet.approve(id, String(b.by ?? ''), { acceptRisk: !!b.acceptRisk, allowDeploy: !!b.allowDeploy, channel: 'web ui' });
          return send(200, a);
        }
        if (req.method === 'POST' && parts[3] === 'preview') return send(200, await fleet.execute(id, { live: false }));
      }
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        const run = url.searchParams.get('run');
        return send(200, AuditLog.read(path.join(fleet.opts.workDir, 'audit.jsonl')).filter((e) => !run || e.runId === run));
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(400, { error: (e as Error).message });
    }
  };
}

export async function startUi(fleet: FleetCoordinator, opts: { port?: number; agentia?: AgentiaClient } = {}): Promise<{ server: Server; url: string }> {
  const server = createServer(handler(fleet, opts.agentia));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4600, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return { server, url: `http://127.0.0.1:${port}` };
}
