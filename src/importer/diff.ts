// Turn two snapshots (before/after a story) into the change ops the simulator understands.

import type { ChangeOp, Component, ComponentId, Dependency, MetadataSnapshot } from '../core/types.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffToChanges(before: MetadataSnapshot, after: MetadataSnapshot): ChangeOp[] {
  const b = new Map(before.components.map((c) => [c.id, c]));
  const a = new Map(after.components.map((c) => [c.id, c]));
  const out = (s: MetadataSnapshot) => {
    const m = new Map<ComponentId, Dependency[]>();
    for (const d of s.dependencies) m.set(d.from, [...(m.get(d.from) ?? []), d]);
    return m;
  };
  const bOut = out(before);
  const aOut = out(after);
  const creates: ChangeOp[] = [];
  const updates: ChangeOp[] = [];
  const deletes: ChangeOp[] = [];

  const real = (c: Component | undefined) => !!c && !c.attributes.implicit;
  for (const [id, comp] of a) {
    const prev = real(b.get(id)) ? b.get(id) : undefined;
    if (prev === undefined && !real(comp)) continue; // placeholder on both sides, or new placeholder
    if (prev && !real(comp)) continue; // real → placeholder: handled as a delete below
    // Same source file → same component; dependencies resolved differently because other
    // files changed are not a change to this component.
    if (prev?.hash && prev.hash === comp.hash) continue;
    if (!prev) {
      const { nodes, hash: _h, ...rest } = comp;
      creates.push({
        op: 'create',
        component: rest as Component,
        references: (aOut.get(id) ?? []).map((d) => ({ to: d.to, kind: d.kind, source: d.source })),
      });
      for (const [node, value] of Object.entries(nodes ?? {})) updates.push({ op: 'set-node', id, node, value });
      continue;
    }
    // Attributes
    const changed: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(prev.attributes), ...Object.keys(comp.attributes)])) {
      if (!same(prev.attributes[k], comp.attributes[k])) changed[k] = comp.attributes[k] ?? null;
    }
    // Outgoing dependencies
    const key = (d: Dependency) => `${d.to}|${d.kind}`;
    const prevDeps = new Map((bOut.get(id) ?? []).map((d) => [key(d), d]));
    const nextDeps = new Map((aOut.get(id) ?? []).map((d) => [key(d), d]));
    const added = [...nextDeps.entries()].filter(([k]) => !prevDeps.has(k)).map(([, d]) => ({ to: d.to, kind: d.kind, source: d.source }));
    const stillTargeted = new Set([...nextDeps.values()].map((d) => d.to));
    const removed = [...new Set([...prevDeps.values()].map((d) => d.to))].filter((t) => !stillTargeted.has(t));
    if (Object.keys(changed).length || added.length || removed.length) {
      updates.push({
        op: 'update',
        id,
        ...(Object.keys(changed).length ? { attributes: changed } : {}),
        ...(added.length ? { references: added } : {}),
        ...(removed.length ? { removeReferences: removed } : {}),
      });
    }
    // Sub-nodes (profiles / permission sets)
    for (const node of new Set([...Object.keys(prev.nodes ?? {}), ...Object.keys(comp.nodes ?? {})])) {
      const pv = prev.nodes?.[node];
      const nv = comp.nodes?.[node];
      if (same(pv, nv)) continue;
      if (nv === undefined) updates.push({ op: 'remove-node', id, node });
      else updates.push({ op: 'set-node', id, node, value: nv });
    }
  }
  for (const [id, comp] of b) {
    if (real(comp) && !real(a.get(id))) deletes.push({ op: 'delete', id });
  }
  // Creates first, deletes last: matches how a deployment applies them.
  return [...creates, ...updates, ...deletes];
}

/** One-line description of an op, for reports and AI prompts. */
export function describeOp(op: ChangeOp): string {
  switch (op.op) {
    case 'create':
      return `create ${op.component.id}`;
    case 'delete':
      return `delete ${op.id}`;
    case 'set-node':
      return `set ${op.id}#${op.node} = ${JSON.stringify(op.value)}`;
    case 'remove-node':
      return `remove ${op.id}#${op.node}`;
    case 'update':
      return `update ${op.id}${op.attributes ? ` (${Object.keys(op.attributes).join(', ')})` : ''}${op.references?.length ? ` +refs ${op.references.map((r) => r.to).join(', ')}` : ''}${op.removeReferences?.length ? ` -refs ${op.removeReferences.join(', ')}` : ''}`;
  }
}
