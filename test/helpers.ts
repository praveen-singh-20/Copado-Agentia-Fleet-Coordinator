import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MetadataSnapshot, TaskBatch } from '../src/core/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const load = <T>(rel: string): T => JSON.parse(readFileSync(path.join(root, rel), 'utf8')) as T;
export const snapshot = () => load<MetadataSnapshot>('fixtures/snapshot.json');
export const original = () => load<TaskBatch>('fixtures/stories.json');
export const revised = () => load<TaskBatch>('fixtures/stories-revised.json');
export const rejectBatch = () => load<TaskBatch>('fixtures/story-reject.json');
export const tmp = () => mkdtempSync(path.join(tmpdir(), 'fleet-test-'));

// ---------- Agentia stub + sample repo helpers ----------
import { writeFileSync as _w } from 'node:fs';
import { makeSampleRepo } from '../scripts/make-sample-repo.ts';
import { AgentiaClient } from '../src/agentia/client.ts';

export const STUB = path.join(root, 'test', 'stubs', 'agentia.mjs');
export const STORIES = ['US-0000101', 'US-0000102', 'US-0000103', 'US-0000104', 'US-0000105'];

export function sampleRepo(variant: 'original' | 'revised' = 'original') {
  return makeSampleRepo(path.join(tmp(), 'repo'), variant);
}

/** Configure the stub for this process (children inherit env) and return a client + log reader. */
export function stub(responses: Record<string, unknown>[] = []) {
  const dir = tmp();
  const log = path.join(dir, 'calls.jsonl');
  const scenario = path.join(dir, 'scenario.json');
  _w(scenario, JSON.stringify({ responses }));
  process.env.AGENTIA_STUB_LOG = log;
  process.env.AGENTIA_STUB_SCENARIO = scenario;
  process.env.AGENTIA_STUB_STATE = path.join(dir, 'state');
  const client = new AgentiaClient({ bin: STUB });
  const calls = (): { args: string[]; cwd: string }[] => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { client, calls, cmd: (c: { args: string[] }) => c.args.filter((a) => a !== '--json').join(' ') };
}

/** Copado AI answer in the envelope shape the stub returns (model text inside a JSON string). */
export const aiAnswer = (agent: string, payload: unknown) => ({ match: ['ai', 'agent', 'ask', '--agent', agent], stdout: { status: 0, result: { text: JSON.stringify(payload) } } });
