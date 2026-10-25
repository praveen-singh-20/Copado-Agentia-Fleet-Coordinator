// MCP server (stdio, JSON-RPC 2.0, newline-delimited) so Claude Code, Cursor or Copilot
// can call the fleet as a tool next to Agentia's own `agentia mcp start` server.
//
// Deliberately NOT exposed: approve, live execution, deploy, conflict resolution.
// Those stay with a human in the terminal or the web UI.

import { createInterface } from 'node:readline';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { FleetCoordinator } from '../coordinator/coordinator.ts';
import type { AgentiaClient } from '../agentia/client.ts';
import { startRun, summarize } from '../app.ts';
import { compareRuns, renderCompare, renderMarkdown } from '../report/render.ts';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean | string>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${name}" is required`);
  return v;
};

export function fleetTools(fleet: FleetCoordinator, agentia?: AgentiaClient): Tool[] {
  return [
    {
      name: 'fleet_simulate_branches',
      description:
        'Simulate a set of Copado user stories together before submitting them. Reads each story\'s Git branch (feature/<story>), imports the Salesforce metadata, forecasts collisions between stories, simulates the combined end state, and returns findings plus an APPLY/REVISE/REJECT recommendation. Call this before `agentia cicd work submit`. Read-only: it never commits, promotes or deploys.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Path to the Salesforce Git repository' },
          base: { type: 'string', description: 'Baseline ref, e.g. origin/main or the next environment branch' },
          stories: { type: 'array', items: { type: 'string' }, description: 'Copado story names, e.g. US-0000101' },
          fromCopado: { type: 'boolean', description: 'Also include in-flight stories from agentia cicd work list' },
          fromCopadoAi: { type: 'boolean', description: 'Also include user stories listed by the Copado AI MCP server (copado_cicd_list_user_stories); works without the Agentia CLI' },
          copadoImpact: { type: 'boolean', description: 'Also run the Copado dependency analyzer per branch' },
          ai: { type: 'boolean', description: 'Ask the Copado AI agents (plan, build, test, release) too' },
        },
        required: ['repo', 'base'],
      },
      annotations: { title: 'Simulate stories', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      run: async (a) => {
        const run = await startRun(
          fleet,
          { git: { repo: str(a.repo, 'repo'), base: str(a.base, 'base'), stories: Array.isArray(a.stories) ? a.stories.map(String) : undefined, fromCopado: !!a.fromCopado, fromCopadoAi: !!a.fromCopadoAi, copadoImpact: !!a.copadoImpact }, ai: !!a.ai },
          agentia,
        );
        return summarize(run);
      },
    },
    {
      name: 'fleet_simulate_file',
      description: 'Simulate a batch of stories described in a JSON file against a snapshot file or a force-app folder. Read-only.',
      inputSchema: { type: 'object', properties: { stories: { type: 'string' }, snapshot: { type: 'string' }, ai: { type: 'boolean' } }, required: ['stories', 'snapshot'] },
      annotations: { title: 'Simulate from file', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: async (a) => summarize(await startRun(fleet, { stories: str(a.stories, 'stories'), snapshot: str(a.snapshot, 'snapshot'), ai: !!a.ai }, agentia)),
    },
    {
      name: 'fleet_report',
      description: 'Full Markdown report for a run: plan, before/after, blast radius, findings with fixes, risk, promotion plan.',
      inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
      annotations: { title: 'Run report', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: async (a) => renderMarkdown(fleet.loadRun(str(a.runId, 'runId'))),
    },
    {
      name: 'fleet_compare',
      description: 'Compare two runs: which findings were resolved, introduced, or are still open. Use after revising stories.',
      inputSchema: { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' } }, required: ['before', 'after'] },
      annotations: { title: 'Compare runs', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: async (a) => renderCompare(compareRuns(fleet.loadRun(str(a.before, 'before')), fleet.loadRun(str(a.after, 'after')))).replace(/\x1b\[[0-9;]*m/g, ''),
    },
    {
      name: 'fleet_execution_preview',
      description:
        'For an APPROVED run, list the exact Agentia commands to run, in order, without sending them. Fails if the run is not approved or a story changed since approval: call it before any agentia submit/promote/deploy tool and follow its order. With deploy=true it lists deploy commands, and only if the approval allows deployment. Approval itself is human-only.',
      inputSchema: { type: 'object', properties: { runId: { type: 'string' }, deploy: { type: 'boolean', description: 'List deploy-to-next-environment commands instead of validation' } }, required: ['runId'] },
      annotations: { title: 'Execution preview', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: async (a) => {
        const exec = await fleet.execute(str(a.runId, 'runId'), { live: false, deploy: !!a.deploy });
        return exec.results
          .map((r) => {
            const d = r.detail as { wouldRun?: string[] } | undefined;
            const cmds = r.steps?.map((s) => s.command) ?? d?.wouldRun ?? [];
            return `${r.status} wave ${r.wave} ${r.task}${r.status === 'MOCK' ? ' (Agentia CLI not found: commands shown, nothing can be sent)' : ''}\n${cmds.length ? cmds.map((c) => `  $ ${c}`).join('\n') : `  ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail ?? '')}`}`;
          })
          .join('\n');
      },
    },
    {
      name: 'fleet_runs',
      description: 'List recent fleet runs (newest first) with their decision and whether a person approved them. Use it to find the previous run to compare with.',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      annotations: { title: 'Recent runs', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: async (a) => {
        const dir = path.join(fleet.opts.workDir, 'runs');
        const ids = existsSync(dir) ? readdirSync(dir).filter((id) => existsSync(path.join(dir, id, 'run.json'))).sort().reverse() : [];
        const rows = ids.slice(0, typeof a.limit === 'number' ? a.limit : 10).map((id) => {
          const r = fleet.loadRun(id);
          return `${id}  ${r.risk?.decision ?? r.status}  ${fleet.loadApproval(id) ? 'approved' : 'not approved'}  ${r.batch}`;
        });
        return rows.join('\n') || 'No runs yet.';
      },
    },
    {
      name: 'fleet_agents',
      description: 'List the agents in the fleet, what they can do, their permissions and whether they are available.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'Fleet agents', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      run: async () =>
        (await fleet.registry.discover()).map((d) => `${d.availability.ok ? '●' : '○'} ${d.id} [${d.capabilities.join(', ')}] ${d.permissions.deploy ? 'deploy' : d.permissions.write ? 'write' : 'read-only'}${d.mock ? ' MOCK' : ''}${d.availability.ok ? '' : ` (${d.availability.reason})`}`).join('\n'),
    },
  ];
}

export async function handleMessage(tools: Tool[], msg: { id?: number | string; method?: string; params?: Record<string, unknown> }): Promise<Record<string, unknown> | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.id === undefined) return undefined; // notification
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agentia-fleet', version: '0.2.0' },
        instructions: 'Use fleet_simulate_branches before submitting Copado stories. Never claim a run is approved: approval is human-only.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
    case 'tools/call': {
      const name = msg.params?.name as string;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return error(-32602, `Unknown tool ${name}`);
      try {
        const text = await tool.run((msg.params?.arguments as Record<string, unknown>) ?? {});
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

export async function startMcp(fleet: FleetCoordinator, agentia?: AgentiaClient): Promise<void> {
  const tools = fleetTools(fleet, agentia);
  const rl = createInterface({ input: process.stdin });
  const pending: Promise<void>[] = [];
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    pending.push(
      handleMessage(tools, msg).then((r) => {
        if (r) process.stdout.write(JSON.stringify(r) + '\n');
      }),
    );
  });
  await new Promise<void>((resolve) => rl.on('close', () => resolve()));
  await Promise.all(pending);
}
