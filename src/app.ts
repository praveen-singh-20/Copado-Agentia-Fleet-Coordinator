// Shared entry points used by the CLI, the MCP server and the web UI, so all three
// behave identically.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MetadataSnapshot, TaskBatch } from './core/types.ts';
import type { FleetCoordinator, RunRecord } from './coordinator/coordinator.ts';
import { importSfdx } from './importer/sfdx.ts';
import { loadFromGit } from './sources/gitSource.ts';
import { AgentiaClient } from './agentia/client.ts';
import { CopadoMcpClient } from './copado/mcpClient.ts';
import { renderMarkdown } from './report/render.ts';

export interface StartRunParams {
  /** Path to a stories JSON file (with --snapshot). */
  stories?: string;
  /** Snapshot JSON file, or a Salesforce project folder to import. */
  snapshot?: string;
  git?: {
    repo: string;
    base: string;
    stories?: string[];
    fromCopado?: boolean;
    /** In-flight stories from Copado AI's MCP server. */
    fromCopadoAi?: boolean;
    assignedToMe?: boolean;
    branchPattern?: string;
    /** Also run the Copado dependency analyzer on each story branch. */
    copadoImpact?: boolean;
  };
  ai?: boolean;
  secondOpinion?: boolean;
}

export function readJson<T>(file: string): T {
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
}

export function loadSnapshot(p: string): MetadataSnapshot {
  if (!existsSync(p)) throw new Error(`Snapshot not found: ${p}`);
  if (statSync(p).isDirectory()) return importSfdx(p).snapshot;
  return readJson<MetadataSnapshot>(p);
}

export async function startRun(fleet: FleetCoordinator, p: StartRunParams, agentia = new AgentiaClient(), copadoAi?: CopadoMcpClient): Promise<RunRecord> {
  let run: RunRecord;
  if (p.git) {
    const g = p.git;
    const src = await loadFromGit({ repo: g.repo, base: g.base, stories: g.stories, fromCopado: g.fromCopado, assignedToMe: g.assignedToMe, branchPattern: g.branchPattern, client: agentia, fromCopadoAi: g.fromCopadoAi, copadoAi: g.fromCopadoAi ? (copadoAi ?? new CopadoMcpClient({ cwd: g.repo })) : undefined });
    run = await fleet.run(src.batch, src.snapshot, {
      ai: p.ai,
      secondOpinion: p.secondOpinion,
      notes: src.notes,
      source: { kind: 'git', repo: path.resolve(g.repo), base: g.base, baseSha: src.baseSha },
      ...(g.copadoImpact ? { externalImpact: { repo: g.repo, baseRef: src.baseSha } } : {}),
    });
  } else {
    if (!p.stories) throw new Error('Give a stories file (with --snapshot) or --git <repo> --base <ref>');
    if (!p.snapshot) throw new Error('--snapshot <file or force-app folder> is required with a stories file');
    const batch = readJson<TaskBatch>(p.stories);
    if (!Array.isArray(batch.tasks)) throw new Error(`${p.stories} must contain a "tasks" array`);
    run = await fleet.run({ name: batch.name ?? path.basename(p.stories), tasks: batch.tasks }, loadSnapshot(p.snapshot), { ai: p.ai, secondOpinion: p.secondOpinion, source: { kind: 'file' } });
  }
  writeFileSync(path.join(fleet.runDir(run.runId), 'report.md'), renderMarkdown(run));
  return run;
}

/** Short text summary for MCP clients and logs. */
export function summarize(run: RunRecord): string {
  if (run.intakeIssues.length) return `Run ${run.runId}: NEEDS HUMAN INPUT\n${run.intakeIssues.map((i) => `- ${i.task}: ${i.issues.join('; ')}`).join('\n')}`;
  const r = run.risk!;
  const top = [...run.simulation!.findings].filter((f) => f.severity !== 'info').sort((a, b) => ['blocker', 'high', 'medium', 'low'].indexOf(a.severity) - ['blocker', 'high', 'medium', 'low'].indexOf(b.severity));
  return [
    `Run ${run.runId}: ${r.decision} (overall risk ${r.overall}). ${r.decisionReason}`,
    `Waves: ${run.schedule!.waves.map((w) => `[${w.tasks.join(', ')}]`).join(' → ')}`,
    `Findings (${top.length}):`,
    ...top.slice(0, 12).map((f) => `- ${f.id} [${f.severity}] ${f.title}${f.mitigation ? ` — fix: ${f.mitigation}` : ''}`),
    top.length > 12 ? `- … ${top.length - 12} more in .fleet/runs/${run.runId}/report.md` : '',
    run.status === 'awaiting-approval' ? `Next: a human runs \`fleet approve ${run.runId} --by "<name>"\`.` : run.status === 'revise' ? 'Next: fix the stories and run again.' : run.status === 'rejected' ? 'This batch cannot be approved as is.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}
