// Agentia integration tests against a local STUB of the CLI (test/stubs/agentia.mjs).
// They check that the right commands are sent in the right order with the right guards.
// They do not prove anything about Copado's real responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFleet } from '../src/core/fleet.ts';
import { startRun } from '../src/app.ts';
import { loadFromGit } from '../src/sources/gitSource.ts';
import type { AgentAdapter } from '../src/core/types.ts';
import { AgentiaClient } from '../src/agentia/client.ts';
import { STORIES, aiAnswer, sampleRepo, stub, tmp } from './helpers.ts';

const fleetWith = (client: ReturnType<typeof stub>['client'], extra: AgentAdapter[] = []) =>
  createFleet({ workDir: tmp(), agentia: client, deny: ['claude-code', 'codex', 'cursor', 'copilot'], extraAgents: extra });

test('stories from Copado: work list + work get feed the run', async () => {
  const s = stub([
    { match: ['cicd', 'work', 'list'], stdout: { status: 0, result: [{ Name: 'US-0000101' }, { Name: 'US-0000103' }, { Name: 'US-0000999' }] } },
    { match: ['cicd', 'work', 'get', 'US-0000103'], stdout: { result: { Name: 'US-0000103', copado__User_Story_Title__c: 'FLS for Customer Tier' } } },
  ]);
  const src = await loadFromGit({ repo: sampleRepo(), base: 'main', fromCopado: true, client: s.client });
  assert.deepEqual(src.batch.tasks.map((t) => t.id), ['US-0000101', 'US-0000103']);
  assert.equal(src.batch.tasks[1].title, 'FLS for Customer Tier');
  assert.ok(src.notes.some((n) => n.story === 'US-0000999' && /no branch/.test(n.message)));
  assert.ok(s.calls().some((c) => s.cmd(c) === 'cicd work list'));
});

test('branch behind base is detected and turned into an environment-sync step', async () => {
  const s = stub();
  const repo = sampleRepo('revised');
  writeFileSync(path.join(repo, 'README.md'), 'hotfix\n');
  execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', 'x', '--allow-empty'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'hotfix on main'], { cwd: repo });
  const run = await startRun(fleetWith(s.client), { git: { repo, base: 'main', stories: ['US-0000101'] } }, s.client);
  assert.equal(run.tasks[0].source!.behindBase, true);
  assert.ok(run.simulation!.findings.some((f) => /behind main/.test(f.title)));
  assert.ok(run.promotionPlan![0].commands.includes('agentia cicd work environment-sync'));
});

test('five Copado AI agents each answer their own capability, consolidated under the rules', async () => {
  const s = stub([
    aiAnswer('plan', { expectedComponents: ['CustomField:Account.Customer_Tier__c', 'Layout:Account-Account Layout'], acceptanceCriteria: ['Tier is visible'], gaps: [] }),
    aiAnswer('build', { concerns: [{ title: 'Integration user cannot write the tier', severity: 'high', components: ['PermissionSet:Integration_User'], reason: 'r' }, { title: 'Picklist values differ from ERP codes', severity: 'high', components: ['CustomField:Account.Customer_Tier__c__ERP'], reason: 'ERP sends G/P' }] }),
    aiAnswer('release', { concerns: [] }),
    aiAnswer('test', { tests: [{ name: 'ERP upsert sets Customer Tier', type: 'integration', components: ['IntegrationMapping:ERP_Account_Sync'], reason: 'F-integration' }] }),
  ]);
  const run = await startRun(fleetWith(s.client), { git: { repo: sampleRepo(), base: 'main', stories: STORIES }, ai: true }, s.client);
  const agents = s.calls().filter((c) => c.args[0] === 'ai').map((c) => c.args[c.args.indexOf('--agent') + 1]);
  assert.deepEqual([...new Set(agents)].sort(), ['build', 'plan', 'release', 'test']);
  assert.equal(agents.filter((a) => a === 'plan').length, 5, 'one requirement check per story');
  assert.ok(run.agentCalls.some((c) => c.via === 'copado build agent'));
  assert.ok(run.simulation!.findings.some((f) => f.category === 'scope' && f.title.includes('Layout:Account-Account Layout')));
  const ai = run.simulation!.findings.find((f) => f.title.includes('Picklist values differ'))!;
  assert.equal(ai.category, 'unverified');
  assert.equal(ai.severity, 'medium', 'AI high is capped');
  assert.ok(run.risk!.tests.some((t) => t.includes('ERP upsert sets Customer Tier') && t.includes('copado test agent')));
  assert.equal(run.risk!.decision, 'REVISE', 'AI never changes a rule-based decision on its own');
});

test('second opinion: a concern raised by two agents is corroborated', async () => {
  const concern = { title: 'Dashboard filter uses legacy values', severity: 'high', components: ['Dashboard:Sales_Dashboards/Sales_Exec'], reason: 'r' };
  const s = stub([aiAnswer('build', { concerns: [concern] })]);
  const second: AgentAdapter = {
    descriptor: { id: 'second', name: 'Second reviewer', provider: 'test', capabilities: ['architecture.review'], mechanism: 'in-process', inputSchema: '', outputSchema: '', permissions: { write: false, deploy: false, network: false }, costTier: 'none', latencyTier: 'none', preference: 2 },
    isAvailable: async () => ({ ok: true }),
    execute: async () => ({ ok: true, evidence: 'ai-opinion', output: [{ ...concern, title: 'Exec dashboard groups by the old field' }] }),
  };
  const run = await startRun(fleetWith(s.client, [second]), { git: { repo: sampleRepo('revised'), base: 'main', stories: STORIES }, ai: true, secondOpinion: true }, s.client);
  const f = run.simulation!.findings.filter((x) => x.title.startsWith('[AI:'));
  assert.equal(f.length, 1, 'one merged finding, not two');
  assert.match(f[0].title, /agentia\.ai/);
  assert.match(f[0].title, /second/);
  assert.match(f[0].explanation, /more than one agent/);
});

test('live validation runs the Agentia work loop per story in wave order', async () => {
  const s = stub();
  const fleet = fleetWith(s.client);
  const repo = sampleRepo('revised');
  const run = await startRun(fleet, { git: { repo, base: 'main', stories: STORIES } }, s.client);
  assert.equal(run.risk!.decision, 'APPLY');
  await assert.rejects(fleet.execute(run.runId, { live: true }), /not approved/);
  fleet.approve(run.runId, 'Praveen');
  await assert.rejects(fleet.execute(run.runId, { live: true, deploy: true }), /does not allow deployment/);

  const before = s.calls().length;
  const exec = await fleet.execute(run.runId, { live: true });
  const sent = s.calls().slice(before).map(s.cmd);
  assert.deepEqual(exec.results.map((r) => r.status), ['VALIDATED', 'VALIDATED', 'VALIDATED', 'VALIDATED', 'VALIDATED']);
  assert.deepEqual(sent.slice(0, 7), [
    'cicd work set US-0000101',
    'cicd work test',
    'cicd work submit',
    'cicd work status US-0000101',
    'cicd work set US-0000102',
    'cicd work environment-sync',
    'cicd work test',
  ]);
  assert.ok(!sent.some((c) => c.includes('--deploy')), 'validation never deploys');
  // process.cwd() is the resolved path (macOS: /var -> /private/var)
  assert.ok(s.calls().slice(before).every((c) => c.cwd === realpathSync(repo)), 'runs in the repo');
  assert.equal(exec.riskAfter!.dimensions.at(-1)!.level, 'none', 'validation evidence now present');
});

test('a failed submit stops the chain and asks the Operate agent for a root cause', async () => {
  const s = stub([
    { match: ['cicd', 'work', 'submit'], active: 'US-0000103', exit: 1, stderr: 'Deployment failed: Field Customer_Tier__c is not visible to Integration_User' },
    aiAnswer('operate', { rootCause: 'Integration permission set lacks edit on Customer_Tier__c', suggestedFix: 'Set editable=true in US-0000103', components: ['PermissionSet:Integration_User'] }),
  ]);
  const fleet = fleetWith(s.client);
  const run = await startRun(fleet, { git: { repo: sampleRepo('revised'), base: 'main', stories: STORIES } }, s.client);
  fleet.approve(run.runId, 'Praveen', { allowDeploy: true });
  const exec = await fleet.execute(run.runId, { live: true, deploy: true });
  const byTask = Object.fromEntries(exec.results.map((r) => [r.task, r.status]));
  assert.equal(byTask['US-0000101'], 'DEPLOYED');
  assert.equal(byTask['US-0000103'], 'FAILED');
  assert.equal(byTask['US-0000104'], 'NOT-RUN');
  const failed = exec.results.find((r) => r.status === 'FAILED')!;
  assert.match(failed.rca!.output.rootCause, /lacks edit/);
  assert.equal(failed.rca!.via, 'copado operate agent');
  assert.ok(s.calls().some((c) => s.cmd(c) === 'cicd work submit --deploy'));
  assert.equal(exec.riskAfter!.decision, 'REVISE');
});

test('--evidence attaches a post-deployment Manual Task with the approval and findings', async () => {
  const s = stub();
  const fleet = fleetWith(s.client);
  const run = await startRun(fleet, { git: { repo: sampleRepo('revised'), base: 'main', stories: ['US-0000101'] } }, s.client);
  fleet.approve(run.runId, 'Praveen');
  const before = s.calls().length;
  await fleet.execute(run.runId, { live: true, evidence: true });
  const step = s.calls().slice(before).find((c) => c.args.includes('deployment-step'))!;
  assert.ok(step, 'deployment step created');
  const arg = (k: string) => step.args[step.args.indexOf(k) + 1];
  assert.equal(arg('--type'), 'Manual Task');
  assert.equal(arg('--sequence'), 'after');
  assert.ok(step.args.includes('--no-run-on-validation'));
  assert.match(arg('--instructions'), /Approved by Praveen/);
});

test('conflicts: only forecast-safe ones are auto-resolved through Copado', async () => {
  const s = stub([
    {
      match: ['cicd', 'promotion', 'conflict', 'list'],
      stdout: { result: [
        { attachmentId: 'att-1', metadataType: 'Profile', metadataName: 'Sales', userStory: 'US-0000105', status: 'Conflicted' },
        { attachmentId: 'att-2', metadataType: 'ApexClass', metadataName: 'AccountTierService', userStory: 'US-0000105', status: 'Conflicted' },
      ] },
    },
  ]);
  const fleet = fleetWith(s.client);
  const run = await startRun(fleet, { git: { repo: sampleRepo(), base: 'main', stories: STORIES } }, s.client);
  const check = await fleet.conflicts(run.runId, 'P-1');
  assert.deepEqual(check.decisions.map((d) => [d.component, d.decision]), [['Profile:Sales', 'auto'], ['ApexClass:AccountTierService', 'manual']]);
  assert.ok(!s.calls().some((c) => c.args.includes('resolve')), 'check mode resolves nothing');
  await assert.rejects(fleet.conflicts(run.runId, 'P-1', { apply: true }), /not approved/);
  fleet.approve(run.runId, 'Praveen', { acceptRisk: true });
  const applied = await fleet.conflicts(run.runId, 'P-1', { apply: true });
  const resolves = s.calls().filter((c) => c.args.includes('resolve')).map(s.cmd);
  assert.deepEqual(resolves, ['cicd promotion conflict resolve att-1 --promotion P-1 --mode auto']);
  assert.equal(applied.decisions[0].resolved, true);
  assert.match(applied.resumeHint, /promotion run P-1 --resume/);
});

test('Copado dependency analyzer runs per story in a temporary worktree and reports missing items', async () => {
  const s = stub([
    { match: ['cicd', 'metadata', 'dependency', 'list'], stdout: { result: { dependencies: [{ type: 'CustomField', name: 'Account.Customer_Tier__c', status: 'Missing in target' }, { type: 'Layout', name: 'Account-Account Layout', status: 'OK' }] } } },
  ]);
  const repo = sampleRepo('revised');
  const run = await startRun(fleetWith(s.client), { git: { repo, base: 'main', stories: ['US-0000102'], copadoImpact: true } }, s.client);
  const depCall = s.calls().find((c) => c.args.includes('dependency'))!;
  assert.notEqual(depCall.cwd, repo, 'not run in your checkout');
  assert.ok(depCall.args.includes('--from-changes'));
  assert.ok(run.simulation!.findings.some((f) => f.title === 'Copado: CustomField:Account.Customer_Tier__c is missing in the target for US-0000102' && f.severity === 'high'));
  assert.ok(run.simulation!.findings.some((f) => f.category === 'unverified' && f.components.includes('Layout:Account-Account Layout')));
  assert.equal(execFileSync('git', ['-C', repo, 'worktree', 'list']).toString().trim().split('\n').length, 1, 'worktree cleaned up');
});

test('without Agentia the fleet still runs; execution is labeled MOCK', async () => {
  const fleet = createFleet({ workDir: tmp(), agentia: new AgentiaClient({ bin: 'agentia-not-installed' }), deny: ['claude-code', 'codex', 'cursor', 'copilot'] });
  const run = await startRun(fleet, { git: { repo: sampleRepo('revised'), base: 'main', stories: STORIES } });
  fleet.approve(run.runId, 'Praveen');
  const exec = await fleet.execute(run.runId, { live: true });
  assert.ok(exec.results.every((r) => r.status === 'MOCK'));
  assert.equal(exec.riskAfter, undefined, 'mock results never count as evidence');
});
