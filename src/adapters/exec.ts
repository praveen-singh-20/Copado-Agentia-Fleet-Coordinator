// Small, safe wrapper for running external CLIs (agentia, claude, codex, cursor-agent, copilot).
// No shell: arguments go straight to the binary, so story text cannot inject commands.
// Credentials are never passed in; each CLI uses the auth it already stored.

import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function run(cmd: string, args: string[], opts: { timeoutMs?: number; cwd?: string; input?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: (e as Error).message, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** True when the binary starts and answers `--version` (or the given probe args). */
export async function binaryAvailable(cmd: string, probe: string[] = ['--version']): Promise<{ ok: boolean; reason?: string; version?: string }> {
  const r = await run(cmd, probe, { timeoutMs: 15_000 });
  if (r.code === 0) return { ok: true, version: r.stdout.trim().split('\n')[0] };
  return { ok: false, reason: r.code === -1 ? `${cmd} not found on PATH` : `${cmd} ${probe.join(' ')} exited ${r.code}` };
}

/** Every JSON value in the output: the whole document, or each JSON line (JSONL streams). */
export function parseAllJson(stdout: string): unknown[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    const out: unknown[] = [];
    for (const l of text.split('\n')) {
      try {
        out.push(JSON.parse(l));
      } catch {
        /* not JSON */
      }
    }
    if (!out.length) out.push(text); // plain text: let callers search inside it
    return out;
  }
}

/**
 * Find the first object that has `key`, searching nested objects, arrays, and JSON
 * embedded inside string values (models often return JSON inside a "result" string).
 */
export function deepFind(values: unknown[], key: string): Record<string, unknown> | undefined {
  const tryParse = (s: string): unknown => {
    const t = s.trim();
    for (const candidate of [t, t.replace(/^```(?:json)?\s*|\s*```$/g, '')]) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* next */
      }
    }
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  const queue: unknown[] = [...values];
  let guard = 0;
  while (queue.length && guard++ < 10_000) {
    const v = queue.shift();
    if (typeof v === 'string') {
      const p = tryParse(v);
      if (p !== undefined && typeof p === 'object') queue.push(p);
    } else if (Array.isArray(v)) queue.push(...v);
    else if (v && typeof v === 'object') {
      if (key in v) return v as Record<string, unknown>;
      queue.push(...Object.values(v));
    }
  }
  return undefined;
}

/**
 * Parse JSON from CLI output. Handles a single JSON document, or JSON Lines where
 * the last parseable line wins (codex --json, stream formats).
 */
export function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) throw new Error('empty output');
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split('\n').reverse();
    for (const l of lines) {
      try {
        return JSON.parse(l);
      } catch {
        /* keep looking */
      }
    }
    // Last resort: first {...} block in the text.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('no JSON found in output');
  }
}
