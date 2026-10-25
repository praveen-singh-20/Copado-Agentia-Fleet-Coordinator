import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFleet } from '../src/core/fleet.ts';
import { consolidateOpinions } from '../src/coordinator/coordinator.ts';
import { MockValidateAdapter } from '../src/adapters/externalAgents.ts';
import { AuditLog } from '../src/audit/auditLog.ts';
import type { AgentAdapter, AgentDescriptor } from '../src/core/types.ts';
import { original, revised, snapshot, tmp } from './helpers.ts';

const fleet = (workDir = tmp(), extra: AgentAdapter[] = []) => createFleet({ workDir, localOnly: true, extraAgents: [new MockValidateAdapter(), ...extra] });

test('end to end: revised batch → APPLY → approve → dry-run execute (MOCK, labeled)', async () => {
  const f = fleet();
  const run = await f.run(revised(), snapshot());
  assert.equal(run.status, 'awaiting-approval');
  assert.equal(run.risk!.decision, 'APPLY');
  assert.equal(Object.keys(run.impacts!).length, 5, 'per-story impact computed for every story');

  await assert.rejects(f.execute(run.runId), /not approved/);
  const approval = f.approve(run.runId, 'Praveen');
  assert.equal(approval.planHash, run.planHash);

  const exec = await f.execute(run.runId);
  assert.equal(exec.mode, 'dry-run');
  assert.deepEqual(exec.results.map((r) => r.status), ['MOCK', 'MOCK', 'MOCK', 'MOCK', 'MOCK']);
  assert.deepEqual(exec.results.map((r) => r.task), ['US-101', 'US-102', 'US-103', 'US-104', 'US-105'], 'wave order respected');
});

test('REVISE needs --accept-risk; approval needs a named person', async () => {
  const f = fleet();
  const run = await f.run(original(), snapshot());
  assert.equal(run.status, 'revise');
  assert.throws(() => f.approve(run.runId, 'Praveen'), /needs revision/);
  assert.throws(() => f.approve(run.runId, '  ', { acceptRisk: true }), /named approver/);
  assert.equal(f.approve(run.runId, 'Praveen', { acceptRisk: true }).acceptedRisk, true);
});

test('editing the plan after approval voids the approval', async () => {
  const dir = tmp();
  const f = fleet(dir);
  const run = await f.run(revised(), snapshot());
  f.approve(run.runId, 'Praveen');
  const file = path.join(dir, 'runs', run.runId, 'run.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.tasks[0].changes[0].component.attributes.label = 'Sneaky change';
  writeFileSync(file, JSON.stringify(saved));
  await assert.rejects(f.execute(run.runId), /plan changed after approval/);
});

test('invalid stories stop the run for a human instead of guessing', async () => {
  const f = fleet();
  const run = await f.run({ name: 'bad', tasks: [{ id: 'X 1', title: '', changes: [{ op: 'explode' } as never] }] }, snapshot());
  assert.equal(run.status, 'needs-human');
  assert.ok(run.intakeIssues[0].issues.length >= 2);
});

test('audit trail is hash-chained and detects tampering', async () => {
  const dir = tmp();
  const f = fleet(dir);
  await f.run(revised(), snapshot());
  const file = path.join(dir, 'audit.jsonl');
  assert.equal(AuditLog.verify(file).ok, true);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const entry = JSON.parse(lines[2]);
  entry.event = 'edited';
  lines[2] = JSON.stringify(entry);
  writeFileSync(file, lines.join('\n') + '\n');
  const v = AuditLog.verify(file);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 3);
});

test('a new agent plugs in without changing the coordinator, and AI opinions never override rules', async () => {
  const descriptor: AgentDescriptor = {
    id: 'test.reviewer',
    name: 'Test reviewer',
    provider: 'test',
    capabilities: ['architecture.review'],
    mechanism: 'in-process',
    inputSchema: 'ReviewRequest',
    outputSchema: 'ReviewConcern[]',
    permissions: { write: false, deploy: false, network: false },
    costTier: 'none',
    latencyTier: 'none',
    preference: 1,
  };
  const reviewer: AgentAdapter = {
    descriptor,
    isAvailable: async () => ({ ok: true }),
    execute: async () => ({
      ok: true,
      evidence: 'ai-opinion',
      output: [
        { title: 'Integration user lacks edit', severity: 'high', components: ['PermissionSet:Integration_User'], reason: 'agrees' },
        { title: 'Check dashboard filters', severity: 'high', components: ['Dashboard:Sales_Exec'], reason: 'new' },
      ],
    }),
  };
  const run = await fleet(tmp(), [reviewer]).run(original(), snapshot(), { ai: true });
  assert.equal(run.aiOpinions![0].agent, 'test.reviewer');
  assert.equal(run.aiOpinions![0].agreements.length, 1);
  const ai = run.simulation!.findings.find((x) => x.title.startsWith('[AI: test.reviewer]'))!;
  assert.equal(ai.severity, 'medium', 'AI "high" is capped at medium');
  assert.equal(ai.category, 'unverified');
});

test('consolidateOpinions keeps rule findings untouched', () => {
  const before = [{ id: 'F001', category: 'integration' as const, severity: 'high' as const, title: 't', explanation: 'e', components: ['A'], stories: [], evidence: ['metadata' as const] }];
  const out = consolidateOpinions(before, [{ title: 'fine', severity: 'low', components: ['A'], reason: 'looks ok' }], 'x');
  assert.equal(out.newFindings.length, 0);
  assert.equal(before[0].severity, 'high');
});
