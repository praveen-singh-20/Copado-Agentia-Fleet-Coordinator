// One place for every Agentia Headless CLI call the fleet makes.
// Each method maps to a command documented at developer.copado.com/docs or /training.
// The CLI is alpha, so command lines live only here; JSON responses are kept raw and
// read defensively because their exact shapes are not published.
//
// Set AGENTIA_BIN to point at a different binary (the tests use a stub).

import { parseJsonOutput, run } from '../adapters/exec.ts';

export class AgentiaError extends Error {
  readonly args: string[];
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, args: string[], code: number | null, stderr: string) {
    super(message);
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

export interface AgentiaCall {
  args: string[];
  ok: boolean;
  ms: number;
  code: number | null;
}

export interface AgentiaClientOptions {
  bin?: string;
  cwd?: string;
  timeoutMs?: number;
  onCall?: (c: AgentiaCall) => void;
}

export type CopadoAgent = 'plan' | 'build' | 'test' | 'release' | 'operate' | 'knowledge';

export class AgentiaClient {
  readonly bin: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly calls: AgentiaCall[] = [];
  private readonly onCall?: (c: AgentiaCall) => void;

  constructor(opts: AgentiaClientOptions = {}) {
    this.bin = opts.bin ?? process.env.AGENTIA_BIN ?? 'agentia';
    this.cwd = opts.cwd;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.onCall = opts.onCall;
  }

  withCwd(cwd: string): AgentiaClient {
    return new AgentiaClient({ bin: this.bin, cwd, timeoutMs: this.timeoutMs, onCall: this.onCall });
  }

  /** Run a command. With json=true, appends --json and parses; unparseable output is returned as { raw }. */
  async call(args: string[], opts: { json?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
    const full = opts.json !== false && !args.includes('--json') ? [...args, '--json'] : args;
    const started = Date.now();
    const r = await run(this.bin, full, { cwd: this.cwd, timeoutMs: opts.timeoutMs ?? this.timeoutMs });
    const call: AgentiaCall = { args: full, ok: r.code === 0, ms: Date.now() - started, code: r.code };
    this.calls.push(call);
    this.onCall?.(call);
    if (r.timedOut) throw new AgentiaError(`agentia ${full.join(' ')} timed out`, full, r.code, r.stderr);
    if (r.code !== 0) {
      throw new AgentiaError(`agentia ${full.join(' ')} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 600)}`, full, r.code, r.stderr);
    }
    if (opts.json === false) return { raw: r.stdout };
    try {
      return parseJsonOutput(r.stdout);
    } catch {
      return { raw: r.stdout };
    }
  }

  async version(): Promise<{ ok: boolean; version?: string; reason?: string }> {
    const r = await run(this.bin, ['--version'], { timeoutMs: 20_000 });
    return r.code === 0 ? { ok: true, version: r.stdout.trim().split('\n')[0] } : { ok: false, reason: r.code === -1 ? `${this.bin} not found on PATH` : `exit ${r.code}` };
  }

  // ---------- General ----------
  healthCheck() {
    return this.call(['cicd', 'health-check']);
  }
  aiQuota() {
    return this.call(['ai', 'quota', 'get']);
  }

  // ---------- Work items (local repository flow) ----------
  workList(opts: { assignedToMe?: boolean } = {}) {
    return this.call(['cicd', 'work', 'list', ...(opts.assignedToMe ? ['--assigned-to-me'] : [])]);
  }
  workGet(story: string) {
    return this.call(['cicd', 'work', 'get', story]);
  }
  workSet(story: string) {
    return this.call(['cicd', 'work', 'set', story]);
  }
  /** Local quality gates configured for the project. */
  workTest() {
    return this.call(['cicd', 'work', 'test']);
  }
  workPublish() {
    return this.call(['cicd', 'work', 'publish']);
  }
  /** Validates. With deploy=true deploys to the next environment (needs explicit approval). */
  workSubmit(opts: { deploy?: boolean } = {}) {
    return this.call(['cicd', 'work', 'submit', ...(opts.deploy ? ['--deploy'] : [])], { timeoutMs: 1_800_000 });
  }
  workStatus(story?: string) {
    return this.call(['cicd', 'work', 'status', ...(story ? [story] : [])]);
  }
  /** Back-promotion: merge incoming pipeline changes into the active story branch. */
  workEnvironmentSync() {
    return this.call(['cicd', 'work', 'environment-sync'], { json: false, timeoutMs: 900_000 });
  }

  /** Attach a post-deployment Manual Task carrying the fleet evidence (skipped during validation and back-promotion). */
  deploymentStepManual(name: string, instructions: string) {
    return this.call([
      'cicd', 'work', 'deployment-step', 'create',
      '--name', name.slice(0, 80),
      '--type', 'Manual Task',
      '--instructions', instructions,
      '--sequence', 'after',
      '--no-run-on-validation',
      '--skip-back-promotion',
    ]);
  }

  // ---------- Metadata & dependencies ----------
  dependencyFromChanges(baseRef: string) {
    return this.call(['cicd', 'metadata', 'dependency', 'list', '--from-changes', '--base-ref', baseRef]);
  }
  metadataCompare(apiName: string, sourceOrgId: string, targetOrgId: string) {
    return this.call(['cicd', 'metadata', 'content', 'compare', '--api-name', apiName, '--source-org-id', sourceOrgId, '--target-org-id', targetOrgId]);
  }

  // ---------- Promotions & conflicts ----------
  promotionGet(id: string) {
    return this.call(['cicd', 'promotion', 'get', id]);
  }
  conflictList(promotion: string) {
    return this.call(['cicd', 'promotion', 'conflict', 'list', '--promotion', promotion]);
  }
  conflictResolveAuto(conflictId: string, promotion: string) {
    return this.call(['cicd', 'promotion', 'conflict', 'resolve', conflictId, '--promotion', promotion, '--mode', 'auto']);
  }

  // ---------- Copado AI ----------
  /** Single-turn, non-streaming ask: the documented automation path (chat is TTY-only). */
  aiAsk(agent: CopadoAgent, prompt: string) {
    return this.call(['ai', 'agent', 'ask', '--agent', agent, '-p', prompt, '--no-stream']);
  }
}

// ---------- Defensive readers for undocumented JSON shapes ----------

/** Collect Copado user story names (US-0000123 style) from any JSON shape. */
export function extractStoryNames(raw: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, key?: string) => {
    if (typeof v === 'string') {
      if (/^US-\d+$/.test(v) && (!key || /name|story|id|key/i.test(key))) out.add(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(raw);
  return [...out];
}

/** Find the first string value for any of the given keys (case-insensitive), anywhere in the JSON. */
export function findField(raw: unknown, keys: string[]): string | undefined {
  const want = keys.map((k) => k.toLowerCase());
  let found: string | undefined;
  const walk = (v: unknown) => {
    if (found !== undefined || !v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (want.includes(k.toLowerCase()) && (typeof x === 'string' || typeof x === 'number')) {
        found = String(x);
        return;
      }
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(raw);
  return found;
}

/** Arrays of objects inside a response (e.g. the conflict list), flattened. */
export function findObjects(raw: unknown, mustHave: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const want = mustHave.map((k) => k.toLowerCase());
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const keys = Object.keys(v).map((k) => k.toLowerCase());
      if (want.every((k) => keys.includes(k))) out.push(v as Record<string, unknown>);
      else Object.values(v).forEach(walk);
    }
  };
  walk(raw);
  return out;
}

export const get = (o: Record<string, unknown>, key: string): unknown => {
  const k = Object.keys(o).find((x) => x.toLowerCase() === key.toLowerCase());
  return k ? o[k] : undefined;
};
