// Deterministic in-process agents. They need no network, no credentials and no AI,
// so the core always works. External agents add opinions and real validation on top.

import type {
  AgentAdapter,
  AgentDescriptor,
  AgentResult,
  Capability,
  ChangeOp,
  ExecutionContext,
  Schedule,
  SimulationResult,
  TaskInput,
} from '../core/types.ts';
import { assessRisk, type RiskOptions } from '../risk/riskEngine.ts';
import { MetadataState, writeKeys } from '../graph/metadataGraph.ts';
import { schedule } from '../coordinator/planner.ts';
import { simulate } from '../simulation/engine.ts';

const local = (d: Omit<AgentDescriptor, 'mechanism' | 'provider' | 'permissions' | 'costTier' | 'latencyTier'>): AgentDescriptor => ({
  ...d,
  provider: 'fleet (local)',
  mechanism: 'in-process',
  permissions: { write: false, deploy: false, network: false },
  costTier: 'none',
  latencyTier: 'none',
});

abstract class LocalAgent implements AgentAdapter {
  abstract descriptor: AgentDescriptor;
  async isAvailable() {
    return { ok: true };
  }
  async execute(capability: Capability, input: unknown, ctx: ExecutionContext): Promise<AgentResult> {
    if (!this.descriptor.capabilities.includes(capability)) {
      return { ok: false, evidence: 'none', error: `${this.descriptor.id} does not support ${capability}` };
    }
    return this.handle(capability, input, ctx);
  }
  protected abstract handle(capability: Capability, input: unknown, ctx: ExecutionContext): Promise<AgentResult>;
}

// ---------- Requirement agent: validates and normalizes task contracts ----------

export interface RequirementOutput {
  task: TaskInput;
  issues: string[];
}

const OPS = new Set(['create', 'update', 'delete', 'set-node', 'remove-node']);

export function validateTask(t: TaskInput): string[] {
  const issues: string[] = [];
  if (!t.id || !/^[A-Za-z0-9_-]+$/.test(t.id)) issues.push('id must be letters, digits, "-" or "_"');
  if (!t.title) issues.push('title is required');
  const kind = t.kind ?? 'change';
  if (kind === 'change' && !t.changes?.length) issues.push('a change task needs at least one entry in "changes"');
  for (const [i, op] of (t.changes ?? []).entries()) {
    const o = op as ChangeOp & { op: string };
    if (!OPS.has(o.op)) {
      issues.push(`changes[${i}]: unknown op "${o.op}"`);
      continue;
    }
    if (o.op === 'create') {
      if (!o.component?.id || !o.component?.type) issues.push(`changes[${i}]: create needs component.id and component.type`);
      else if (!o.component.id.startsWith(`${o.component.type}:`)) issues.push(`changes[${i}]: id must start with "${o.component.type}:"`);
      if (o.component && !o.component.attributes) issues.push(`changes[${i}]: create needs component.attributes (use {} if none)`);
    } else if (!('id' in o) || !o.id) {
      issues.push(`changes[${i}]: ${o.op} needs "id"`);
    }
    if ((o.op === 'set-node' || o.op === 'remove-node') && !o.node) issues.push(`changes[${i}]: ${o.op} needs "node"`);
  }
  return issues;
}

export class LocalRequirementAgent extends LocalAgent {
  descriptor = local({
    id: 'local.requirements',
    name: 'Requirement Agent (rules)',
    capabilities: ['requirement.analyze'],
    inputSchema: 'TaskInput',
    outputSchema: 'RequirementOutput',
    preference: 1,
  });
  protected async handle(_c: Capability, input: unknown): Promise<AgentResult<RequirementOutput>> {
    const task = structuredClone(input as TaskInput);
    task.kind = task.kind ?? 'change';
    task.acceptanceCriteria = task.acceptanceCriteria ?? [];
    const issues = validateTask(task);
    return { ok: issues.length === 0, output: { task, issues }, evidence: 'local-simulation', ...(issues.length ? { error: issues.join('; ') } : {}) };
  }
}

// ---------- Planner + conflict agent ----------

export class LocalPlannerAgent extends LocalAgent {
  descriptor = local({
    id: 'local.planner',
    name: 'Planning & Conflict Agent (rules)',
    capabilities: ['plan.schedule', 'conflict.detect'],
    inputSchema: 'TaskInput[]',
    outputSchema: 'Schedule',
    preference: 1,
  });
  protected async handle(_c: Capability, input: unknown): Promise<AgentResult<Schedule>> {
    try {
      return { ok: true, output: schedule(input as TaskInput[]), evidence: 'local-simulation' };
    } catch (e) {
      return { ok: false, evidence: 'local-simulation', error: (e as Error).message };
    }
  }
}

// ---------- Impact agent: per-story blast radius against the baseline ----------

export interface ImpactInput {
  baseline: MetadataState;
  task: TaskInput;
}

export class LocalImpactAgent extends LocalAgent {
  descriptor = local({
    id: 'local.impact',
    name: 'Impact Agent (dependency graph)',
    capabilities: ['impact.analyze'],
    inputSchema: 'ImpactInput',
    outputSchema: 'BlastRadius',
    preference: 1,
  });
  protected async handle(_c: Capability, input: unknown): Promise<AgentResult> {
    const { baseline, task } = input as ImpactInput;
    const changed = [...new Set(writeKeys(task.changes ?? []).map((w) => w.component))];
    return { ok: true, output: baseline.blastRadius(changed), evidence: 'local-simulation' };
  }
}

// ---------- Simulation agent ----------

export interface SimulationInput {
  baseline: MetadataState;
  baselineName: string;
  tasks: TaskInput[];
  schedule: Schedule;
}

export class LocalSimulationAgent extends LocalAgent {
  descriptor = local({
    id: 'local.simulation',
    name: 'Simulation Agent (virtual org state)',
    capabilities: ['simulation.run'],
    inputSchema: 'SimulationInput',
    outputSchema: 'SimulationResult',
    preference: 1,
  });
  protected async handle(_c: Capability, input: unknown): Promise<AgentResult<SimulationResult>> {
    return { ok: true, output: simulate(input as SimulationInput), evidence: 'local-simulation' };
  }
}

// ---------- Risk agent ----------

export class LocalRiskAgent extends LocalAgent {
  descriptor = local({
    id: 'local.risk',
    name: 'Risk Agent (explainable rules)',
    capabilities: ['risk.assess'],
    inputSchema: '{ simulation, options }',
    outputSchema: 'RiskReport',
    preference: 1,
  });
  protected async handle(_c: Capability, input: unknown): Promise<AgentResult> {
    const { simulation, options } = input as { simulation: SimulationResult; options?: RiskOptions };
    return { ok: true, output: assessRisk(simulation, options), evidence: 'local-simulation' };
  }
}

export function localAgents(): AgentAdapter[] {
  return [new LocalRequirementAgent(), new LocalPlannerAgent(), new LocalImpactAgent(), new LocalSimulationAgent(), new LocalRiskAgent()];
}
