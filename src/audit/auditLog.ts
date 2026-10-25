// Append-only, hash-chained audit log (JSON Lines). Each entry stores the hash of the
// previous one, so editing or deleting a past line breaks `verify()`.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  seq: number;
  at: string;
  runId: string;
  actor: string; // agent id, "coordinator" or "human:<name>"
  event: string;
  data?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

export function hashEntry(e: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify({ ...e })).digest('hex');
}

export class AuditLog {
  readonly file: string;
  private last: { seq: number; hash: string };
  private readonly clock: () => Date;

  constructor(file: string, clock: () => Date = () => new Date()) {
    this.file = file;
    this.clock = clock;
    mkdirSync(path.dirname(file), { recursive: true });
    const entries = AuditLog.read(file);
    const tail = entries.at(-1);
    this.last = tail ? { seq: tail.seq, hash: tail.hash } : { seq: 0, hash: GENESIS };
  }

  append(runId: string, actor: string, event: string, data?: Record<string, unknown>): AuditEntry {
    const base = {
      seq: this.last.seq + 1,
      at: this.clock().toISOString(),
      runId,
      actor,
      event,
      ...(data ? { data } : {}),
      prevHash: this.last.hash,
    };
    const entry: AuditEntry = { ...base, hash: hashEntry(base) };
    appendFileSync(this.file, JSON.stringify(entry) + '\n');
    this.last = { seq: entry.seq, hash: entry.hash };
    return entry;
  }

  static read(file: string): AuditEntry[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEntry);
  }

  static verify(file: string): { ok: boolean; entries: number; brokenAt?: number; reason?: string } {
    const entries = AuditLog.read(file);
    let prev = GENESIS;
    for (const e of entries) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prev) return { ok: false, entries: entries.length, brokenAt: e.seq, reason: 'prevHash does not match previous entry' };
      if (hashEntry(rest) !== hash) return { ok: false, entries: entries.length, brokenAt: e.seq, reason: 'entry content was modified' };
      prev = hash;
    }
    return { ok: true, entries: entries.length };
  }
}
