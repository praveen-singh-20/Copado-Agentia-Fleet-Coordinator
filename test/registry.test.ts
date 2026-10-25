import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../src/registry/registry.ts';
import { MockValidateAdapter } from '../src/adapters/externalAgents.ts';
import { parseAnswer } from '../src/ai/contracts.ts';
import { parseAllJson } from '../src/adapters/exec.ts';
import type { AgentAdapter, AgentDescriptor, ExecutionContext } from '../src/core/types.ts';

const ctx = (approvalId?: string): ExecutionContext => ({ runId: 't', dryRun: true, approvalId, log: () => {} });

function fake(id: string, opts: Partial<AgentDescriptor> & { fails?: boolean; available?: boolean } = {}): AgentAdapter & { calls: number } {
  const descriptor: AgentDescriptor = {
    id,
    name: id,
    provider: 'test',
    capabilities: ['architecture.review'],
    mechanism: 'in-process',
    inputSchema: 'any',
    outputSchema: 'any',
    permissions: { write: false, deploy: false, network: false },
    costTier: 'low',
    latencyTier: 'low',
    preference: 1,
    ...opts,
  };
  const adapter = {
    descriptor,
    calls: 0,
    async isAvailable() {
      return opts.available === false ? { ok: false, reason: 'not installed' } : { ok: true };
    },
    async execute() {
      adapter.calls++;
      return opts.fails ? { ok: false, evidence: 'none' as const, error: 'boom' } : { ok: true, output: id, evidence: 'ai-opinion' as const };
    },
  };
  return adapter;
}

test('routes to the preferred agent and skips unavailable ones', async () => {
  const r = new AgentRegistry().register(fake('missing', { preference: 0, available: false })).register(fake('second', { preference: 2 })).register(fake('first', { preference: 1 }));
  const route = await r.route('architecture.review', {});
  assert.equal(route.chosen, 'first');
  assert.match(route.candidates.find((c) => c.id === 'missing')!.excludedBecause!, /unavailable/);
});

test('retries, then falls back to the next agent', async () => {
  const bad = fake('bad', { preference: 1, fails: true });
  const good = fake('good', { preference: 2 });
  const r = new AgentRegistry().register(bad).register(good);
  const res = await r.invoke('architecture.review', {}, ctx(), {}, 1);
  assert.equal(res.agent, 'good');
  assert.equal(bad.calls, 2, 'one try plus one retry');
  assert.equal(r.reliability.get('bad')!.failure, 2);
});

test('offline policy excludes network agents; deny list excludes by id', async () => {
  const r = new AgentRegistry().register(fake('cloud', { permissions: { write: false, deploy: false, network: true } })).register(fake('local', { preference: 5 }));
  assert.equal((await r.route('architecture.review', { offline: true })).chosen, 'local');
  assert.equal((await r.route('architecture.review', { deny: ['local'] })).chosen, 'cloud');
});

test('real deploy agents need an approval id; mocks are last resort and labeled', async () => {
  const realDeploy = fake('real', { capabilities: ['deploy.validate'], permissions: { write: true, deploy: true, network: true } });
  const r = new AgentRegistry().register(realDeploy).register(new MockValidateAdapter());
  const without = await r.route('deploy.validate', { needsDeploy: true }, ctx());
  assert.equal(without.chosen, 'mock.delivery');
  assert.match(without.candidates.find((c) => c.id === 'real')!.excludedBecause!, /approval/);
  const withApproval = await r.route('deploy.validate', { needsDeploy: true }, ctx('appr-1'));
  assert.equal(withApproval.chosen, 'real');
});

test('no eligible agent gives a clear error instead of a crash', async () => {
  const r = new AgentRegistry();
  const res = await r.invoke('architecture.review', {}, ctx());
  assert.equal(res.result.ok, false);
  assert.match(res.result.error!, /No eligible agent/);
});

test('AI responses are parsed from different CLI envelopes and sanitized', () => {
  const inner = { concerns: [{ title: 'x', severity: 'critical', components: ['A'], reason: 'r' }] };
  const parse = (v: unknown) => parseAnswer('architecture.review', [v]) as { severity: string; title: string }[];
  assert.equal(parse({ result: JSON.stringify(inner) })[0].severity, 'low', 'unknown severity is clamped');
  assert.equal(parse({ result: 'Here you go:\n' + JSON.stringify(inner) })[0].title, 'x');
  assert.equal(parse({ result: '```json\n' + JSON.stringify(inner) + '\n```' })[0].title, 'x');
  assert.throws(() => parse({ result: 'no json here' }));
  // Codex-style JSON Lines: the answer is inside an item event, not the last line.
  const jsonl = [JSON.stringify({ type: 'thread.started' }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(inner) } }), JSON.stringify({ type: 'turn.completed', usage: {} })].join('\n');
  assert.equal((parseAnswer('architecture.review', parseAllJson(jsonl)) as { title: string }[])[0].title, 'x');
});
