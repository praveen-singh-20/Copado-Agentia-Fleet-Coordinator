// Build a run's input from real work instead of a hand-written JSON file:
//   - the baseline is the Salesforce project at the base ref (e.g. origin/main or the UAT branch)
//   - each story's proposed changes are the diff of its Copado feature branch
//   - the list of stories can come straight from Copado (`agentia cicd work list`)

import path from 'node:path';
import type { MetadataSnapshot, TaskBatch, TaskInput } from '../core/types.ts';
import { AgentiaClient, extractStoryNames, findField } from '../agentia/client.ts';
import { diffToChanges } from '../importer/diff.ts';
import { firstRef, git, importAtRef, mergeBase } from '../importer/git.ts';
import { pool } from '../coordinator/pool.ts';
import type { CopadoMcpClient } from '../copado/mcpClient.ts';
import { listStoriesViaCopadoAi } from '../adapters/copadoAi.ts';

export interface GitSourceOptions {
  repo: string;
  /** Baseline ref, e.g. "origin/main" or the branch of the next environment. */
  base: string;
  /** Explicit Copado story names. */
  stories?: string[];
  /** Also pull in-flight stories from Copado. */
  fromCopado?: boolean;
  assignedToMe?: boolean;
  /** Branch name pattern; {story} is replaced. Copado's local flow uses feature/<story-name>. */
  branchPattern?: string;
  client?: AgentiaClient;
  /** Pull in-flight stories from Copado AI's MCP server (works without the Agentia CLI). */
  fromCopadoAi?: boolean;
  copadoAi?: CopadoMcpClient;
}

export interface SourceNote {
  story: string;
  level: 'info' | 'warning';
  message: string;
}

export interface GitSourceResult {
  batch: TaskBatch;
  snapshot: MetadataSnapshot;
  notes: SourceNote[];
  baseSha: string;
}

export async function loadFromGit(opts: GitSourceOptions): Promise<GitSourceResult> {
  const notes: SourceNote[] = [];
  const pattern = opts.branchPattern ?? 'feature/{story}';
  const base = await firstRef(opts.repo, [opts.base]);
  if (!base) throw new Error(`Base ref "${opts.base}" not found in ${opts.repo}`);

  let names = [...(opts.stories ?? [])];
  const titles = new Map<string, string>();
  if (opts.fromCopado) {
    const client = opts.client ?? new AgentiaClient();
    const listed = extractStoryNames(await client.workList({ assignedToMe: opts.assignedToMe }));
    notes.push({ story: '*', level: 'info', message: `Copado returned ${listed.length} in-flight stor${listed.length === 1 ? 'y' : 'ies'} (agentia cicd work list)` });
    names = [...new Set([...names, ...listed])];
    await pool(names, 4, async (s) => {
      try {
        const t = findField(await client.workGet(s), ['title', 'userStoryTitle', 'copado__User_Story_Title__c', 'subject']);
        if (t) titles.set(s, t);
      } catch {
        /* title is optional */
      }
    });
  }
  if (opts.fromCopadoAi) {
    if (!opts.copadoAi) throw new Error('--from-copado-ai needs a Copado AI MCP client');
    const listed = await listStoriesViaCopadoAi(opts.copadoAi);
    notes.push({ story: '*', level: 'info', message: `Copado AI returned ${listed.length} user stor${listed.length === 1 ? 'y' : 'ies'} (copado_cicd_list_user_stories); stories without a local branch are skipped` });
    for (const s of listed) if (s.title && !titles.has(s.name)) titles.set(s.name, s.title);
    names = [...new Set([...names, ...listed.map((s) => s.name)])];
  }
  if (!names.length) throw new Error('No stories: pass --stories US-1,US-2, --from-copado or --from-copado-ai');

  const baseImport = await importAtRef(opts.repo, base.sha, opts.base);
  for (const w of baseImport.warnings) notes.push({ story: '*', level: 'warning', message: w });
  if (baseImport.skipped.length) notes.push({ story: '*', level: 'info', message: `${baseImport.skipped.length} metadata file(s) of types not modeled yet were skipped` });

  const tasks: TaskInput[] = [];
  for (const story of names) {
    const branchName = pattern.replace('{story}', story);
    const branch = await firstRef(opts.repo, [`origin/${branchName}`, branchName]);
    if (!branch) {
      notes.push({ story, level: 'warning', message: `no branch ${branchName} (story not started locally?) — skipped` });
      continue;
    }
    const mb = await mergeBase(opts.repo, base.sha, branch.sha);
    const before = mb === base.sha ? baseImport : await importAtRef(opts.repo, mb, `${story}@merge-base`);
    const after = await importAtRef(opts.repo, branch.sha, branch.ref);
    const changes = diffToChanges(before.snapshot, after.snapshot);
    if (!changes.length) {
      notes.push({ story, level: 'info', message: `${branch.ref} has no metadata changes against ${opts.base} — skipped` });
      continue;
    }
    const behind = mb !== base.sha;
    if (behind) notes.push({ story, level: 'warning', message: `${branch.ref} is behind ${opts.base}; run agentia cicd work environment-sync before submit` });
    // Title: Copado's, else the branch's latest commit subject (minus a leading "US-…:").
    let title = titles.get(story);
    if (!title) {
      const subject = await git(opts.repo, ['log', '-1', '--format=%s', branch.sha]).catch(() => '');
      const t = subject.replace(new RegExp(`^${story.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:\\-–]\\s*`), '').trim();
      if (t && !/^(merge|wip)\b/i.test(t)) title = t;
    }
    tasks.push({
      id: story,
      title: title ?? story,
      copadoStory: story,
      changes,
      source: { branch: branch.ref, commit: branch.sha, mergeBase: mb, behindBase: behind },
    });
  }

  return {
    batch: { name: `${path.basename(path.resolve(opts.repo))}: ${tasks.map((t) => t.id).join(', ') || 'no stories'} vs ${opts.base}`, tasks },
    snapshot: baseImport.snapshot,
    notes,
    baseSha: base.sha,
  };
}
