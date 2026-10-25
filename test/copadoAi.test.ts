// Copado AI (AI Context Hub MCP server) path: works without the Agentia CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopadoMcpClient, fillArgs, loadCopadoAiConfig, parseEnvFile, promotionRef, storyRecords } from '../src/copado/mcpClient.ts';
import { initRepo } from '../src/init.ts';
import { createStoryBranches, seedScenario } from '../src/scenario/scenario.ts';
import { createFleet } from '../src/core/fleet.ts';
import { startRun } from '../src/app.ts';
import { AgentiaClient } from '../src/agentia/client.ts';
import { startCopadoStub } from './stubs/copadoMcp.ts';
import { tmp } from './helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDS = ['US-0000301', 'US-0000302', 'US-0000303', 'US-0000304', 'US-0000305'];
const STORIES = IDS.map((name, i) => ({ name, id: `a0U00000000000${i}AAA`, title: `Story ${i + 1}` }));
const cfg = (url: string) => ({ url, pat: 'pat-123', orgId: '45333' });
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' }).toString();

function scenarioRepo(variant: 'original' | 'revised') {
  const dir = path.join(tmp(), 'repo');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '61.0' }));
  seedScenario(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'baseline');
  git(dir, 'branch', 'dev');
  return createStoryBranches(dir, { base: 'dev', ids: IDS, variant }).then(() => dir);
}

test('config: environment first, then .fleet/copado-ai.env; region picks the endpoint', () => {
  assert.deepEqual(parseEnvFile('# c\nexport COPADO_AI_PAT="abc"\nCOPADO_AI_ORG_ID=1\n'), { COPADO_AI_PAT: 'abc', COPADO_AI_ORG_ID: '1' });
  const dir = tmp();
  assert.match(loadCopadoAiConfig({}, dir).reason!, /COPADO_AI_PAT, COPADO_AI_ORG_ID/);
  mkdirSync(path.join(dir, '.fleet'));
  writeFileSync(path.join(dir, '.fleet', 'copado-ai.env'), 'COPADO_AI_PAT=file-pat\nCOPADO_AI_ORG_ID=7\nCOPADO_AI_REGION=eu\n');
  const c = loadCopadoAiConfig({ COPADO_AI_PAT: 'env-pat' }, dir).config!;
  assert.equal(c.pat, 'env-pat');
  assert.equal(c.orgId, '7');
  assert.equal(c.url, 'https://copadogpt-api.eu-robotic.copado.com/mcp/');
});

test('client: session, JSON and SSE responses, tool errors, bad credentials', async () => {
  const stub = await startCopadoStub({ stories: STORIES, sse: true, failTool: 'retrieve_knowledge' });
  try {
    const c = new CopadoMcpClient({ config: cfg(stub.url) });
    assert.equal((await c.available()).ok, true);
    const tools = await c.listTools();
    assert.ok(tools.some((t) => t.name === 'copado_cicd_promote_user_story'));
    const listed = storyRecords(await c.call('copado_cicd_list_user_stories', {}));
    assert.deepEqual(listed.map((s) => s.name), IDS);
    assert.equal(listed[0].id, STORIES[0].id);
    assert.equal(listed[0].title, 'Story 1');
    await assert.rejects(c.call('retrieve_knowledge', { query: 'x' }), /retrieve_knowledge failed: Promotion failed/);
    assert.ok(stub.calls.some((x) => x.method === 'notifications/initialized'));

    const bad = new CopadoMcpClient({ config: { ...cfg(stub.url), pat: 'wrong' } });
    const r = await bad.available();
    assert.equal(r.ok, false);
    assert.match(r.reason!, /HTTP 401.*personal access key/);
  } finally {
    await stub.close();
  }
});

test('fillArgs reads the schema and refuses to guess a required argument', () => {
  const tool = { name: 'copado_cicd_promote_user_story', inputSchema: { type: 'object', properties: { user_stories: { type: 'array' }, target_environment: { type: 'string' } }, required: ['user_stories', 'target_environment'] } };
  assert.throws(() => fillArgs(tool, [{ key: /^user_stories$/, value: 'a0U1' }]), /Can't fill copado_cicd_promote_user_story argument\(s\) target_environment/);
  assert.deepEqual(fillArgs({ ...tool, inputSchema: { ...tool.inputSchema, required: ['user_stories'] } }, [{ key: /^user_stories$/, value: 'a0U1' }]), { user_stories: ['a0U1'] });
  assert.equal(promotionRef({ success: true, promotion: { Id: 'a0P1', Name: 'P-000001' } }), 'a0P1');
  assert.equal(promotionRef('Created promotion P-000123 for US-1'), 'P-000123');
});

test('no Agentia: stories from Copado AI; validate and deploy through Copado AI only after the right approval', async () => {
  const dir = await scenarioRepo('revised');
  const stub = await startCopadoStub({ stories: [...STORIES, { name: 'US-0000999', id: 'a0U999', title: 'Not started locally' }] });
  try {
    const copadoAi = new CopadoMcpClient({ config: cfg(stub.url) });
    const noAgentia = new AgentiaClient({ bin: 'agentia-not-installed' });
    const fleet = createFleet({ workDir: tmp(), agentia: noAgentia, copadoAi, deny: ['claude-code', 'codex', 'cursor', 'copilot'] });

    const run = await startRun(fleet, { git: { repo: dir, base: 'dev', fromCopadoAi: true } }, noAgentia, copadoAi);
    assert.deepEqual(run.tasks.map((t) => t.id).sort(), IDS);
    assert.equal(run.tasks.find((t) => t.id === IDS[0])!.title, 'Story 1', 'title from Copado');
    assert.equal(run.risk!.decision, 'APPLY');

    fleet.approve(run.runId, 'Release Manager');
    await assert.rejects(fleet.execute(run.runId, { live: true, deploy: true }), /does not allow deployment/);
    assert.equal(stub.calls.filter((c) => c.tool === 'copado_cicd_promote_user_story').length, 0, 'nothing promoted without the right approval');

    // Validation: a promotion with a dry-run deployment.
    const validate = await fleet.execute(run.runId, { live: true });
    assert.ok(validate.results.every((r) => r.status === 'VALIDATED' && r.agent === 'copado-ai.delivery'), JSON.stringify(validate.results));
    const vcall = stub.calls.find((c) => c.tool === 'copado_cicd_promote_user_story')!;
    assert.equal(vcall.args!.deployment_dry_run, true);
    assert.equal(stub.calls.find((c) => c.tool === 'copado_cicd_list_user_stories' && c.args?.search_value)!.args!.search_field, 'Name');
    stub.calls.length = 0;

    // Dry-run preview names the Copado AI tools and sends nothing.
    fleet.approve(run.runId, 'Release Manager', { allowDeploy: true });
    const preview = await fleet.execute(run.runId, { deploy: true });
    assert.ok(preview.results.every((r) => r.status === 'DRY-RUN' && r.agent === 'copado-ai.delivery'));
    assert.equal(stub.calls.filter((c) => c.tool === 'copado_cicd_promote_user_story').length, 0);

    const live = await fleet.execute(run.runId, { live: true, deploy: true });
    assert.ok(live.results.every((r) => r.status === 'DEPLOYED'), JSON.stringify(live.results));
    const promotes = stub.calls.filter((c) => c.tool === 'copado_cicd_promote_user_story');
    assert.equal(promotes.length, 5);
    assert.deepEqual(promotes[0].args, { user_stories: [STORIES.find((s) => s.name === live.results[0].copadoStory)!.id], execute_promotion: true, execute_deployment: true, deployment_dry_run: false, is_back_promotion: false }, 'record id resolved from Copado; one chained call');
    assert.equal(stub.calls.filter((c) => c.tool === 'copado_cicd_deploy_promotion').length, 0);
    assert.equal(live.riskAfter?.decision, 'APPLY');
  } finally {
    await stub.close();
  }
});

test('a failed promotion stops the waves; no mock is substituted for a real failure', async () => {
  const dir = await scenarioRepo('revised');
  const stub = await startCopadoStub({ stories: STORIES, failTool: 'copado_cicd_deploy_promotion', legacy: true });
  try {
    const copadoAi = new CopadoMcpClient({ config: cfg(stub.url) });
    const noAgentia = new AgentiaClient({ bin: 'agentia-not-installed' });
    const fleet = createFleet({ workDir: tmp(), agentia: noAgentia, copadoAi, deny: ['claude-code', 'codex', 'cursor', 'copilot'] });
    const run = await startRun(fleet, { git: { repo: dir, base: 'dev', stories: IDS } }, noAgentia);
    fleet.approve(run.runId, 'RM', { allowDeploy: true });
    const live = await fleet.execute(run.runId, { live: true, deploy: true });
    assert.equal(live.results[0].status, 'FAILED');
    assert.ok(live.results.slice(1).every((r) => r.status === 'NOT-RUN'));
    assert.equal(stub.calls.filter((c) => c.tool === 'copado_cicd_promote_user_story').length, 1, 'write not retried');
  } finally {
    await stub.close();
  }
});

test('fleet init --copado-ai: server with header helper, write tools denied, git-ignored credentials', () => {
  const dir = path.join(tmp(), 'repo');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  const r = initRepo(dir, { agentia: false, copadoAi: true, copadoRegion: 'eu' });
  const mcp = JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers;
  assert.equal(mcp['copado-ai'].type, 'http');
  assert.equal(mcp['copado-ai'].url, 'https://copadogpt-api.eu-robotic.copado.com/mcp/');
  assert.match(mcp['copado-ai'].headersHelper, /copado headers --cwd/);
  assert.equal(mcp.fleet.env.COPADO_AI_ENV_FILE, path.join(dir, '.fleet', 'copado-ai.env'));
  const perms = JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).permissions;
  assert.ok(perms.allow.includes('mcp__copado-ai__copado_cicd_list_user_stories'));
  assert.ok(perms.deny.includes('mcp__copado-ai__copado_cicd_promote_user_story') && perms.deny.includes('mcp__copado-ai__copado_cicd_deploy_promotion'));
  assert.ok(!perms.allow.some((a: string) => /promote|deploy_promotion|commit/.test(a)));
  const envFile = r.copadoAiEnv!;
  assert.ok(existsSync(envFile));
  assert.equal(statSync(envFile).mode & 0o077, 0, 'credentials file is private');
  assert.match(readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.fleet\/$/m);

  // The header helper Claude Code runs:
  writeFileSync(envFile, 'COPADO_AI_PAT=pat-123\nCOPADO_AI_ORG_ID=45333\nCOPADO_AI_WORKSPACE_ID=e3345cd7-9ffe-4e8c-b934-14083b4bcd01\n');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.ts'), 'copado', 'headers', '--cwd', dir], { env: { ...process.env, COPADO_AI_PAT: '', COPADO_AI_ORG_ID: '' } }).toString();
  assert.deepEqual(JSON.parse(out), { 'X-Authorization': 'pat-123', 'X-Organization-Id': '45333', 'X-Workspace-Id': 'e3345cd7-9ffe-4e8c-b934-14083b4bcd01' });
  // Re-running init keeps the filled-in credentials.
  initRepo(dir, { agentia: false, copadoAi: true });
  assert.match(readFileSync(envFile, 'utf8'), /pat-123/);
});

test('a failed Agentia delivery never falls through to Copado AI (no second path to deploy)', async () => {
  const { AgentRegistry } = await import('../src/registry/registry.ts');
  const reg = new AgentRegistry();
  const calls: string[] = [];
  const writer = (id: string, preference: number, ok: boolean) => ({
    descriptor: { id, name: id, provider: 't', capabilities: ['deploy.promote' as const], mechanism: 'cli' as const, inputSchema: '', outputSchema: '', permissions: { write: true, deploy: true, network: true }, costTier: 'low' as const, latencyTier: 'low' as const, preference },
    isAvailable: async () => ({ ok: true }),
    execute: async () => { calls.push(id); return ok ? { ok: true, evidence: 'copado-deployment' as const } : { ok: false, evidence: 'none' as const, error: 'submit failed' }; },
  });
  reg.register(writer('agentia.delivery', 1, false));
  reg.register(writer('copado-ai.delivery', 2, true));
  const r = await reg.invoke('deploy.promote', {}, { runId: 'r', dryRun: false, approvalId: 'a', log: () => {} }, {});
  assert.equal(r.result.ok, false);
  assert.deepEqual(calls, ['agentia.delivery']);
});
