// agentia fleet check
//
// Simulates the story you are working on (the active Agentia work item) together with
// the other in-flight Copado stories, before you run `agentia cicd work submit`.
//
// Built on the documented plugin SDK surface only: AgentiaCommand, getAgentiaHost,
// host.work.getWorkItem() and host.format.table(). Plugins cannot call Copado or receive
// credentials, so the simulation itself runs in the `fleet` CLI, which talks to Copado
// through the Agentia CLI.

import { spawnSync } from 'node:child_process';
import { Flags } from '@oclif/core';
import { AgentiaCommand, getAgentiaHost } from '@copado/agentia-plugin-sdk';

interface FleetRun {
  runId: string;
  status: string;
  risk?: { decision: string; overall: string; decisionReason: string };
  schedule?: { waves: { index: number; tasks: string[] }[] };
  simulation?: { findings: { id: string; severity: string; title: string; mitigation?: string; stories: string[] }[] };
}

export default class FleetCheck extends AgentiaCommand {
  static override description = 'Simulate the active story together with other in-flight Copado stories before you submit';

  static override examples = ['agentia fleet check --base origin/main', 'agentia fleet check --base origin/uat --ai'];

  static override flags = {
    base: Flags.string({ description: 'Baseline ref (the next environment branch)', default: 'origin/main' }),
    'in-flight': Flags.boolean({ description: 'Include in-flight stories from Copado', default: true, allowNo: true }),
    ai: Flags.boolean({ description: 'Ask the Copado AI agents too', default: false }),
    'copado-impact': Flags.boolean({ description: 'Run the Copado dependency analyzer per branch', default: false }),
  };

  public async run() {
    const { flags } = await this.parse(FleetCheck);
    const host = getAgentiaHost();
    const story = (await host.work.getWorkItem()) as { name?: string; Name?: string } | undefined;
    const name = story?.name ?? story?.Name;
    if (!name) this.error('No active user story. Run `agentia cicd work set <story>` first.');

    const args = ['run', '--git', process.cwd(), '--base', flags.base, '--stories', name, '--json'];
    if (flags['in-flight']) args.push('--from-copado');
    if (flags.ai) args.push('--ai');
    if (flags['copado-impact']) args.push('--copado-impact');
    const r = spawnSync('fleet', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) this.error(`Could not start the fleet CLI (${r.error.message}). Install it and run \`npm link\` in its folder.`);
    if (r.status !== 0 && r.status !== 2) this.error(r.stderr || `fleet exited ${r.status}`);
    const run = JSON.parse(r.stdout) as FleetRun;

    const mine = (run.simulation?.findings ?? []).filter((f) => f.severity !== 'info');
    this.display(() => {
      this.log(`${run.risk?.decision ?? run.status} — ${run.risk?.decisionReason ?? ''}`);
      this.log(`Promotion order: ${(run.schedule?.waves ?? []).map((w) => `[${w.tasks.join(', ')}]`).join(' → ')}`);
      this.log(
        host.format.table(
          [
            { field: 'id', header: 'Finding' },
            { field: 'severity', header: 'Severity' },
            { field: 'title', header: 'What' },
            { field: 'stories', header: 'Stories' },
          ],
          mine.map((f) => ({ ...f, stories: f.stories.join(', ') })),
        ),
      );
      this.log(`Full report: fleet show ${run.runId}   ·   Approve (human): fleet approve ${run.runId} --by "<name>"`);
    });
    return { runId: run.runId, story: name, decision: run.risk?.decision, findings: mine };
  }
}
