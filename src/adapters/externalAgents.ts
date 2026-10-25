// Agents outside this process.
//
// Copado Agentia is the primary execution foundation:
//   agentia.ai          five Copado AI agents (plan, build, test, release, operate)
//   agentia.dependency  Copado dependency analyzer on each story branch
//   agentia.delivery    work set → environment-sync → local gates → publish → evidence step → submit
//   agentia.conflicts   promotion conflicts, auto-resolved only where the forecast proved it safe
//
// Third-party AI CLIs (Claude Code, Codex, Cursor, Copilot) answer the same AI contracts.
// They rank below Copado AI and are used as fallback or as a second opinion.
// Each uses that product's own documented non-interactive command; see docs/INTEGRATIONS.md.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentDescriptor, AgentResult, Capability, ComponentId, ExecutionContext } from '../core/types.ts';
import { AgentiaClient, AgentiaError, findObjects, get } from '../agentia/client.ts';
import { AI_CAPABILITIES, COPADO_AGENT_FOR, buildPrompt, isAiCapability, parseAnswer, type AiCapability } from '../ai/contracts.ts';
import { binaryAvailable, parseAllJson, run } from './exec.ts';

const agentiaDescriptor = (d: Omit<AgentDescriptor, 'provider' | 'mechanism'>): AgentDescriptor => ({ provider: 'Copado Agentia', mechanism: 'cli', ...d });

// ---------- Copado AI: five lifecycle agents behind one adapter ----------

export class AgentiaAiAdapter implements AgentAdapter {
  readonly descriptor = agentiaDescriptor({
    id: 'agentia.ai',
    name: 'Copado AI agents (agentia ai agent ask)',
    capabilities: [...AI_CAPABILITIES],
    inputSchema: 'per capability, see src/ai/contracts.ts',
    outputSchema: 'per capability, see src/ai/contracts.ts',
    permissions: { write: false, deploy: false, network: true },
    costTier: 'low',
    latencyTier: 'medium',
    preference: 1,
    restrictions: ['plan → requirement.enrich, build → architecture.review, test → test.select, release → release.review, operate → incident.rca', 'grounded in Org Intelligence when a workspace is configured'],
    docs: 'https://developer.copado.com/training#copado-ai-training',
  });
  private readonly client: AgentiaClient;
  constructor(client = new AgentiaClient()) {
    this.client = client;
  }
  async isAvailable() {
    return this.client.version();
  }
  async execute(capability: Capability, input: unknown, ctx: ExecutionContext): Promise<AgentResult> {
    if (!isAiCapability(capability)) return { ok: false, evidence: 'none', error: `unsupported capability ${capability}` };
    const agent = COPADO_AGENT_FOR[capability];
    ctx.log('agentia.ai.ask', { agent, capability });
    try {
      const raw = await this.client.aiAsk(agent, buildPrompt(capability, input));
      return { ok: true, output: parseAnswer(capability, [raw]), evidence: 'ai-opinion', via: `copado ${agent} agent` };
    } catch (e) {
      return { ok: false, evidence: 'none', error: (e as Error).message, via: `copado ${agent} agent` };
    }
  }
}

// ---------- Third-party AI CLIs ----------

interface CliAiConfig {
  id: string;
  name: string;
  provider: string;
  preference: number;
  binary: string;
  docs: string;
  restrictions: string[];
  args: (prompt: string) => string[];
}

export class CliAiAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  private readonly cfg: CliAiConfig;
  constructor(cfg: CliAiConfig) {
    this.cfg = cfg;
    this.descriptor = {
      id: cfg.id,
      name: cfg.name,
      provider: cfg.provider,
      capabilities: [...AI_CAPABILITIES],
      mechanism: 'cli',
      inputSchema: 'per capability, see src/ai/contracts.ts',
      outputSchema: 'per capability, see src/ai/contracts.ts',
      permissions: { write: false, deploy: false, network: true },
      costTier: 'medium',
      latencyTier: 'high',
      preference: cfg.preference,
      restrictions: cfg.restrictions,
      docs: cfg.docs,
    };
  }
  isAvailable() {
    return binaryAvailable(this.cfg.binary);
  }
  async execute(capability: Capability, input: unknown, ctx: ExecutionContext): Promise<AgentResult> {
    if (!isAiCapability(capability)) return { ok: false, evidence: 'none', error: `unsupported capability ${capability}` };
    const prompt = buildPrompt(capability, input);
    const args = this.cfg.args(prompt);
    ctx.log('cli.exec', { agent: this.descriptor.id, binary: this.cfg.binary, args: args.map((a) => (a === prompt ? '<prompt>' : a)) });
    const r = await run(this.cfg.binary, args, { timeoutMs: 240_000 });
    if (r.timedOut) return { ok: false, evidence: 'none', error: 'timed out' };
    if (r.code !== 0) return { ok: false, evidence: 'none', error: `exit ${r.code}: ${r.stderr.slice(0, 400)}` };
    try {
      return { ok: true, output: parseAnswer(capability as AiCapability, parseAllJson(r.stdout)), evidence: 'ai-opinion' };
    } catch (e) {
      return { ok: false, evidence: 'none', error: `could not parse response: ${(e as Error).message}` };
    }
  }
}

export const claudeCode = () =>
  new CliAiAdapter({
    id: 'claude-code',
    name: 'Claude Code (headless)',
    provider: 'Anthropic',
    preference: 3,
    binary: 'claude',
    docs: 'https://docs.claude.com/en/docs/claude-code/headless',
    restrictions: ['--permission-mode plan: read-only'],
    args: (p) => ['-p', p, '--output-format', 'json', '--permission-mode', 'plan'],
  });

export const codex = () =>
  new CliAiAdapter({
    id: 'codex',
    name: 'OpenAI Codex CLI (exec)',
    provider: 'OpenAI',
    preference: 4,
    binary: 'codex',
    docs: 'https://developers.openai.com/codex/noninteractive',
    restrictions: ['--sandbox read-only'],
    args: (p) => ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', p],
  });

export const cursor = () =>
  new CliAiAdapter({
    id: 'cursor',
    name: 'Cursor Agent CLI (print mode)',
    provider: 'Cursor',
    preference: 5,
    binary: process.env.CURSOR_AGENT_BIN ?? 'cursor-agent',
    docs: 'https://cursor.com/docs/cli/headless',
    restrictions: ['no --force: never writes files', 'needs CURSOR_API_KEY or `cursor-agent login`'],
    args: (p) => ['-p', '--output-format', 'json', p],
  });

export const copilot = () =>
  new CliAiAdapter({
    id: 'copilot',
    name: 'GitHub Copilot CLI (programmatic)',
    provider: 'GitHub',
    preference: 6,
    binary: 'copilot',
    docs: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference',
    restrictions: ['no --allow-tool: no tool use', 'needs a Copilot plan'],
    args: (p) => ['-p', p, '-s'],
  });

// ---------- Copado dependency analyzer ----------

export interface DependencyInput {
  repo: string;
  baseRef: string;
  branch: string;
  story: string;
}

export interface DependencyOutput {
  story: string;
  components: ComponentId[];
  missing: ComponentId[];
  raw: unknown;
}

/** Turn whatever objects the analyzer returns into Type:Name ids, and spot ones marked missing. */
export function readDependencyResponse(raw: unknown): { components: ComponentId[]; missing: ComponentId[] } {
  const components = new Set<ComponentId>();
  const missing = new Set<ComponentId>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const type = get(o, 'type') ?? get(o, 'metadataType');
    const name = get(o, 'name') ?? get(o, 'apiName') ?? get(o, 'fullName');
    if (typeof type === 'string' && typeof name === 'string' && /^[A-Z]\w+$/.test(type)) {
      const id = `${type}:${name}`;
      components.add(id);
      const status = String(get(o, 'status') ?? get(o, 'state') ?? '');
      if (get(o, 'missing') === true || get(o, 'existsInTarget') === false || /missing|not\s*found|absent/i.test(status)) missing.add(id);
    }
    Object.values(o).forEach(walk);
  };
  walk(raw);
  return { components: [...components], missing: [...missing] };
}

export class AgentiaDependencyAdapter implements AgentAdapter {
  readonly descriptor = agentiaDescriptor({
    id: 'agentia.dependency',
    name: 'Copado dependency analyzer (agentia cicd metadata dependency list)',
    capabilities: ['impact.external'],
    inputSchema: 'DependencyInput',
    outputSchema: 'DependencyOutput',
    permissions: { write: false, deploy: false, network: true },
    costTier: 'low',
    latencyTier: 'medium',
    preference: 1,
    restrictions: ['Source Format pipelines only', 'runs in a temporary git worktree; your checkout is untouched'],
    docs: 'https://developer.copado.com/training#use-cases',
  });
  private readonly client: AgentiaClient;
  constructor(client = new AgentiaClient()) {
    this.client = client;
  }
  isAvailable() {
    return this.client.version();
  }
  async execute(capability: Capability, input: unknown, ctx: ExecutionContext): Promise<AgentResult<DependencyOutput>> {
    if (capability !== 'impact.external') return { ok: false, evidence: 'none', error: `unsupported capability ${capability}` };
    const { repo, baseRef, branch, story } = input as DependencyInput;
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'fleet-wt-')), 'wt');
    const add = await run('git', ['-C', repo, 'worktree', 'add', '--detach', dir, branch]);
    if (add.code !== 0) return { ok: false, evidence: 'none', error: `git worktree add failed: ${add.stderr.trim()}` };
    try {
      ctx.log('agentia.dependency', { story, branch, baseRef });
      const raw = await this.client.withCwd(dir).dependencyFromChanges(baseRef);
      return { ok: true, output: { story, ...readDependencyResponse(raw), raw }, evidence: 'external-tool' };
    } catch (e) {
      return { ok: false, evidence: 'none', error: (e as Error).message };
    } finally {
      await run('git', ['-C', repo, 'worktree', 'remove', '--force', dir]);
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }
}

// ---------- Copado delivery: the governed per-story loop ----------

export interface DeliveryInput {
  copadoStory: string;
  cwd: string;
  /** Run environment-sync first (story depends on stories promoted in earlier waves). */
  syncFirst?: boolean;
  /** Run the project's local quality gates. Default true. */
  runGates?: boolean;
  /** Register the Copado commit before submit. */
  publish?: boolean;
  /** Attach a post-deployment Manual Task with the fleet evidence. */
  evidence?: { name: string; instructions: string };
}

export interface DeliveryStep {
  step: string;
  command: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export function deliveryCommands(input: DeliveryInput, deploy: boolean): { step: string; args: string[] }[] {
  const steps: { step: string; args: string[] }[] = [{ step: 'select story', args: ['cicd', 'work', 'set', input.copadoStory, '--json'] }];
  if (input.syncFirst) steps.push({ step: 'back-promotion sync', args: ['cicd', 'work', 'environment-sync'] });
  if (input.runGates !== false) steps.push({ step: 'local quality gates', args: ['cicd', 'work', 'test', '--json'] });
  if (input.publish) steps.push({ step: 'register Copado commit', args: ['cicd', 'work', 'publish', '--json'] });
  if (input.evidence) steps.push({ step: 'attach evidence step', args: ['cicd', 'work', 'deployment-step', 'create', '--name', input.evidence.name, '--type', 'Manual Task', '--instructions', '<fleet evidence>', '--sequence', 'after', '--no-run-on-validation', '--skip-back-promotion', '--json'] });
  steps.push({ step: deploy ? 'validate + deploy to next environment' : 'validate', args: ['cicd', 'work', 'submit', ...(deploy ? ['--deploy'] : []), '--json'] });
  steps.push({ step: 'status', args: ['cicd', 'work', 'status', input.copadoStory, '--json'] });
  return steps;
}

export class AgentiaDeliveryAdapter implements AgentAdapter {
  readonly descriptor = agentiaDescriptor({
    id: 'agentia.delivery',
    name: 'Copado delivery (work set → sync → gates → submit)',
    capabilities: ['deploy.validate', 'deploy.promote'],
    inputSchema: 'DeliveryInput',
    outputSchema: 'DeliveryStep[]',
    permissions: { write: true, deploy: true, network: true },
    costTier: 'low',
    latencyTier: 'high',
    preference: 1,
    restrictions: ['needs a human approval id', 'deploy.promote needs an approval that allows deploy', 'local flow only; work set needs a clean tracked tree'],
    docs: 'https://developer.copado.com/training#work-item-loop',
  });
  private readonly client: AgentiaClient;
  constructor(client = new AgentiaClient()) {
    this.client = client;
  }
  isAvailable() {
    return this.client.version();
  }
  async execute(capability: Capability, input: unknown, ctx: ExecutionContext): Promise<AgentResult<DeliveryStep[]>> {
    if (capability !== 'deploy.validate' && capability !== 'deploy.promote') return { ok: false, evidence: 'none', error: `unsupported capability ${capability}` };
    if (!ctx.approvalId) return { ok: false, evidence: 'none', error: 'refused: no human approval for this plan' };
    const d = input as DeliveryInput;
    const deploy = capability === 'deploy.promote';
    const planned = deliveryCommands(d, deploy);
    if (ctx.dryRun) {
      return { ok: true, evidence: 'none', output: planned.map((s) => ({ step: s.step, command: `agentia ${s.args.join(' ')}`, ok: true, output: 'dry-run: not sent' })) };
    }
    const c = this.client.withCwd(d.cwd);
    const steps: DeliveryStep[] = [];
    const exec = async (step: string, fn: () => Promise<unknown>, command: string) => {
      ctx.log('agentia.step', { story: d.copadoStory, step, approvalId: ctx.approvalId });
      try {
        steps.push({ step, command, ok: true, output: await fn() });
        return true;
      } catch (e) {
        steps.push({ step, command, ok: false, error: e instanceof AgentiaError ? e.message : String(e) });
        return false;
      }
    };
    const cmd = (s: { args: string[] }) => `agentia ${s.args.join(' ')}`;
    for (const s of planned) {
      let fn: () => Promise<unknown>;
      switch (s.step) {
        case 'select story': fn = () => c.workSet(d.copadoStory); break;
        case 'back-promotion sync': fn = () => c.workEnvironmentSync(); break;
        case 'local quality gates': fn = () => c.workTest(); break;
        case 'register Copado commit': fn = () => c.workPublish(); break;
        case 'attach evidence step': fn = () => c.deploymentStepManual(d.evidence!.name, d.evidence!.instructions); break;
        case 'status': fn = () => c.workStatus(d.copadoStory); break;
        default: fn = () => c.workSubmit({ deploy });
      }
      if (!(await exec(s.step, fn, cmd(s)))) {
        const failed = steps.at(-1)!;
        return { ok: false, evidence: 'copado-validation', output: steps, error: `${failed.step} failed: ${failed.error}` };
      }
    }
    return { ok: true, evidence: deploy ? 'copado-deployment' : 'copado-validation', output: steps };
  }
}

// ---------- Promotion conflicts, resolved by forecast ----------

export interface ConflictInput {
  promotion: string;
  /** Components the forecast proved node-disjoint (safe to auto-merge). */
  mergeable: ComponentId[];
  /** Components where two stories change the same element. */
  collisions: ComponentId[];
  apply: boolean;
}

export interface ConflictDecision {
  conflictId: string;
  component: ComponentId;
  story?: string;
  status?: string;
  decision: 'auto' | 'manual';
  reason: string;
  resolved?: boolean;
  error?: string;
}

export function decideConflicts(raw: unknown, mergeable: ComponentId[], collisions: ComponentId[]): ConflictDecision[] {
  return findObjects(raw, ['attachmentId']).map((o) => {
    const type = String(get(o, 'metadataType') ?? get(o, 'type') ?? '');
    const name = String(get(o, 'metadataName') ?? get(o, 'name') ?? '');
    const component = `${type}:${name}`;
    const base = { conflictId: String(get(o, 'attachmentId')), component, story: get(o, 'userStory') as string | undefined, status: get(o, 'status') as string | undefined };
    if (collisions.includes(component)) return { ...base, decision: 'manual' as const, reason: 'Forecast: two stories change the same element. A person must choose.' };
    if (mergeable.includes(component)) return { ...base, decision: 'auto' as const, reason: 'Forecast: stories touch different elements of this file, so a merge keeps both.' };
    return { ...base, decision: 'manual' as const, reason: 'Not forecast. Review by hand, then rerun the simulation with the in-flight stories.' };
  });
}

export class AgentiaConflictAdapter implements AgentAdapter {
  readonly descriptor = agentiaDescriptor({
    id: 'agentia.conflicts',
    name: 'Copado promotion conflicts (forecast-guided)',
    capabilities: ['conflict.resolve'],
    inputSchema: 'ConflictInput',
    outputSchema: 'ConflictDecision[]',
    permissions: { write: true, deploy: false, network: true },
    costTier: 'low',
    latencyTier: 'medium',
    preference: 1,
    restrictions: ['only --mode auto, only for forecast-mergeable components', 'never resumes the promotion itself'],
    docs: 'https://developer.copado.com/training#use-case-promotions',
  });
  private readonly client: AgentiaClient;
  constructor(client = new AgentiaClient()) {
    this.client = client;
  }
  isAvailable() {
    return this.client.version();
  }
  async execute(capability: Capability, input: unknown, ctx: ExecutionContext): Promise<AgentResult<ConflictDecision[]>> {
    if (capability !== 'conflict.resolve') return { ok: false, evidence: 'none', error: `unsupported capability ${capability}` };
    const i = input as ConflictInput;
    try {
      const decisions = decideConflicts(await this.client.conflictList(i.promotion), i.mergeable, i.collisions);
      if (i.apply) {
        if (!ctx.approvalId) return { ok: false, evidence: 'none', error: 'refused: resolving conflicts needs an approved run' };
        for (const d of decisions.filter((x) => x.decision === 'auto')) {
          ctx.log('agentia.conflict.resolve', { promotion: i.promotion, conflict: d.conflictId, component: d.component });
          try {
            await this.client.conflictResolveAuto(d.conflictId, i.promotion);
            d.resolved = true;
          } catch (e) {
            d.resolved = false;
            d.error = (e as Error).message;
            d.reason += ' Copado could not auto-resolve it; resolve manually.';
          }
        }
      }
      return { ok: true, evidence: 'external-tool', output: decisions };
    } catch (e) {
      return { ok: false, evidence: 'none', error: (e as Error).message };
    }
  }
}

// ---------- Clearly labeled mock ----------

export class MockDeliveryAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor = {
    id: 'mock.delivery',
    name: 'MOCK delivery (no Copado call)',
    provider: 'fleet (mock)',
    capabilities: ['deploy.validate', 'deploy.promote'],
    mechanism: 'in-process',
    inputSchema: 'DeliveryInput',
    outputSchema: '{ mock: true }',
    permissions: { write: false, deploy: true, network: false },
    costTier: 'none',
    latencyTier: 'none',
    preference: 9,
    mock: true,
    restrictions: ['returns MOCK results only; never treat as a validation'],
  };
  async isAvailable() {
    return { ok: true };
  }
  async execute(capability: Capability, input: unknown): Promise<AgentResult> {
    const d = input as DeliveryInput;
    return {
      ok: true,
      evidence: 'mock',
      output: {
        mock: true,
        copadoStory: d.copadoStory,
        wouldRun: deliveryCommands(d, capability === 'deploy.promote').map((s) => `agentia ${s.args.join(' ')}`),
        message: 'MOCK: Agentia CLI not available, nothing was sent to Copado.',
      },
    };
  }
}

/** @deprecated name kept for older imports */
export { MockDeliveryAdapter as MockValidateAdapter };

export function externalAgents(client = new AgentiaClient()): AgentAdapter[] {
  return [
    new AgentiaAiAdapter(client),
    new AgentiaDependencyAdapter(client),
    new AgentiaDeliveryAdapter(client),
    new AgentiaConflictAdapter(client),
    claudeCode(),
    codex(),
    cursor(),
    copilot(),
    new MockDeliveryAdapter(),
  ];
}
