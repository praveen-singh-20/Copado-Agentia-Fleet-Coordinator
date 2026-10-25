// Fleet Coordinator: the control plane.
//
//   intake → discovery → ┬ plan (waves) → per-story impact → SIMULATE ┐
//                        ├ Copado Plan agent: requirement check        ├→ Copado Build / Release / Test agents
//                        └ Copado dependency analyzer per branch       ┘   (+ optional second opinion)
//   → consolidate → RISK → promotion & back-promotion plan → human approval (plan-hash bound)
//   → governed Agentia delivery per story, wave by wave → Operate agent RCA on failure
//   → risk re-assessed with Copado evidence → forecast-guided conflict resolution → audit

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  BlastRadius,
  Capability,
  ComponentId,
  ExecutionContext,
  Finding,
  MetadataSnapshot,
  RiskReport,
  Schedule,
  SimulationResult,
  TaskBatch,
  TaskInput,
} from '../core/types.ts';
import { AuditLog } from '../audit/auditLog.ts';
import { MetadataState, writeKeys } from '../graph/metadataGraph.ts';
import type { AgentRegistry, RoutePolicy } from '../registry/registry.ts';
import type { RequirementOutput } from '../adapters/localAgents.ts';
import type { ConflictDecision, DeliveryInput, DeliveryStep, DependencyOutput } from '../adapters/externalAgents.ts';
import type { EnrichOutput, RcaOutput, ReviewConcern, ReviewInput, TestSuggestion } from '../ai/contracts.ts';
import { describeOp } from '../importer/diff.ts';
import { assessRisk } from '../risk/riskEngine.ts';
import type { SourceNote } from '../sources/gitSource.ts';
import { pool } from './pool.ts';

export { pool };

export interface CoordinatorOptions {
  workDir: string;
  concurrency?: number;
  retries?: number;
  policy?: RoutePolicy;
  clock?: () => Date;
}

export interface RunOptions {
  /** Ask the AI agents (Copado AI first). */
  ai?: boolean;
  /** Ask two different AI agents for the review and compare their answers. */
  secondOpinion?: boolean;
  /** Run the Copado dependency analyzer on each story branch. */
  externalImpact?: { repo: string; baseRef: string };
  /** Notes from the story source (e.g. branches behind base). */
  notes?: SourceNote[];
  source?: RunRecord['source'];
}

export type RunStatus = 'needs-human' | 'awaiting-approval' | 'revise' | 'rejected';

export interface AgentCall {
  stage: string;
  capability: Capability;
  agent?: string;
  via?: string;
  ok: boolean;
  evidence: string;
  ms?: number;
  error?: string;
  candidates: { id: string; score: number; excludedBecause?: string }[];
}

export interface PromotionStep {
  wave: number;
  story: string;
  copadoStory?: string;
  commands: string[];
  notes: string[];
}

export interface Opinion {
  capability: 'architecture.review' | 'release.review';
  agent: string;
  via?: string;
  concerns: ReviewConcern[];
}

export interface RunRecord {
  runId: string;
  createdAt: string;
  batch: string;
  snapshot: { name: string; origin: string; capturedAt: string };
  source?: { kind: 'file' | 'git'; repo?: string; base?: string; baseSha?: string };
  status: RunStatus;
  tasks: TaskInput[];
  intakeIssues: { task: string; issues: string[] }[];
  notes?: SourceNote[];
  schedule?: Schedule;
  impacts?: Record<string, BlastRadius>;
  externalImpact?: DependencyOutput[];
  simulation?: SimulationResult;
  enrichment?: Record<string, { agent: string; via?: string; output: EnrichOutput }>;
  opinions?: Opinion[];
  aiOpinions?: { agent: string; concerns: ReviewConcern[]; agreements: { concern: string; finding: string }[] }[];
  aiTests?: { agent: string; via?: string; tests: TestSuggestion[] }[];
  risk?: RiskReport;
  promotionPlan?: PromotionStep[];
  planHash?: string;
  agentCalls: AgentCall[];
}

export interface ApprovalRecord {
  approvalId: string;
  runId: string;
  planHash: string;
  by: string;
  at: string;
  note?: string;
  acceptedRisk: boolean;
  allowDeploy: boolean;
}

export type ExecStatus = 'SKIPPED' | 'DRY-RUN' | 'MOCK' | 'VALIDATED' | 'DEPLOYED' | 'FAILED' | 'NOT-RUN';

export interface ExecutionRecord {
  runId: string;
  approvalId: string;
  mode: 'dry-run' | 'live';
  action: 'validate' | 'deploy';
  results: { task: string; wave: number; copadoStory?: string; agent?: string; status: ExecStatus; steps?: DeliveryStep[]; detail?: unknown; rca?: { agent: string; via?: string; output: RcaOutput } }[];
  riskAfter?: RiskReport;
}

export interface ExecuteOptions {
  live?: boolean;
  deploy?: boolean;
  cwd?: string;
  gates?: boolean;
  publish?: boolean;
  evidence?: boolean;
}

export function computePlanHash(tasks: TaskInput[], schedule: Schedule | undefined, decision: string | undefined): string {
  return createHash('sha256').update(JSON.stringify({ tasks, schedule, decision })).digest('hex');
}

const nextId = (fs: Finding[]) => `F${String(fs.reduce((m, f) => Math.max(m, Number(f.id.slice(1)) || 0), 0) + 1).padStart(3, '0')}`;

export class FleetCoordinator {
  readonly registry: AgentRegistry;
  readonly opts: Required<Omit<CoordinatorOptions, 'clock'>> & { clock: () => Date };
  readonly audit: AuditLog;

  constructor(registry: AgentRegistry, opts: CoordinatorOptions) {
    this.registry = registry;
    this.opts = { concurrency: 3, retries: 1, policy: {}, clock: () => new Date(), ...opts };
    mkdirSync(path.join(this.opts.workDir, 'runs'), { recursive: true });
    this.audit = new AuditLog(path.join(this.opts.workDir, 'audit.jsonl'), this.opts.clock);
  }

  runDir(runId: string) {
    return path.join(this.opts.workDir, 'runs', runId);
  }

  private ctx(runId: string, extra: Partial<ExecutionContext> = {}): ExecutionContext {
    return { runId, dryRun: true, log: (event, data) => this.audit.append(runId, 'coordinator', event, data), ...extra };
  }

  private record(record: { agentCalls: AgentCall[] }, stage: string, capability: Capability, agent: string | undefined, result: { ok: boolean; evidence: string; durationMs?: number; error?: string; via?: string }, candidates: AgentCall['candidates']) {
    record.agentCalls.push({ stage, capability, agent, via: result.via, ok: result.ok, evidence: result.evidence, ms: result.durationMs, error: result.error, candidates });
  }

  private async call(record: { agentCalls: AgentCall[] }, stage: string, capability: Capability, input: unknown, ctx: ExecutionContext, policy: RoutePolicy = {}) {
    const { agent, result, route } = await this.registry.invoke(capability, input, ctx, { ...this.opts.policy, ...policy }, this.opts.retries);
    this.record(record, stage, capability, agent, result, route.candidates.map(({ id, score, excludedBecause }) => ({ id, score, ...(excludedBecause ? { excludedBecause } : {}) })));
    return { agent, result };
  }

  async run(batch: TaskBatch, snapshot: MetadataSnapshot, runOpts: RunOptions = {}): Promise<RunRecord> {
    const now = this.opts.clock();
    const runId = `run-${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
    const ctx = this.ctx(runId);
    const baseline = MetadataState.fromSnapshot(snapshot);
    const record: RunRecord = {
      runId,
      createdAt: now.toISOString(),
      batch: batch.name,
      snapshot: { name: snapshot.name, origin: snapshot.origin, capturedAt: snapshot.capturedAt },
      ...(runOpts.source ? { source: runOpts.source } : {}),
      status: 'needs-human',
      tasks: [],
      intakeIssues: [],
      ...(runOpts.notes?.length ? { notes: runOpts.notes } : {}),
      agentCalls: [],
    };
    this.audit.append(runId, 'coordinator', 'run.start', { batch: batch.name, tasks: batch.tasks.map((t) => t.id), snapshot: snapshot.name, ai: !!runOpts.ai });

    // 1. Intake.
    const intake = await pool(batch.tasks, this.opts.concurrency, (t) => this.call(record, 'intake', 'requirement.analyze', t, ctx));
    intake.forEach(({ result }, i) => {
      const out = result.output as RequirementOutput | undefined;
      if (out) record.tasks.push(out.task);
      const issues = out?.issues ?? [result.error ?? 'requirement agent failed'];
      if (!result.ok || issues.length) record.intakeIssues.push({ task: batch.tasks[i].id, issues });
    });
    const dupes = record.tasks.map((t) => t.id).filter((id, i, a) => a.indexOf(id) !== i);
    if (dupes.length) record.intakeIssues.push({ task: dupes[0], issues: [`duplicate task id ${dupes[0]}`] });
    if (!batch.tasks.length) record.intakeIssues.push({ task: '*', issues: ['no tasks in the batch'] });
    if (record.intakeIssues.length) return this.finish(record, 'needs-human');

    // 2. Discovery.
    const discovered = await this.registry.discover();
    this.audit.append(runId, 'coordinator', 'agents.discovered', { agents: discovered.map((d) => ({ id: d.id, available: d.availability.ok, reason: d.availability.reason })) });
    const changeTasks = record.tasks.filter((t) => (t.kind ?? 'change') === 'change');

    // 3. Three independent lanes in parallel.
    const coreLane = async () => {
      const planned = await this.call(record, 'plan', 'plan.schedule', changeTasks, ctx);
      if (!planned.result.ok) throw new Error(planned.result.error ?? 'planning failed');
      record.schedule = planned.result.output as Schedule;
      record.impacts = {};
      for (const wave of record.schedule.waves) {
        this.audit.append(runId, 'coordinator', 'wave.start', { wave: wave.index, tasks: wave.tasks });
        const tasks = wave.tasks.map((id) => changeTasks.find((t) => t.id === id)!);
        const results = await pool(tasks, this.opts.concurrency, (task) => this.call(record, `impact:wave${wave.index}`, 'impact.analyze', { baseline, task }, ctx));
        results.forEach(({ result }, i) => {
          if (result.ok) record.impacts![tasks[i].id] = result.output as BlastRadius;
        });
      }
      const sim = await this.call(record, 'simulate', 'simulation.run', { baseline, baselineName: snapshot.name, tasks: changeTasks, schedule: record.schedule }, ctx);
      if (!sim.result.ok) throw new Error(sim.result.error ?? 'simulation failed');
      record.simulation = sim.result.output as SimulationResult;
    };
    const enrichLane = async () => {
      if (!runOpts.ai) return;
      record.enrichment = {};
      await pool(changeTasks, this.opts.concurrency, async (t) => {
        const { agent, result } = await this.call(record, 'requirements', 'requirement.enrich', { story: { id: t.id, title: t.title, description: t.description, acceptanceCriteria: t.acceptanceCriteria }, changes: (t.changes ?? []).map(describeOp) }, ctx);
        if (result.ok && agent) record.enrichment![t.id] = { agent, via: result.via, output: result.output as EnrichOutput };
      });
    };
    const externalLane = async () => {
      const ext = runOpts.externalImpact;
      if (!ext) return;
      record.externalImpact = [];
      const withBranch = changeTasks.filter((t) => t.source?.branch);
      await pool(withBranch, 2, async (t) => {
        const { result } = await this.call(record, 'impact:copado', 'impact.external', { repo: ext.repo, baseRef: ext.baseRef, branch: t.source!.commit, story: t.id }, ctx);
        if (result.ok) record.externalImpact!.push(result.output as DependencyOutput);
      });
    };
    try {
      await Promise.all([coreLane(), enrichLane(), externalLane()]);
    } catch (e) {
      record.intakeIssues.push({ task: '*', issues: [(e as Error).message] });
      return this.finish(record, 'needs-human');
    }
    const sim = record.simulation!;

    // 4. AI reviews of the simulated result, in parallel.
    if (runOpts.ai) {
      const reviewInput: ReviewInput = {
        stories: changeTasks.map((t) => ({ id: t.id, title: t.title, changes: (t.changes ?? []).map(describeOp) })),
        findings: sim.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title })),
        blastRadius: [...sim.blastRadius.direct, ...sim.blastRadius.indirect].map((e) => e.component),
        waves: record.schedule!.waves.map((w) => ({ index: w.index, tasks: w.tasks })),
      };
      record.opinions = [];
      record.aiTests = [];
      const policy = { ...this.opts.policy };
      await Promise.all([
        (async () => {
          if (runOpts.secondOpinion) {
            const answers = await this.registry.invokeMany('architecture.review', reviewInput, ctx, policy, 2);
            for (const a of answers) {
              this.record(record, 'review', 'architecture.review', a.agent, a.result, []);
              if (a.result.ok) record.opinions!.push({ capability: 'architecture.review', agent: a.agent, via: a.result.via, concerns: a.result.output as ReviewConcern[] });
            }
          } else {
            const { agent, result } = await this.call(record, 'review', 'architecture.review', reviewInput, ctx);
            if (result.ok && agent) record.opinions!.push({ capability: 'architecture.review', agent, via: result.via, concerns: result.output as ReviewConcern[] });
          }
        })(),
        (async () => {
          const { agent, result } = await this.call(record, 'release', 'release.review', reviewInput, ctx);
          if (result.ok && agent) record.opinions!.push({ capability: 'release.review', agent, via: result.via, concerns: result.output as ReviewConcern[] });
        })(),
        (async () => {
          const { agent, result } = await this.call(record, 'tests', 'test.select', reviewInput, ctx);
          if (result.ok && agent) record.aiTests!.push({ agent, via: result.via, tests: result.output as TestSuggestion[] });
        })(),
      ]);
    }

    // 5. Consolidate everything into one list of findings.
    this.consolidate(record, changeTasks);

    // 6. Risk + plan.
    const risk = await this.call(record, 'risk', 'risk.assess', { simulation: sim }, ctx);
    record.risk = risk.result.output as RiskReport;
    for (const t of record.aiTests ?? []) for (const s of t.tests) record.risk.tests.push(`${s.name} (${s.type}; suggested by ${t.via ?? t.agent})`);
    record.promotionPlan = promotionPlan(changeTasks, record.schedule!);
    record.planHash = computePlanHash(changeTasks, record.schedule, record.risk.decision);

    const status: RunStatus = record.risk.decision === 'APPLY' ? 'awaiting-approval' : record.risk.decision === 'REVISE' ? 'revise' : 'rejected';
    return this.finish(record, status);
  }

  private consolidate(record: RunRecord, tasks: TaskInput[]) {
    const sim = record.simulation!;
    const push = (f: Omit<Finding, 'id'>) => sim.findings.push({ id: nextId(sim.findings), ...f });

    // Source notes.
    for (const n of record.notes ?? []) {
      if (n.level !== 'warning' || n.story === '*') continue;
      push({ category: 'deployment', severity: 'low', title: `${n.story}: ${n.message}`, explanation: n.message, components: [], stories: [n.story], evidence: ['metadata'], mitigation: 'agentia cicd work set <story> then agentia cicd work environment-sync' });
    }

    // Copado dependency analyzer.
    const known = new Set<ComponentId>([...sim.blastRadius.changed, ...sim.blastRadius.direct.map((e) => e.component), ...sim.blastRadius.indirect.map((e) => e.component)]);
    for (const ext of record.externalImpact ?? []) {
      for (const m of ext.missing) {
        push({ category: 'dependency', severity: 'high', title: `Copado: ${m} is missing in the target for ${ext.story}`, explanation: `The Copado dependency analyzer (agentia cicd metadata dependency list --from-changes) reports ${m} as a dependency that the target does not have.`, components: [m], stories: [ext.story], evidence: ['external-tool'], mitigation: `Add ${m} to ${ext.story} or promote the story that creates it first.` });
      }
      const unseen = ext.components.filter((c) => !known.has(c) && !ext.missing.includes(c));
      if (unseen.length) {
        push({ category: 'unverified', severity: 'low', title: `Copado sees ${unseen.length} dependenc${unseen.length === 1 ? 'y' : 'ies'} for ${ext.story} that the snapshot does not model`, explanation: unseen.slice(0, 12).join(', ') + (unseen.length > 12 ? ', …' : ''), components: unseen.slice(0, 12), stories: [ext.story], evidence: ['external-tool'], mitigation: 'Extend the snapshot/overlay so the simulation covers them.' });
      }
    }

    // Copado Plan agent: intent vs. changes.
    for (const [story, e] of Object.entries(record.enrichment ?? {})) {
      const task = tasks.find((t) => t.id === story);
      if (!task) continue;
      const changed = new Set(writeKeys(task.changes ?? []).map((w) => w.component));
      const covered = (c: string) => changed.has(c) || known.has(c) || [...changed].some((x) => x.toLowerCase() === c.toLowerCase());
      const missing = e.output.expectedComponents.filter((c) => !covered(c));
      if (missing.length) {
        push({ category: 'scope', severity: 'low', title: `[AI: ${e.via ?? e.agent}] ${story} may be missing ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}`, explanation: `From the story intent, the agent expected changes to ${missing.join(', ')}, which the story does not touch. (AI opinion, not verified.)`, components: missing, stories: [story], evidence: ['inference'], mitigation: 'Confirm with the story owner; add the component or note why it is not needed.' });
      }
      for (const g of e.output.gaps.slice(0, 3)) {
        push({ category: 'scope', severity: 'low', title: `[AI: ${e.via ?? e.agent}] ${story}: ${g.slice(0, 140)}`, explanation: `${g} (AI opinion, not verified.)`, components: [], stories: [story], evidence: ['inference'] });
      }
    }

    // Architecture and release opinions, with corroboration across agents.
    if (record.opinions?.length) {
      const { newFindings, agreements } = consolidateOpinionSet(sim.findings, record.opinions);
      sim.findings.push(...newFindings);
      record.aiOpinions = record.opinions.map((o) => ({ agent: o.via ? `${o.agent} (${o.via})` : o.agent, concerns: o.concerns, agreements: agreements.filter((a) => a.agent === o.agent).map(({ concern, finding }) => ({ concern, finding })) }));
    }
  }

  private finish(record: RunRecord, status: RunStatus): RunRecord {
    record.status = status;
    const dir = this.runDir(record.runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'run.json'), JSON.stringify(record, null, 2));
    this.audit.append(record.runId, 'coordinator', 'run.finish', { status, decision: record.risk?.decision, overall: record.risk?.overall, findings: record.simulation?.findings.length, planHash: record.planHash });
    return record;
  }

  loadRun(runId: string): RunRecord {
    const file = path.join(this.runDir(runId), 'run.json');
    if (!existsSync(file)) throw new Error(`Unknown run ${runId}`);
    return JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
  }

  loadApproval(runId: string): ApprovalRecord | undefined {
    const f = path.join(this.runDir(runId), 'approval.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ApprovalRecord) : undefined;
  }

  /** A human approves an exact plan. Changing the plan afterwards voids the approval. */
  approve(runId: string, by: string, opts: { note?: string; acceptRisk?: boolean; allowDeploy?: boolean; channel?: string } = {}): ApprovalRecord {
    if (!by?.trim()) throw new Error('Approval needs a named approver (--by "Your Name")');
    const run = this.loadRun(runId);
    if (!run.risk || !run.planHash) throw new Error(`Run ${runId} has no completed plan to approve`);
    if (run.risk.decision === 'REJECT') throw new Error(`Run ${runId} was REJECTED (${run.risk.decisionReason}). Revise the stories and run again.`);
    if (run.risk.decision === 'REVISE' && !opts.acceptRisk) throw new Error(`Run ${runId} needs revision (${run.risk.decisionReason}). Fix and rerun, or pass --accept-risk to approve anyway.`);
    const approval: ApprovalRecord = {
      approvalId: `appr-${randomBytes(4).toString('hex')}`,
      runId,
      planHash: run.planHash,
      by: by.trim(),
      at: this.opts.clock().toISOString(),
      ...(opts.note ? { note: opts.note } : {}),
      acceptedRisk: run.risk.decision === 'REVISE',
      allowDeploy: !!opts.allowDeploy,
    };
    writeFileSync(path.join(this.runDir(runId), 'approval.json'), JSON.stringify(approval, null, 2));
    this.audit.append(runId, `human:${approval.by}${opts.channel ? ` (${opts.channel})` : ''}`, 'plan.approved', { ...approval });
    return approval;
  }

  private checkApproval(run: RunRecord): ApprovalRecord {
    const approval = this.loadApproval(run.runId);
    if (!approval) throw new Error(`Run ${run.runId} is not approved. Run: fleet approve ${run.runId} --by "<name>"`);
    const changeTasks = run.tasks.filter((t) => (t.kind ?? 'change') === 'change');
    const currentHash = computePlanHash(changeTasks, run.schedule, run.risk?.decision);
    if (currentHash !== approval.planHash || currentHash !== run.planHash) {
      this.audit.append(run.runId, 'coordinator', 'execute.refused', { reason: 'plan changed after approval' });
      throw new Error('The plan changed after approval. Run the simulation again and get a new approval.');
    }
    return approval;
  }

  /**
   * Governed execution through Copado, wave by wave. Dry-run by default.
   * --live validates (agentia cicd work submit); --deploy also deploys to the next
   * environment and requires an approval given with --allow-deploy.
   */
  async execute(runId: string, opts: ExecuteOptions = {}): Promise<ExecutionRecord> {
    const run = this.loadRun(runId);
    const approval = this.checkApproval(run);
    if (opts.deploy && !approval.allowDeploy) throw new Error(`Approval ${approval.approvalId} does not allow deployment. Approve again with --allow-deploy.`);
    const changeTasks = run.tasks.filter((t) => (t.kind ?? 'change') === 'change');
    const mode = opts.live ? 'live' : 'dry-run';
    const action = opts.deploy ? 'deploy' : 'validate';
    const capability: Capability = opts.deploy ? 'deploy.promote' : 'deploy.validate';
    const ctx = this.ctx(runId, { dryRun: !opts.live, approvalId: approval.approvalId });
    this.audit.append(runId, 'coordinator', 'execute.start', { mode, action, approvalId: approval.approvalId });
    const exec: ExecutionRecord = { runId, approvalId: approval.approvalId, mode, action, results: [] };
    const tmp = { agentCalls: [] as AgentCall[] };
    const waitsOn = (id: string) => (run.schedule?.edges ?? []).some((e) => e.after === id);
    let halted = false;

    for (const wave of run.schedule?.waves ?? []) {
      for (const taskId of wave.tasks) {
        const task = changeTasks.find((t) => t.id === taskId)!;
        if (halted) {
          exec.results.push({ task: task.id, wave: wave.index, copadoStory: task.copadoStory, status: 'NOT-RUN', detail: 'stopped after an earlier failure' });
          continue;
        }
        if (!task.copadoStory) {
          exec.results.push({ task: task.id, wave: wave.index, status: 'SKIPPED', detail: 'no copadoStory mapped to this task' });
          continue;
        }
        const input: DeliveryInput = {
          copadoStory: task.copadoStory,
          cwd: opts.cwd ?? run.source?.repo ?? process.cwd(),
          syncFirst: waitsOn(task.id) || !!task.source?.behindBase,
          runGates: opts.gates !== false,
          publish: !!opts.publish,
          ...(opts.evidence ? { evidence: { name: `Fleet ${run.runId} approved by ${approval.by}`, instructions: evidenceText(run, approval, task.id) } } : {}),
        };
        const { agent, result } = await this.call(tmp, 'execute', capability, input, ctx, { needsDeploy: true });
        const status: ExecStatus = !agent ? 'SKIPPED' : result.evidence === 'mock' ? 'MOCK' : !result.ok ? 'FAILED' : ctx.dryRun ? 'DRY-RUN' : opts.deploy ? 'DEPLOYED' : 'VALIDATED';
        const steps = Array.isArray(result.output) ? (result.output as DeliveryStep[]) : undefined;
        const entry: ExecutionRecord['results'][number] = { task: task.id, wave: wave.index, copadoStory: task.copadoStory, agent, status, ...(steps ? { steps } : { detail: result.ok ? result.output : result.error }) };
        if (status === 'SKIPPED') halted = true; // no agent can deliver: stop, but this is not a Copado failure
        if (status === 'FAILED') {
          const failed = steps?.find((s) => !s.ok);
          const rca = await this.call(tmp, 'rca', 'incident.rca', { story: task.copadoStory, step: failed?.command ?? 'unknown', error: failed?.error ?? result.error ?? '' }, ctx);
          if (rca.result.ok && rca.agent) entry.rca = { agent: rca.agent, via: rca.result.via, output: rca.result.output as RcaOutput };
          this.audit.append(runId, 'coordinator', 'execute.halted', { task: task.id, error: result.error });
          halted = true;
        }
        exec.results.push(entry);
      }
    }

    const real = exec.results.filter((r) => r.status === 'VALIDATED' || r.status === 'DEPLOYED' || r.status === 'FAILED');
    if (real.length && run.simulation) {
      exec.riskAfter = assessRisk(run.simulation, { validation: { ran: true, passed: real.every((r) => r.status !== 'FAILED') && !halted, source: `Copado ${action} via ${[...new Set(real.map((r) => r.agent))].join(', ')}` } });
    }
    this.audit.append(runId, 'coordinator', 'execute.finish', { mode, action, results: exec.results.map((r) => ({ task: r.task, status: r.status })), decisionAfter: exec.riskAfter?.decision });
    writeFileSync(path.join(this.runDir(runId), `execution-${mode}-${action}.json`), JSON.stringify(exec, null, 2));
    return exec;
  }

  /** Read a stopped promotion's conflicts and auto-resolve only those the forecast proved safe. */
  async conflicts(runId: string, promotion: string, opts: { apply?: boolean } = {}): Promise<{ decisions: ConflictDecision[]; resumeHint: string }> {
    const run = this.loadRun(runId);
    const approval = opts.apply ? this.checkApproval(run) : this.loadApproval(runId);
    const mergeable = [...new Set((run.schedule?.mergeable ?? []).map((m) => m.component))];
    const collisions = [...new Set((run.schedule?.collisions ?? []).map((c) => c.key.split('#')[0]))];
    const ctx = this.ctx(runId, { dryRun: !opts.apply, ...(approval ? { approvalId: approval.approvalId } : {}) });
    const tmp = { agentCalls: [] as AgentCall[] };
    const { result } = await this.call(tmp, 'conflicts', 'conflict.resolve', { promotion, mergeable, collisions, apply: !!opts.apply }, ctx);
    if (!result.ok) throw new Error(result.error ?? 'conflict check failed');
    const decisions = result.output as ConflictDecision[];
    writeFileSync(path.join(this.runDir(runId), `conflicts-${promotion}.json`), JSON.stringify(decisions, null, 2));
    this.audit.append(runId, 'coordinator', 'conflicts.checked', { promotion, apply: !!opts.apply, decisions: decisions.map((d) => ({ id: d.conflictId, component: d.component, decision: d.decision, resolved: d.resolved })) });
    return { decisions, resumeHint: `agentia cicd promotion run ${promotion} --resume <job-execution-id> --json` };
  }
}

/** Ordered Copado commands per story, including back-promotion syncs and expected conflicts. */
export function promotionPlan(tasks: TaskInput[], schedule: Schedule): PromotionStep[] {
  const steps: PromotionStep[] = [];
  for (const wave of schedule.waves) {
    for (const id of wave.tasks) {
      const t = tasks.find((x) => x.id === id)!;
      const story = t.copadoStory ?? '<copado story>';
      const waits = schedule.edges.filter((e) => e.after === id);
      const notes: string[] = [];
      for (const e of waits) notes.push(`after ${e.before}: ${e.reason}`);
      for (const m of schedule.mergeable.filter((m) => m.tasks.includes(id))) {
        const other = m.tasks.find((x) => x !== id);
        notes.push(`${m.component} is also changed by ${other} (different elements): a textual Git conflict is possible; \`fleet conflicts <run> --promotion <id> --apply\` resolves it safely`);
      }
      if (t.source?.behindBase) notes.push('branch is behind base');
      const commands = [`agentia cicd work set ${story} --json`];
      if (waits.length || t.source?.behindBase) commands.push('agentia cicd work environment-sync');
      commands.push('agentia cicd work test --json', 'agentia cicd work submit --json            # validate', 'agentia cicd work submit --deploy --json   # deploy to next environment, after approval');
      steps.push({ wave: wave.index, story: id, copadoStory: t.copadoStory, commands, notes });
    }
  }
  return steps;
}

function evidenceText(run: RunRecord, approval: ApprovalRecord, task: string): string {
  const r = run.risk!;
  const mine = run.simulation?.findings.filter((f) => f.stories.includes(task) && f.severity !== 'info') ?? [];
  return [
    `Fleet run ${run.runId}: ${r.decision} (overall ${r.overall}). Approved by ${approval.by} at ${approval.at} (${approval.approvalId}).`,
    `Plan hash ${approval.planHash.slice(0, 16)}.`,
    mine.length ? `Findings for this story: ${mine.map((f) => `${f.id} ${f.severity} ${f.title}`).join(' | ')}` : 'No findings for this story.',
    r.tests.length ? `Verify after deployment: ${r.tests.slice(0, 8).join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 3000);
}

/**
 * Merge AI opinions into the rule-based findings without letting them override the rules.
 * - A concern naming a component already in a finding counts as agreement.
 * - A concern raised by two different agents is "corroborated" (kept, capped at medium).
 * - A concern raised by one agent while another answered without it is capped at low.
 */
export function consolidateOpinionSet(findings: Finding[], opinions: Opinion[]) {
  const agreements: { agent: string; concern: string; finding: string }[] = [];
  const newFindings: Finding[] = [];
  const all = [...findings];
  const reviewers = new Set(opinions.filter((o) => o.capability === 'architecture.review').map((o) => o.agent));
  const handled = new Set<string>();
  for (const o of opinions) {
    for (const c of o.concerns) {
      const match = findings.find((f) => c.components.some((comp) => f.components.includes(comp)));
      if (match) {
        agreements.push({ agent: o.agent, concern: c.title, finding: match.id });
        continue;
      }
      const key = `${o.agent}|${c.title}`;
      if (handled.has(key)) continue;
      handled.add(key);
      const others = opinions.filter((p) => p.agent !== o.agent && p.concerns.some((pc) => pc.components.some((x) => c.components.includes(x))));
      for (const p of others) for (const pc of p.concerns) if (pc.components.some((x) => c.components.includes(x))) handled.add(`${p.agent}|${pc.title}`);
      const corroborated = others.length > 0;
      const contradicted = !corroborated && o.capability === 'architecture.review' && reviewers.size > 1;
      const cap = corroborated ? 'medium' : contradicted ? 'low' : 'medium';
      const severity = c.severity === 'high' ? cap : c.severity === 'medium' && cap === 'low' ? 'low' : c.severity;
      const label = [o.via ? `${o.agent}/${o.via}` : o.agent, ...others.map((p) => p.agent)].join(' + ');
      const f: Finding = {
        id: nextId(all),
        category: 'unverified',
        severity,
        title: `[AI: ${label}] ${c.title}`,
        explanation: `${c.reason} (${corroborated ? 'raised independently by more than one agent' : contradicted ? 'raised by one agent only; the other reviewer did not see it' : 'AI opinion'}, not verified against metadata.)`,
        components: c.components,
        stories: [],
        evidence: ['inference'],
        mitigation: 'Confirm or dismiss before approval.',
      };
      all.push(f);
      newFindings.push(f);
    }
  }
  return { newFindings, agreements };
}

/** Backwards-compatible single-agent form. */
export function consolidateOpinions(findings: Finding[], concerns: ReviewConcern[], agent: string) {
  const { newFindings, agreements } = consolidateOpinionSet(findings, [{ capability: 'architecture.review', agent, concerns }]);
  return { newFindings, agreements: agreements.map(({ concern, finding }) => ({ concern, finding })) };
}
