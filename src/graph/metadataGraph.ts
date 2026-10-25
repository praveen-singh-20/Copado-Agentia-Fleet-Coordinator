// In-memory metadata state + dependency graph.
// The baseline is never mutated: simulations work on a clone.

import type {
  BlastRadius,
  ChangeOp,
  Component,
  ComponentId,
  Dependency,
  ImpactEntry,
  MetadataSnapshot,
} from '../core/types.ts';

export class MetadataState {
  readonly components = new Map<ComponentId, Component>();
  dependencies: Dependency[] = [];

  static fromSnapshot(snapshot: MetadataSnapshot): MetadataState {
    validateSnapshot(snapshot);
    const s = new MetadataState();
    for (const c of snapshot.components) s.components.set(c.id, structuredClone(c));
    s.dependencies = snapshot.dependencies.map((d) => ({ ...d }));
    return s;
  }

  clone(): MetadataState {
    const s = new MetadataState();
    for (const [id, c] of this.components) s.components.set(id, structuredClone(c));
    s.dependencies = this.dependencies.map((d) => ({ ...d }));
    return s;
  }

  has(id: ComponentId): boolean {
    return this.components.has(id);
  }

  get(id: ComponentId): Component | undefined {
    return this.components.get(id);
  }

  /** Components that depend on `id` (incoming edges). */
  dependents(id: ComponentId): Dependency[] {
    return this.dependencies.filter((d) => d.to === id);
  }

  /** Components that `id` depends on (outgoing edges). */
  requirements(id: ComponentId): Dependency[] {
    return this.dependencies.filter((d) => d.from === id);
  }

  /**
   * Apply one change op. Returns problems found while applying (for example,
   * updating a component that does not exist). Never throws for domain problems,
   * because the simulation wants to report them, not crash.
   */
  apply(op: ChangeOp): string[] {
    const problems: string[] = [];
    switch (op.op) {
      case 'create': {
        const existing = this.components.get(op.component.id);
        if (existing && !existing.attributes.implicit) problems.push(`${op.component.id} already exists`);
        this.components.set(op.component.id, structuredClone(op.component));
        for (const r of op.references ?? []) {
          this.dependencies.push({ from: op.component.id, to: r.to, kind: r.kind, source: r.source ?? 'metadata' });
        }
        break;
      }
      case 'update': {
        const c = this.components.get(op.id);
        if (!c) {
          problems.push(`${op.id} does not exist (update)`);
          break;
        }
        if (op.attributes) c.attributes = { ...c.attributes, ...op.attributes };
        if (op.removeReferences?.length) {
          this.dependencies = this.dependencies.filter((d) => !(d.from === op.id && op.removeReferences!.includes(d.to)));
        }
        for (const r of op.references ?? []) {
          const exists = this.dependencies.some((d) => d.from === op.id && d.to === r.to && d.kind === r.kind);
          if (!exists) this.dependencies.push({ from: op.id, to: r.to, kind: r.kind, source: r.source ?? 'metadata' });
        }
        break;
      }
      case 'delete': {
        if (!this.components.delete(op.id)) problems.push(`${op.id} does not exist (delete)`);
        // Outgoing edges disappear with the component. Incoming edges stay: they are
        // now dangling references, which is exactly what the simulation must detect.
        this.dependencies = this.dependencies.filter((d) => d.from !== op.id);
        break;
      }
      case 'set-node': {
        const c = this.components.get(op.id);
        if (!c) {
          problems.push(`${op.id} does not exist (set-node ${op.node})`);
          break;
        }
        c.nodes = c.nodes ?? {};
        c.nodes[op.node] = { ...(c.nodes[op.node] ?? {}), ...op.value };
        break;
      }
      case 'remove-node': {
        const c = this.components.get(op.id);
        if (!c?.nodes?.[op.node]) {
          problems.push(`${op.id} has no node ${op.node}`);
          break;
        }
        delete c.nodes[op.node];
        break;
      }
    }
    return problems;
  }

  /** Edges that point to components which no longer exist. */
  danglingReferences(): Dependency[] {
    return this.dependencies.filter((d) => this.components.has(d.from) && !this.exists(d.to));
  }

  /** True for real components; placeholders for referenced-but-absent metadata do not count. */
  exists(id: ComponentId): boolean {
    const c = this.components.get(id);
    if (!c) return false;
    // Standard objects (Account, Contact…) always exist in an org even without a file in the repo.
    if (c.attributes.implicit) return c.type === 'CustomObject' && !/__c$/.test(id);
    return true;
  }

  /**
   * Walk incoming edges outward from the changed components.
   * depth 1 = direct, depth >= 2 = indirect. Each entry keeps the path that explains it.
   */
  blastRadius(changed: ComponentId[], maxDepth = 4): BlastRadius {
    const seen = new Map<ComponentId, ImpactEntry>();
    const changedSet = new Set(changed);
    let frontier: { id: ComponentId; via: ImpactEntry['via'] }[] = changed.map((id) => ({ id, via: [] }));

    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next: typeof frontier = [];
      for (const { id, via } of frontier) {
        for (const d of this.dependents(id)) {
          if (changedSet.has(d.from) || seen.has(d.from)) continue;
          const path = [...via, { from: d.from, to: d.to, kind: d.kind, source: d.source }];
          const entry: ImpactEntry = {
            component: d.from,
            depth,
            via: path,
            tags: this.components.get(d.from)?.tags ?? [],
          };
          seen.set(d.from, entry);
          next.push({ id: d.from, via: path });
        }
      }
      frontier = next;
    }

    const all = [...seen.values()];
    return {
      changed,
      direct: all.filter((e) => e.depth === 1),
      indirect: all.filter((e) => e.depth > 1),
    };
  }
}

export function validateSnapshot(s: MetadataSnapshot): void {
  if (!s || !Array.isArray(s.components) || !Array.isArray(s.dependencies)) {
    throw new Error('Snapshot must have "components" and "dependencies" arrays');
  }
  const ids = new Set<string>();
  for (const c of s.components) {
    if (!c.id || !c.type) throw new Error(`Component without id/type: ${JSON.stringify(c)}`);
    if (!c.id.startsWith(`${c.type}:`)) throw new Error(`Component id "${c.id}" must start with "${c.type}:"`);
    if (ids.has(c.id)) throw new Error(`Duplicate component id ${c.id}`);
    ids.add(c.id);
  }
  for (const d of s.dependencies) {
    if (!ids.has(d.from)) throw new Error(`Dependency from unknown component ${d.from}`);
    if (!ids.has(d.to)) throw new Error(`Dependency to unknown component ${d.to}`);
  }
}

/** Ids touched by a list of ops, with node granularity for container types. */
export function writeKeys(ops: ChangeOp[]): { component: ComponentId; key: string; node?: string }[] {
  return ops.map((op) => {
    switch (op.op) {
      case 'create':
        return { component: op.component.id, key: op.component.id };
      case 'set-node':
      case 'remove-node':
        return { component: op.id, key: `${op.id}#${op.node}`, node: op.node };
      default:
        return { component: op.id, key: op.id };
    }
  });
}

/** Ids a list of ops needs to exist beforehand (explicit references plus targets of updates). */
export function readKeys(ops: ChangeOp[]): ComponentId[] {
  const out = new Set<ComponentId>();
  for (const op of ops) {
    if (op.op === 'create' || op.op === 'update') for (const r of op.references ?? []) out.add(r.to);
    if (op.op === 'update' || op.op === 'set-node') out.add(op.id);
    if (op.op === 'set-node') {
      // A node like "fieldPermissions:Account.Customer_Tier__c" needs that field to exist.
      const field = nodeTarget(op.node);
      if (field) out.add(field);
    }
  }
  return [...out];
}

/** Map a permission node to the component it grants access to. */
export function nodeTarget(node: string): ComponentId | undefined {
  const [kind, name] = node.split(':');
  if (!name) return undefined;
  if (kind === 'fieldPermissions') return name.endsWith('__c') ? `CustomField:${name}` : undefined;
  if (kind === 'objectPermissions') return `CustomObject:${name}`;
  if (kind === 'classAccesses') return `ApexClass:${name}`;
  return undefined;
}
