import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetadataState } from '../src/graph/metadataGraph.ts';
import { schedule } from '../src/coordinator/planner.ts';
import { simulate } from '../src/simulation/engine.ts';
import { assessRisk } from '../src/risk/riskEngine.ts';
import type { TaskBatch } from '../src/core/types.ts';
import { original, rejectBatch, revised, snapshot } from './helpers.ts';

const runSim = (batch: TaskBatch) => {
  const baseline = MetadataState.fromSnapshot(snapshot());
  const sim = simulate({ baseline, baselineName: 'fixture', tasks: batch.tasks, schedule: schedule(batch.tasks) });
  return { sim, risk: assessRisk(sim), baseline };
};

test('combined effect: US-103 + US-104 conflict only shows up when the batch is simulated together', () => {
  const { sim } = runSim(original());
  const integration = sim.findings.find((f) => f.category === 'integration');
  assert.ok(integration, 'integration finding expected');
  assert.deepEqual([...integration.stories].sort(), ['US-103', 'US-104']);
  assert.equal(integration.severity, 'high');
  assert.ok(sim.reevaluate.some((r) => r.task === 'US-104' && r.triggeredBy.includes('US-103')));

  // Each story alone is clean on this point.
  for (const id of ['US-103', 'US-104']) {
    const alone = original().tasks.filter((t) => t.id === 'US-101' || t.id === id);
    const r = runSim({ name: id, tasks: alone.map((t) => ({ ...t, assumptions: [] })) });
    assert.equal(r.sim.findings.filter((f) => f.category === 'integration').length, id === 'US-104' ? 1 : 0);
  }
});

test('deleting the legacy field is caught through metadata, source code, configuration and inference', () => {
  const { sim, risk } = runSim(original());
  const dangling = sim.findings.filter((f) => f.title.includes('which is deleted'));
  assert.deepEqual(dangling.map((f) => f.evidence[0]).sort(), ['configuration', 'inference', 'metadata', 'source-code']);
  assert.equal(dangling.find((f) => f.evidence[0] === 'inference')!.severity, 'medium', 'inferred edges are downgraded');
  assert.ok(sim.findings.some((f) => f.title.includes('PermissionSet:Integration_User still has fieldPermissions:Account.Tier_Legacy__c')));
  assert.equal(risk.decision, 'REVISE');
  assert.equal(risk.overall, 'high');
});

test('before/after diff attributes every change to its stories and leaves the baseline intact', () => {
  const { sim, baseline } = runSim(original());
  const profile = sim.diff.find((d) => d.id === 'Profile:Sales')!;
  assert.deepEqual(profile.stories.sort(), ['US-103', 'US-105']);
  assert.equal(profile.nodes!.length, 2);
  assert.equal(sim.diff.find((d) => d.id === 'CustomField:Account.Tier_Legacy__c')!.change, 'removed');
  assert.ok(baseline.has('CustomField:Account.Tier_Legacy__c'), 'baseline is preserved for repeatable comparisons');
});

test('revised batch: no high findings, APPLY, but validation evidence still missing', () => {
  const { sim, risk } = runSim(revised());
  assert.equal(sim.findings.filter((f) => f.severity === 'high' || f.severity === 'blocker').length, 0);
  assert.equal(risk.decision, 'APPLY');
  assert.equal(risk.dimensions.find((d) => d.name === 'Validation evidence')!.level, 'medium');
  assert.ok(risk.tests.includes('Regression test for ApexTrigger:AccountTrigger'));
});

test('granting a PII field to an external profile is a blocker and REJECT', () => {
  const { risk, sim } = runSim(rejectBatch());
  assert.equal(sim.findings[0].severity, 'blocker');
  assert.equal(risk.decision, 'REJECT');
});

test('validation evidence changes the decision: a failed Copado validation forces REVISE', () => {
  const { sim } = runSim(revised());
  assert.equal(assessRisk(sim, { validation: { ran: true, passed: false, source: 'agentia cicd work submit' } }).decision, 'REVISE');
  assert.equal(assessRisk(sim, { validation: { ran: true, passed: true, source: 'agentia cicd work submit' } }).dimensions.at(-1)!.level, 'none');
});

test('simulation is deterministic', () => {
  const a = runSim(original()).sim;
  const b = runSim(original()).sim;
  assert.deepEqual(a, b);
});
