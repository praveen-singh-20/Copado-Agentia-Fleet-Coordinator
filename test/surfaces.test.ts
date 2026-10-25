import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFleet } from '../src/core/fleet.ts';
import { fleetTools, handleMessage } from '../src/mcp/server.ts';
import { startUi } from '../src/ui/server.ts';
import { startRun } from '../src/app.ts';
import { tmp } from './helpers.ts';

const files = { stories: 'fixtures/stories-revised.json', snapshot: 'fixtures/snapshot.json' };

test('MCP: initialize, list tools (no approve/deploy tool), call a simulation', async () => {
  const fleet = createFleet({ workDir: tmp(), localOnly: true });
  const tools = fleetTools(fleet);
  const init = await handleMessage(tools, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal((init!.result as { serverInfo: { name: string } }).serverInfo.name, 'agentia-fleet');
  assert.equal(await handleMessage(tools, { method: 'notifications/initialized' }), undefined);
  const list = (await handleMessage(tools, { id: 2, method: 'tools/list' }))!.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
  const names = list.tools.map((t) => t.name);
  assert.ok(names.includes('fleet_simulate_branches'));
  assert.ok(!names.some((n) => /approve|deploy|resolve|live/.test(n)), 'human-only actions are not tools');
  assert.ok(list.tools.every((t) => t.annotations.readOnlyHint));
  const call = (await handleMessage(tools, { id: 3, method: 'tools/call', params: { name: 'fleet_simulate_file', arguments: files } }))!.result as { content: { text: string }[] };
  assert.match(call.content[0].text, /APPLY/);
  const bad = (await handleMessage(tools, { id: 4, method: 'tools/call', params: { name: 'fleet_report', arguments: {} } }))!.result as { isError: boolean };
  assert.equal(bad.isError, true);
  const unknown = await handleMessage(tools, { id: 5, method: 'nope' });
  assert.equal((unknown!.error as { code: number }).code, -32601);
});

test('web UI: serves the page, lists runs, guards POSTs, approves', async () => {
  const fleet = createFleet({ workDir: tmp(), localOnly: true });
  const run = await startRun(fleet, files);
  const { server, url } = await startUi(fleet, { port: 0 });
  try {
    const page = await fetch(url + '/');
    assert.match(await page.text(), /Fleet Control/);
    const runs = (await (await fetch(url + '/api/runs')).json()) as { runId: string }[];
    assert.equal(runs[0].runId, run.runId);
    const forged = await fetch(`${url}/api/runs/${run.runId}/approve`, { method: 'POST', body: JSON.stringify({ by: 'x' }) });
    assert.equal(forged.status, 403, 'plain cross-site POST rejected');
    const ok = await fetch(`${url}/api/runs/${run.runId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fleet': '1' }, body: JSON.stringify({ by: 'Praveen' }) });
    assert.equal(ok.status, 200);
    const detail = (await (await fetch(`${url}/api/runs/${run.runId}`)).json()) as { approval: { by: string } };
    assert.equal(detail.approval.by, 'Praveen');
    const audit = (await (await fetch(`${url}/api/audit?run=${run.runId}`)).json()) as { actor: string }[];
    assert.ok(audit.some((e) => e.actor === 'human:Praveen (web ui)'));
  } finally {
    server.close();
  }
});
