// The ready-to-use kit on a repo shaped like a real Copado project (sfdx project,
// environment branches), with no Agentia installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { initRepo } from '../src/init.ts';
import { createStoryBranches, seedScenario } from '../src/scenario/scenario.ts';
import { createFleet } from '../src/core/fleet.ts';
import { startRun } from '../src/app.ts';
import { AgentiaClient } from '../src/agentia/client.ts';
import { importSfdx } from '../src/importer/sfdx.ts';
import { tmp } from './helpers.ts';

const IDS = ['US-0000201', 'US-0000202', 'US-0000203', 'US-0000204', 'US-0000205'];

function userRepo(): string {
  const dir = path.join(tmp(), 'Copado-Agentia_Fleet_CordinatorSFP');
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' }).toString();
  g('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '61.0' }));
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  g('add', '-A');
  g('commit', '-qm', 'skeleton');
  return dir;
}

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' }).toString();

test('fleet init wires an existing repo and is safe to re-run', () => {
  const dir = userRepo();
  writeFileSync(path.join(dir, 'AGENTS.md'), '# Team rules\n\n<!-- agentia:managed:start -->\nmanaged\n<!-- agentia:managed:end -->\n');
  initRepo(dir);
  initRepo(dir, { agentia: false });
  const mcp = JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['fleet'], '--no-agentia removes the agentia server');
  const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(agents.split('<!-- fleet:start -->').length, 2, 'one fleet section after two runs');
  assert.match(agents, /agentia:managed:start[\s\S]*managed[\s\S]*agentia:managed:end/, "Agentia's section is untouched");
  assert.ok(existsSync(path.join(dir, '.claude', 'skills', 'fleet-coordinator', 'SKILL.md')));
  assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.fleet\/$/m);
  const allow = JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).permissions.allow as string[];
  assert.ok(allow.includes('mcp__fleet__fleet_simulate_branches') && !allow.some((a) => /approve/.test(a)));
});

test('scenario kit: seed + five story branches → REVISE; revised branches → APPLY (no Agentia needed)', async () => {
  const dir = userRepo();
  const seeded = seedScenario(dir);
  assert.ok(seeded.written.includes('force-app/main/default/reports/Sales_Reports.reportFolder-meta.xml'));
  const snap = importSfdx(dir).snapshot;
  assert.ok(snap.components.some((c) => c.id === 'PermissionSet:Sales_User'));
  assert.ok(snap.dependencies.some((d) => d.from === 'ApexClass:TierBatchJob' && d.source === 'inference'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'baseline');
  git(dir, 'branch', 'dev');

  await assert.rejects(createStoryBranches(dir, { base: 'dev', ids: IDS.slice(0, 3) }), /exactly 5/);
  const made = await createStoryBranches(dir, { base: 'dev', ids: IDS });
  assert.deepEqual(made.map((m) => m.branch), IDS.map((i) => `feature/${i}`));
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', 'returns to your branch');
  assert.ok(existsSync(path.join(dir, 'force-app/main/default/objects/Account/fields/Tier_Legacy__c.field-meta.xml')), 'your working tree is untouched');
  await assert.rejects(createStoryBranches(dir, { base: 'dev', ids: IDS }), /already exists/);

  const noAgentia = new AgentiaClient({ bin: 'agentia-not-installed' });
  const fleet = createFleet({ workDir: tmp(), agentia: noAgentia, deny: ['claude-code', 'codex', 'cursor', 'copilot'] });
  const run = await startRun(fleet, { git: { repo: dir, base: 'dev', stories: IDS } }, noAgentia);
  assert.equal(run.risk!.decision, 'REVISE');
  const titles = run.simulation!.findings.map((f) => f.title);
  assert.ok(titles.some((t) => /ERP_Account_Sync writes CustomField:Account.Customer_Tier__c, but PermissionSet:Integration_User cannot edit it/.test(t)));
  assert.ok(titles.some((t) => /Flow:Legacy_Tier_Update still writes CustomField:Account.Tier_Legacy__c, which is deleted/.test(t)));
  assert.ok(titles.some((t) => /PermissionSet:Integration_User still has fieldPermissions:Account.Tier_Legacy__c/.test(t)));
  assert.deepEqual(run.schedule!.waves.map((w) => w.tasks), [[IDS[0]], IDS.slice(1)]);

  const fixed = await createStoryBranches(dir, { base: 'dev', ids: IDS, variant: 'revised', force: true });
  assert.equal(fixed.length, 5);
  const run2 = await startRun(fleet, { git: { repo: dir, base: 'dev', stories: IDS } }, noAgentia);
  assert.equal(run2.risk!.decision, 'APPLY');
});
