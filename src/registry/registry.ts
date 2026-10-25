// Agent registry and capability router.
// Routing picks the best available, permitted agent for a capability and falls back to
// the next candidate when one fails. Agents are added by registering an adapter; the
// coordinator never names a specific agent.

import type {
  AgentAdapter,
  AgentDescriptor,
  AgentResult,
  Availability,
  Capability,
  ExecutionContext,
  Tier,
} from '../core/types.ts';

export interface RoutePolicy {
  /** Agents that may never be used in this run (e.g. third-party AI not allowed by rules). */
  deny?: string[];
  /** Block agents that send data off the machine. */
  offline?: boolean;
  /** The task needs write access. */
  needsWrite?: boolean;
  /** The task deploys/promotes. Requires an approval id in the context. */
  needsDeploy?: boolean;
  /** Prefer real tools over mock adapters even if mocks rank higher. Default true. */
  preferReal?: boolean;
}

export interface Reliability {
  success: number;
  failure: number;
  totalMs: number;
}

export interface RouteDecision {
  capability: Capability;
  chosen?: string;
  candidates: { id: string; score: number; available: boolean; excludedBecause?: string }[];
}

const tierCost: Record<Tier, number> = { none: 0, low: 1, medium: 2, high: 3 };

export class AgentRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly availabilityCache = new Map<string, Availability>();
  readonly reliability = new Map<string, Reliability>();

  register(adapter: AgentAdapter): this {
    const d = adapter.descriptor;
    if (this.adapters.has(d.id)) throw new Error(`Agent ${d.id} is already registered`);
    if (!d.capabilities.length) throw new Error(`Agent ${d.id} declares no capabilities`);
    this.adapters.set(d.id, adapter);
    this.reliability.set(d.id, { success: 0, failure: 0, totalMs: 0 });
    return this;
  }

  unregister(id: string): void {
    this.adapters.delete(id);
    this.availabilityCache.delete(id);
  }

  list(): AgentDescriptor[] {
    return [...this.adapters.values()].map((a) => a.descriptor);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  async availability(id: string): Promise<Availability> {
    const cached = this.availabilityCache.get(id);
    if (cached) return cached;
    const a = this.adapters.get(id);
    const result = a ? await a.isAvailable().catch((e: Error) => ({ ok: false, reason: e.message })) : { ok: false, reason: 'not registered' };
    this.availabilityCache.set(id, result);
    return result;
  }

  async discover(): Promise<(AgentDescriptor & { availability: Availability })[]> {
    return Promise.all(this.list().map(async (d) => ({ ...d, availability: await this.availability(d.id) })));
  }

  /** Rank candidates for a capability. Lower score is better. */
  async route(capability: Capability, policy: RoutePolicy, ctx?: ExecutionContext): Promise<RouteDecision> {
    const preferReal = policy.preferReal ?? true;
    const candidates: RouteDecision['candidates'] = [];
    for (const a of this.adapters.values()) {
      const d = a.descriptor;
      if (!d.capabilities.includes(capability)) continue;
      const av = await this.availability(d.id);
      let excludedBecause: string | undefined;
      if (!av.ok) excludedBecause = `unavailable: ${av.reason ?? 'unknown'}`;
      else if (policy.deny?.includes(d.id)) excludedBecause = 'denied by policy';
      else if (policy.offline && d.permissions.network) excludedBecause = 'network agents disabled (offline policy)';
      else if (policy.needsWrite && !d.permissions.write) excludedBecause = 'agent has no write permission';
      else if (policy.needsDeploy && !d.permissions.deploy) excludedBecause = 'agent has no deploy permission';
      else if (policy.needsDeploy && !d.mock && !ctx?.approvalId) excludedBecause = 'deploy requires an explicit human approval';
      const r = this.reliability.get(d.id)!;
      const runs = r.success + r.failure;
      const failRate = runs ? r.failure / runs : 0;
      const score =
        d.preference * 10 +
        tierCost[d.costTier] +
        tierCost[d.latencyTier] +
        failRate * 20 +
        (preferReal && d.mock ? 50 : 0);
      candidates.push({ id: d.id, score: Number(score.toFixed(2)), available: av.ok, ...(excludedBecause ? { excludedBecause } : {}) });
    }
    candidates.sort((x, y) => x.score - y.score);
    const chosen = candidates.find((c) => !c.excludedBecause)?.id;
    return { capability, chosen, candidates };
  }

  /**
   * Ask up to `n` different eligible agents in parallel (second opinions).
   * Returns only the successful answers, best-ranked first.
   */
  async invokeMany(
    capability: Capability,
    input: unknown,
    ctx: ExecutionContext,
    policy: RoutePolicy = {},
    n = 2,
  ): Promise<{ agent: string; result: AgentResult }[]> {
    const route = await this.route(capability, policy, ctx);
    const eligible = route.candidates.filter((c) => !c.excludedBecause).slice(0, n);
    const results = await Promise.all(
      eligible.map(async (cand) => {
        const started = Date.now();
        ctx.log('agent.invoke', { agent: cand.id, capability, attempt: 1, mode: 'second-opinion' });
        let result: AgentResult;
        try {
          result = await this.adapters.get(cand.id)!.execute(capability, input, ctx);
        } catch (e) {
          result = { ok: false, evidence: 'none', error: (e as Error).message };
        }
        const ms = Date.now() - started;
        const r = this.reliability.get(cand.id)!;
        r.totalMs += ms;
        if (result.ok) r.success++;
        else r.failure++;
        ctx.log('agent.result', { agent: cand.id, capability, ok: result.ok, error: result.error, ms });
        return { agent: cand.id, result: { ...result, durationMs: ms } };
      }),
    );
    return results;
  }

  /**
   * Route and execute with retries and fallback.
   * Each agent gets `retries + 1` attempts; then the next eligible candidate is tried.
   */
  async invoke(
    capability: Capability,
    input: unknown,
    ctx: ExecutionContext,
    policy: RoutePolicy = {},
    retries = 1,
  ): Promise<{ agent?: string; result: AgentResult; route: RouteDecision }> {
    const route = await this.route(capability, policy, ctx);
    const eligible = route.candidates.filter((c) => !c.excludedBecause);
    if (!eligible.length) {
      return {
        route,
        result: { ok: false, evidence: 'none', error: `No eligible agent for ${capability}: ${route.candidates.map((c) => `${c.id} (${c.excludedBecause})`).join('; ') || 'none registered'}` },
      };
    }
    let last: AgentResult = { ok: false, evidence: 'none', error: 'not run' };
    let realFailed = false;
    for (const cand of eligible) {
      const adapter = this.adapters.get(cand.id)!;
      // A mock never stands in for a real agent that ran and failed: that would hide the failure.
      if (adapter.descriptor.mock && realFailed) continue;
      // Agents that change things are never retried automatically (a retried submit could deploy twice).
      const attempts = adapter.descriptor.permissions.write || adapter.descriptor.permissions.deploy ? 1 : retries + 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const started = Date.now();
        ctx.log('agent.invoke', { agent: cand.id, capability, attempt });
        try {
          last = await adapter.execute(capability, input, ctx);
        } catch (e) {
          last = { ok: false, evidence: 'none', error: (e as Error).message };
        }
        const ms = Date.now() - started;
        const r = this.reliability.get(cand.id)!;
        r.totalMs += ms;
        if (last.ok) {
          r.success++;
          ctx.log('agent.result', { agent: cand.id, capability, ok: true, evidence: last.evidence, ms });
          return { agent: cand.id, result: { ...last, durationMs: ms }, route };
        }
        r.failure++;
        ctx.log('agent.result', { agent: cand.id, capability, ok: false, error: last.error, attempt, ms });
      }
      if (!adapter.descriptor.mock) realFailed = true;
      // A failed write never falls through to another agent that writes: the first one may have
      // changed Copado already, and a second path could promote or deploy the same story again.
      if (!adapter.descriptor.mock && (adapter.descriptor.permissions.write || adapter.descriptor.permissions.deploy)) {
        ctx.log('agent.stop', { agent: cand.id, capability, reason: 'write failed; no fallback' });
        return { agent: cand.id, result: last, route };
      }
      ctx.log('agent.fallback', { from: cand.id, capability });
    }
    return { result: last, route };
  }
}
