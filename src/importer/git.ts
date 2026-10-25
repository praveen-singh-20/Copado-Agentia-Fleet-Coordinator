// Read a project as it exists at any Git ref, without touching the working tree.
// Uses `git archive` + `tar`, so the developer's checkout is never modified.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../adapters/exec.ts';
import { importSfdx, OVERLAY_FILE, type ImportResult } from './sfdx.ts';

export async function git(repo: string, args: string[]): Promise<string> {
  const r = await run('git', ['-C', repo, ...args], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

export async function revParse(repo: string, ref: string): Promise<string | undefined> {
  const r = await run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** First ref in the list that exists. */
export async function firstRef(repo: string, candidates: string[]): Promise<{ ref: string; sha: string } | undefined> {
  for (const ref of candidates) {
    const sha = await revParse(repo, ref);
    if (sha) return { ref, sha };
  }
  return undefined;
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string> {
  return git(repo, ['merge-base', a, b]);
}

const cache = new Map<string, ImportResult>();

/** Import the Salesforce project as of a commit. Results are cached per commit sha. */
export async function importAtRef(repo: string, sha: string, label: string): Promise<ImportResult> {
  const hit = cache.get(`${path.resolve(repo)}@${sha}`);
  if (hit) return structuredClone(hit);
  const top = (await git(repo, ['ls-tree', '--name-only', sha])).split('\n').filter(Boolean);
  // Only extract what the importer reads.
  let wanted: string[] = top.filter((p) => p === 'sfdx-project.json' || p === OVERLAY_FILE || p === 'force-app');
  if (top.includes('sfdx-project.json')) {
    const proj = JSON.parse(await git(repo, ['show', `${sha}:sfdx-project.json`])) as { packageDirectories?: { path: string }[] };
    for (const d of proj.packageDirectories ?? []) {
      const first = d.path.split(/[\\/]/)[0];
      if (top.includes(first) && !wanted.includes(first)) wanted.push(first);
    }
  }
  if (!wanted.length) wanted = top;
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-ref-'));
  try {
    const tar = path.join(dir, 'src.tar');
    await git(repo, ['archive', '--format=tar', '-o', tar, sha, '--', ...wanted]);
    const out = path.join(dir, 'tree');
    mkdirSync(out);
    const t = await run('tar', ['-xf', tar, '-C', out]);
    if (t.code !== 0) throw new Error(`tar failed: ${t.stderr}`);
    if (!existsSync(out)) throw new Error('extraction produced nothing');
    const result = importSfdx(out, { name: label, origin: `git ${path.basename(path.resolve(repo))}@${label} (${sha.slice(0, 10)})` });
    cache.set(`${path.resolve(repo)}@${sha}`, result);
    return structuredClone(result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
