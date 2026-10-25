// A stand-in for Copado's AI Context Hub MCP server (streamable HTTP), for tests.
// Tool schemas are guesses shaped like Copado's; the client must read them, not assume them.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubCall {
  method: string;
  tool?: string;
  args?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

export interface StubOptions {
  stories: { name: string; id: string; title: string }[];
  /** Respond to tools/call with text/event-stream instead of JSON. */
  sse?: boolean;
  failTool?: string;
  /** Older server shape: promote has no execute_deployment, so deploy_promotion is a second call. */
  legacy?: boolean;
}

// Shapes as the real server lists them (fleet copado tools, Oct 2026).
const PROMOTE_PROPS: Record<string, { type: string }> = {
  promotion_id: { type: 'string' }, transaction_id: { type: 'string' }, user_stories: { type: 'array' }, source_environment_id: { type: 'string' },
  project_id: { type: 'string' }, execute_promotion: { type: 'boolean' }, execute_deployment: { type: 'boolean' }, deployment_dry_run: { type: 'boolean' },
  other_information: { type: 'string' }, is_back_promotion: { type: 'boolean' }, action_callback: { type: 'string' },
};
const toolsFor = (legacy?: boolean) => [
  { name: 'copado_cicd_list_user_stories', description: 'List user stories', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, search: { type: 'string' }, search_field: { type: 'string' }, search_value: { type: 'string' }, include_details: { type: 'boolean' }, omit_nulls: { type: 'boolean' } } } },
  { name: 'copado_cicd_promote_user_story', description: 'Promote user stories', inputSchema: { type: 'object', properties: legacy ? Object.fromEntries(Object.entries(PROMOTE_PROPS).filter(([k]) => k !== 'execute_deployment')) : PROMOTE_PROPS } },
  { name: 'copado_cicd_deploy_promotion', description: 'Deploy promotion', inputSchema: { type: 'object', properties: { promotion_id: { type: 'string' }, deployment_dry_run: { type: 'boolean' }, other_information: { type: 'string' }, action_callback: { type: 'string' } }, required: ['promotion_id'] } },
  { name: 'copado_cicd_commit_metadata', description: 'Commit', inputSchema: { type: 'object', properties: {} } },
  { name: 'retrieve_knowledge', description: 'Knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

export async function startCopadoStub(opts: StubOptions): Promise<{ url: string; calls: StubCall[]; close: () => Promise<void> }> {
  const calls: StubCall[] = [];
  let promotions = 0;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers['x-authorization'] !== 'pat-123' || req.headers['x-organization-id'] !== '45333') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      calls.push({ method: msg.method, tool: msg.params?.name, args: msg.params?.arguments, headers: req.headers });
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method !== 'initialize' && req.headers['mcp-session-id'] !== 'sess-1') {
        res.writeHead(400);
        res.end('missing session');
        return;
      }
      let result: unknown;
      if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'copado-stub', version: '0' } };
      else if (msg.method === 'tools/list') result = { tools: toolsFor(opts.legacy) };
      else if (msg.method === 'tools/call') {
        const a = msg.params!.arguments ?? {};
        const text = (o: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
        if (msg.params!.name === opts.failTool) result = { content: [{ type: 'text', text: 'Promotion failed: validation errors' }], isError: true };
        else if (msg.params!.name === 'copado_cicd_list_user_stories') {
          const rows = opts.stories.filter((s) => !a.search_value || s.name === a.search_value).map((s) => ({ Id: s.id, Name: s.name, copado__User_Story_Title__c: s.title, copado__Status__c: 'In Progress' }));
          result = text({ totalSize: rows.length, records: rows });
        } else if (msg.params!.name === 'copado_cicd_promote_user_story') result = text({ success: true, promotion: { Id: `a0P${++promotions}`, Name: `P-00000${promotions}` } });
        else if (msg.params!.name === 'copado_cicd_deploy_promotion') result = text({ success: true, jobExecutionId: 'job-1', promotionId: a.promotion_id });
        else result = text({ ok: true });
      }
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      const headers: Record<string, string> = { 'mcp-session-id': 'sess-1' };
      if (opts.sse && msg.method === 'tools/call') {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${payload}\n\n`);
      } else {
        res.writeHead(200, { ...headers, 'content-type': 'application/json' });
        res.end(payload);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp/`, calls, close: () => new Promise((r) => server.close(() => r())) };
}
