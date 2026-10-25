// fleet — command-line entry point. Run `fleet --help`.

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createFleet } from './core/fleet.ts';
import { AuditLog } from './audit/auditLog.ts';
import { AgentiaClient } from './agentia/client.ts';
import { importSfdx } from './importer/sfdx.ts';
import { startRun, summarize } from './app.ts';
import { initRepo } from './init.ts';
import { createStoryBranches, seedScenario } from './scenario/scenario.ts';
import { binaryAvailable } from './adapters/exec.ts';
import { COPADO_AI_REGIONS, CopadoMcpClient, ENV_FILE } from './copado/mcpClient.ts';
import { listStoriesViaCopadoAi } from './adapters/copadoAi.ts';
import { color, compareRuns, renderCompare, renderConflicts, renderExecution, renderTerminal } from './report/render.ts';

const HELP = `fleet — Agentia Fleet Coordinator + Simulation Engine

Plan & simulate
  fleet run --git <repo> --base <ref> [--stories US-1,US-2] [--from-copado | --from-copado-ai] [--copado-impact] [--ai] [--second-opinion]
  fleet run <stories.json> --snapshot <snapshot.json | force-app folder> [--ai]
  fleet show <runId>            fleet runs            fleet compare <runA> <runB>

Approve & execute (human only)
  fleet approve <runId> --by "<name>" [--accept-risk] [--allow-deploy] [--note "<text>"]
  fleet execute <runId> [--live] [--deploy] [--no-gates] [--publish] [--evidence] [--cwd <repo>]
  fleet conflicts <runId> --promotion <id> [--apply]

Set up your repository
  fleet init [<repo>] [--no-agentia] [--copado-ai [--copado-region us|eu|au|sg]]
                                               MCP config, skill and rules for Claude Code / Cursor
  fleet scenario seed [<repo>]                 write the sample baseline metadata into force-app
  fleet scenario stories [<repo>] --base <branch> --ids US-1,US-2,US-3,US-4,US-5 [--variant revised] [--force]
                                               one feature branch per Copado story, with the sample changes

Tools
  fleet agents                  which agents are available and what they may do
  fleet doctor                  check Node, git, Agentia CLI, Copado health, AI quota, Copado AI MCP
  fleet copado tools|stories    what the Copado AI MCP server exposes; its in-flight user stories
  fleet import <folder> [--out snapshot.json]
  fleet audit [--verify] [--run <runId>]
  fleet ui [--port 4600]        local web UI
  fleet mcp                     MCP server (stdio) for Claude Code / Cursor; has no approve tool

Global flags
  --work-dir <dir>   runs + audit (default .fleet)      --offline   no agents that leave this machine
  --deny <ids>       exclude agents                      --local-only  built-in agents only
  --json             machine-readable output
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      snapshot: { type: 'string' },
      git: { type: 'string' },
      base: { type: 'string' },
      stories: { type: 'string' },
      'from-copado': { type: 'boolean', default: false },
      'from-copado-ai': { type: 'boolean', default: false },
      'copado-ai': { type: 'boolean', default: false },
      'copado-region': { type: 'string' },
      'assigned-to-me': { type: 'boolean', default: false },
      'branch-pattern': { type: 'string' },
      'copado-impact': { type: 'boolean', default: false },
      ai: { type: 'boolean', default: false },
      'second-opinion': { type: 'boolean', default: false },
      review: { type: 'boolean', default: false },
      by: { type: 'string' },
      note: { type: 'string' },
      'accept-risk': { type: 'boolean', default: false },
      'allow-deploy': { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
      deploy: { type: 'boolean', default: false },
      'no-gates': { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      evidence: { type: 'boolean', default: false },
      cwd: { type: 'string' },
      promotion: { type: 'string' },
      apply: { type: 'boolean', default: false },
      out: { type: 'string' },
      verify: { type: 'boolean', default: false },
      run: { type: 'string' },
      port: { type: 'string', default: '4600' },
      'work-dir': { type: 'string', default: '.fleet' },
      offline: { type: 'boolean', default: false },
      deny: { type: 'string' },
      'local-only': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'no-agentia': { type: 'boolean', default: false },
      ids: { type: 'string' },
      variant: { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, arg, arg2] = positionals;
  if (!command || values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const workDir = values['work-dir']!;
  const agentia = new AgentiaClient();
  const fleet = createFleet({ workDir, offline: values.offline, deny: values.deny?.split(',').map((s) => s.trim()).filter(Boolean), localOnly: values['local-only'], agentia });
  const print = (obj: unknown, text: string) => console.log(values.json ? JSON.stringify(obj, null, 2) : text);
  const list = (s?: string) => s?.split(',').map((x) => x.trim()).filter(Boolean);

  switch (command) {
    case 'init': {
      const region = values['copado-region']?.toLowerCase();
      if (region && !COPADO_AI_REGIONS[region]) throw new Error(`--copado-region must be one of ${Object.keys(COPADO_AI_REGIONS).join(', ')}`);
      const r = initRepo(arg ?? '.', { agentia: !values['no-agentia'], copadoAi: values['copado-ai'] || !!region, copadoRegion: region });
      const servers = ['"fleet"', ...(values['no-agentia'] ? [] : ['"agentia"']), ...(values['copado-ai'] || region ? ['"copado-ai"'] : [])].join(', ');
      print(r, [`${color.green('✓')} ${r.repo} is ready for Claude Code`, ...r.changed.map((c) => `  wrote ${c}`), '', ...(r.copadoAiEnv ? [`Copado AI: put your personal access key and org id in ${r.copadoAiEnv} (git-ignored), then run: fleet doctor`, ''] : []), `Next: reload VS Code, open the Claude Code panel, approve the ${servers} MCP servers, then type /mcp to check.`].join('\n'));
      return 0;
    }

    case 'scenario': {
      const sub = arg;
      const repo = (sub === 'seed' || sub === 'stories') ? (arg2 ?? '.') : '.';
      if (sub === 'seed') {
        const r = seedScenario(repo);
        print(r, [`${color.green('✓')} wrote ${r.written.length} baseline files`, ...r.written.map((f) => `  ${f}`), '', 'Next: deploy them to every pipeline org (sf project deploy start --source-dir force-app --target-org <alias>),', 'commit to your production branch, then merge into the other environment branches.'].join('\n'));
        return 0;
      }
      if (sub === 'stories') {
        if (!values.base || !values.ids) throw new Error('Usage: fleet scenario stories [<repo>] --base <branch> --ids US-1,US-2,US-3,US-4,US-5');
        const r = await createStoryBranches(repo, { base: values.base, ids: list(values.ids)!, variant: values.variant === 'revised' ? 'revised' : 'original', pattern: values['branch-pattern'], force: values.force });
        print(r, [`${color.green('✓')} created ${r.length} story branches from ${values.base}`, ...r.map((b) => `  ${b.branch.padEnd(24)} ${b.commit}  ${b.title}`), '', `Next: git push origin ${r.map((b) => b.branch).join(' ')}`, `Then:  fleet run --git . --base ${values.base} --stories ${r.map((b) => b.story).join(',')}`].join('\n'));
        return 0;
      }
      throw new Error('Usage: fleet scenario seed | fleet scenario stories --base <branch> --ids …');
    }

    case 'agents': {
      const agents = await fleet.registry.discover();
      const lines = agents.map(
        (a) =>
          `${a.availability.ok ? color.green('●') : color.dim('○')} ${a.id.padEnd(20)} ${a.provider.padEnd(16)} ${a.capabilities.join(', ').slice(0, 60).padEnd(60)} ` +
          `${a.mock ? color.yellow('MOCK ') : ''}${a.permissions.deploy ? color.red('deploy ') : a.permissions.write ? color.yellow('write ') : ''}${a.permissions.network ? 'network' : 'local'}` +
          (a.availability.ok ? '' : color.dim(`  (${a.availability.reason})`)),
      );
      print(agents, [color.bold('Registered agents'), ...lines].join('\n'));
      return 0;
    }

    case 'doctor': {
      const checks: { check: string; ok: boolean; detail: string }[] = [];
      const [maj, min] = process.versions.node.split('.').map(Number);
      checks.push({ check: 'Node.js ≥ 22.18', ok: maj > 22 || (maj === 22 && min >= 18), detail: process.version });
      const g = await binaryAvailable('git');
      checks.push({ check: 'git', ok: g.ok, detail: g.version ?? g.reason ?? '' });
      const sf = await binaryAvailable('sf');
      checks.push({ check: 'Salesforce CLI (optional)', ok: sf.ok, detail: sf.version ?? sf.reason ?? '' });
      const v = await agentia.version();
      checks.push({ check: 'Agentia CLI (needed for Copado actions)', ok: v.ok, detail: v.version ?? `${v.reason}. Simulation still works; Copado steps run as MOCK until Agentia is set up (npm install -g @copado/agentia-cli@beta, then agentia setup)` });
      if (v.ok) {
        for (const [name, fn] of [['Copado health check (agentia cicd health-check)', () => agentia.healthCheck()], ['Copado AI quota (agentia ai quota get)', () => agentia.aiQuota()]] as const) {
          try {
            const r = await fn();
            checks.push({ check: name, ok: true, detail: JSON.stringify(r).slice(0, 160) });
          } catch (e) {
            checks.push({ check: name, ok: false, detail: `${(e as Error).message.slice(0, 200)} — run agentia setup` });
          }
        }
      }
      const cai = new CopadoMcpClient();
      const ca = await cai.available();
      checks.push({ check: 'Copado AI MCP (optional; stories + deploy without Agentia)', ok: ca.ok, detail: ca.version ?? `${ca.reason}${cai.configured ? '' : ` (template: ${ENV_FILE})`}` });
      for (const agent of (await fleet.registry.discover()).filter((a) => a.mechanism === 'cli' && !a.id.startsWith('agentia'))) {
        checks.push({ check: `${agent.name} (optional)`, ok: agent.availability.ok, detail: agent.availability.reason ?? 'available' });
      }
      print(checks, checks.map((c) => `${c.ok ? color.green('✓') : c.check.includes('optional') ? color.dim('○') : color.red('✗')} ${c.check.padEnd(50)} ${color.dim(c.detail)}`).join('\n'));
      return checks.filter((c) => !c.ok && !c.check.includes('optional')).length ? 1 : 0;
    }

    case 'copado': {
      const client = new CopadoMcpClient({ cwd: values.cwd ?? process.cwd() });
      if (!client.configured) throw new Error(client.reason!);
      if (arg === 'headers') {
        // Claude Code's headersHelper for the "copado-ai" MCP server: JSON headers on stdout.
        const c = client.config!;
        process.stdout.write(JSON.stringify({ 'X-Authorization': c.pat, 'X-Organization-Id': c.orgId, ...(c.workspaceId ? { 'X-Workspace-Id': c.workspaceId } : {}) }));
        return 0;
      }
      if (arg === 'tools') {
        const tools = await client.listTools();
        print(tools, tools.map((t) => `${t.name.padEnd(44)} ${color.dim(Object.keys(t.inputSchema?.properties ?? {}).map((k) => (t.inputSchema?.required ?? []).includes(k) ? `${k}*` : k).join(', '))}`).join('\n') + `\n${color.dim(`${tools.length} tools; * = required`)}`);
        return 0;
      }
      if (arg === 'stories') {
        const s = await listStoriesViaCopadoAi(client);
        print(s, s.map((x) => `${x.name.padEnd(12)} ${x.title ?? ''}`).join('\n') || 'No user stories returned.');
        return 0;
      }
      throw new Error('Usage: fleet copado tools | fleet copado stories');
    }

    case 'import': {
      if (!arg) throw new Error('Usage: fleet import <project folder> [--out snapshot.json]');
      const r = importSfdx(arg);
      if (values.out) writeFileSync(values.out, JSON.stringify(r.snapshot, null, 2));
      const bySource = r.snapshot.dependencies.reduce<Record<string, number>>((m, d) => ((m[d.source] = (m[d.source] ?? 0) + 1), m), {});
      print(r, [`Imported ${r.snapshot.components.length} components, ${r.snapshot.dependencies.length} dependencies (${Object.entries(bySource).map(([k, v]) => `${k}: ${v}`).join(', ')})`, ...r.warnings.map((w) => color.yellow(`  ! ${w}`)), r.skipped.length ? color.dim(`  ${r.skipped.length} file(s) skipped (types not modeled yet)`) : '', values.out ? `Saved ${values.out}` : color.dim('  (use --out <file> to save)')].filter(Boolean).join('\n'));
      return 0;
    }

    case 'run': {
      const run = await startRun(
        fleet,
        values.git
          ? { git: { repo: values.git, base: values.base ?? 'origin/main', stories: list(values.stories), fromCopado: values['from-copado'], fromCopadoAi: values['from-copado-ai'], assignedToMe: values['assigned-to-me'], branchPattern: values['branch-pattern'], copadoImpact: values['copado-impact'] }, ai: values.ai || values.review, secondOpinion: values['second-opinion'] }
          : { stories: arg, snapshot: values.snapshot, ai: values.ai || values.review, secondOpinion: values['second-opinion'] },
        agentia,
      );
      print(run, renderTerminal(run) + '\n' + color.dim(`\n  Saved: ${path.join(workDir, 'runs', run.runId)}/{run.json,report.md}`));
      return run.status === 'needs-human' ? 2 : 0;
    }

    case 'show': {
      if (!arg) throw new Error('Usage: fleet show <runId>');
      const run = fleet.loadRun(arg);
      print(run, values.json ? '' : renderTerminal(run));
      return 0;
    }

    case 'runs': {
      const dir = path.join(workDir, 'runs');
      const ids = existsSync(dir) ? readdirSync(dir).sort() : [];
      const rows = ids.map((id) => {
        const r = fleet.loadRun(id);
        return { runId: id, batch: r.batch, status: r.status, decision: r.risk?.decision ?? '—', approved: !!fleet.loadApproval(id) };
      });
      print(rows, rows.map((r) => `${r.runId}  ${r.decision.padEnd(7)} ${r.status.padEnd(18)} ${r.approved ? color.green('approved') : '        '}  ${r.batch}`).join('\n') || 'No runs yet.');
      return 0;
    }

    case 'compare': {
      if (!arg || !arg2) throw new Error('Usage: fleet compare <runA> <runB>');
      const cmp = compareRuns(fleet.loadRun(arg), fleet.loadRun(arg2));
      print(cmp, renderCompare(cmp));
      return 0;
    }

    case 'approve': {
      if (!arg) throw new Error('Usage: fleet approve <runId> --by "<name>"');
      const a = fleet.approve(arg, values.by ?? '', { note: values.note, acceptRisk: values['accept-risk'], allowDeploy: values['allow-deploy'], channel: 'cli' });
      print(a, `${color.green('✓ Approved')} ${arg} by ${a.by} (${a.approvalId})${a.allowDeploy ? color.yellow('  — deployment to the next environment allowed') : ''}\n  Plan hash ${a.planHash.slice(0, 16)}… — any change to the plan voids this approval.\n  Next: fleet execute ${arg}           (dry-run: shows the Agentia commands)\n        fleet execute ${arg} --live    (Copado validation via Agentia)${a.allowDeploy ? `\n        fleet execute ${arg} --live --deploy` : ''}`);
      return 0;
    }

    case 'execute': {
      if (!arg) throw new Error('Usage: fleet execute <runId> [--live] [--deploy]');
      const exec = await fleet.execute(arg, { live: values.live, deploy: values.deploy, cwd: values.cwd, gates: !values['no-gates'], publish: values.publish, evidence: values.evidence });
      print(exec, renderExecution(exec));
      return exec.results.some((r) => r.status === 'FAILED') ? 1 : 0;
    }

    case 'conflicts': {
      if (!arg || !values.promotion) throw new Error('Usage: fleet conflicts <runId> --promotion <promotion-id> [--apply]');
      const r = await fleet.conflicts(arg, values.promotion, { apply: values.apply });
      print(r, renderConflicts(values.promotion, r.decisions, r.resumeHint, values.apply));
      return 0;
    }

    case 'audit': {
      const file = path.join(workDir, 'audit.jsonl');
      if (values.verify) {
        const v = AuditLog.verify(file);
        print(v, v.ok ? `${color.green('✓ Audit chain intact')} (${v.entries} entries)` : `${color.red('✗ Audit chain broken')} at entry ${v.brokenAt}: ${v.reason}`);
        return v.ok ? 0 : 1;
      }
      const entries = AuditLog.read(file).filter((e) => !values.run || e.runId === values.run);
      print(entries, entries.map((e) => `${color.dim(e.at)} ${e.runId} ${e.actor.padEnd(16)} ${color.bold(e.event)} ${color.dim(JSON.stringify(e.data ?? {}).slice(0, 140))}`).join('\n') || 'Audit log is empty.');
      return 0;
    }

    case 'ui': {
      const { startUi } = await import('./ui/server.ts');
      const { url } = await startUi(fleet, { port: Number(values.port), agentia });
      console.log(`Fleet UI on ${color.bold(url)}  (local only; Ctrl+C to stop)`);
      await new Promise(() => {});
      return 0;
    }

    case 'mcp': {
      const { startMcp } = await import('./mcp/server.ts');
      await startMcp(fleet, agentia);
      return 0;
    }

    case 'summary': {
      if (!arg) throw new Error('Usage: fleet summary <runId>');
      console.log(summarize(fleet.loadRun(arg)));
      return 0;
    }

    default:
      process.stdout.write(HELP);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (err: Error) => {
    console.error(color.red(`Error: ${err.message}`));
    process.exitCode = 1;
  },
);
