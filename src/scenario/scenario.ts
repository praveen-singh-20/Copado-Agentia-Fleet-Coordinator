// Put the sample scenario into YOUR repository:
//   seed:    write the baseline files into the working tree (you deploy + commit them)
//   stories: create one local feature branch per Copado story, each with that story's change

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git, revParse } from '../importer/git.ts';
import { BASELINE, stories, type Files } from './files.ts';

function write(repo: string, files: Files): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(repo, rel);
    if (content === null) {
      if (existsSync(p)) {
        rmSync(p);
        removed.push(rel);
      }
    } else {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
      written.push(rel);
    }
  }
  return { written, removed };
}

function checkSfdx(repo: string) {
  const proj = path.join(repo, 'sfdx-project.json');
  if (!existsSync(proj)) throw new Error(`${repo} has no sfdx-project.json. Run this in your Salesforce DX repository.`);
  const dirs = (JSON.parse(readFileSync(proj, 'utf8')).packageDirectories ?? []) as { path: string }[];
  if (!dirs.some((d) => d.path.replace(/\/$/, '') === 'force-app')) {
    throw new Error('sfdx-project.json has no "force-app" package directory; the scenario writes to force-app/main/default.');
  }
}

/** Write the baseline into the working tree. Existing files with the same paths are overwritten. */
export function seedScenario(repo: string): { written: string[] } {
  checkSfdx(repo);
  return { written: write(repo, BASELINE).written };
}

export interface StoryBranchResult {
  story: string;
  title: string;
  branch: string;
  commit: string;
}

/**
 * Create feature/<story> for each Copado story ID, from `base`, with that story's change committed.
 * Your current branch and working tree are left as they were. Refuses if the tree has changes.
 */
export async function createStoryBranches(repo: string, opts: { base: string; ids: string[]; variant?: 'original' | 'revised'; pattern?: string; force?: boolean }): Promise<StoryBranchResult[]> {
  checkSfdx(repo);
  const specs = stories(opts.variant);
  if (opts.ids.length !== specs.length) throw new Error(`Give exactly ${specs.length} story IDs, in this order: ${specs.map((s) => s.title).join(' | ')}`);
  if (!(await revParse(repo, opts.base))) throw new Error(`Base branch "${opts.base}" not found. Run git fetch, or pass the right --base.`);
  const status = await git(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (status) throw new Error('Your working tree has uncommitted changes. Commit or stash them first.');
  const startRef = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';
  const pattern = opts.pattern ?? 'feature/{story}';
  const out: StoryBranchResult[] = [];
  try {
    for (let i = 0; i < specs.length; i++) {
      const id = opts.ids[i].trim();
      const branch = pattern.replace('{story}', id);
      if ((await revParse(repo, branch)) && !opts.force) throw new Error(`Branch ${branch} already exists. Delete it or pass --force.`);
      await git(repo, ['checkout', '-q', '-B', branch, opts.base]);
      const { written, removed } = write(repo, specs[i].files);
      if (written.length) await git(repo, ['add', '--', ...written]);
      if (removed.length) await git(repo, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...removed]);
      await git(repo, ['-c', 'user.name=Fleet Scenario', '-c', 'user.email=fleet-scenario@example.invalid', 'commit', '-q', '-m', `${id}: ${specs[i].title}`]);
      out.push({ story: id, title: specs[i].title, branch, commit: (await git(repo, ['rev-parse', 'HEAD'])).slice(0, 10) });
    }
  } finally {
    await git(repo, ['checkout', '-q', startRef]).catch(() => undefined);
  }
  return out;
}
