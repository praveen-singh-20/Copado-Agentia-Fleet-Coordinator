// Dependency-aware scheduler: decides which tasks can run in parallel and which must wait.
// Works on what each task writes and reads, at sub-component (node) granularity for
// Profiles and Permission Sets, so two stories touching different FLS entries of the
// same profile can still run in parallel.

import type { ComponentId, Schedule, TaskInput } from '../core/types.ts';
import { readKeys, writeKeys } from '../graph/metadataGraph.ts';

interface TaskFootprint {
  id: string;
  order: number;
  creates: Set<ComponentId>;
  deletes: Set<ComponentId>;
  reads: Set<ComponentId>;
  wholeWrites: Set<ComponentId>; // component-level writes
  nodeWrites: Map<ComponentId, Set<string>>; // component -> nodes
}

export function footprint(task: TaskInput, order: number): TaskFootprint {
  const ops = task.changes ?? [];
  const f: TaskFootprint = {
    id: task.id,
    order,
    creates: new Set(),
    deletes: new Set(),
    reads: new Set(readKeys(ops)),
    wholeWrites: new Set(),
    nodeWrites: new Map(),
  };
  for (const op of ops) {
    if (op.op === 'create') f.creates.add(op.component.id);
    if (op.op === 'delete') f.deletes.add(op.id);
  }
  for (const w of writeKeys(ops)) {
    if (w.node) {
      if (!f.nodeWrites.has(w.component)) f.nodeWrites.set(w.component, new Set());
      f.nodeWrites.get(w.component)!.add(w.node);
    } else {
      f.wholeWrites.add(w.component);
    }
  }
  // A task's own creations are not external reads.
  for (const c of f.creates) f.reads.delete(c);
  return f;
}

export function schedule(tasks: TaskInput[]): Schedule {
  const fps = tasks.map((t, i) => footprint(t, i));
  const edges: Schedule['edges'] = [];
  const collisions: Schedule['collisions'] = [];
  const mergeable: Schedule['mergeable'] = [];
  const addEdge = (before: string, after: string, reason: string) => {
    if (before === after) return;
    if (!edges.some((e) => e.before === before && e.after === after)) edges.push({ before, after, reason });
  };

  for (const a of fps) {
    for (const b of fps) {
      if (a.id === b.id) continue;
      // Creation before use.
      for (const c of a.creates) if (b.reads.has(c)) addEdge(a.id, b.id, `${b.id} uses ${c}, which ${a.id} creates`);
      // Use before deletion (the simulation will still flag the dangling reference).
      for (const d of a.deletes) if (b.reads.has(d)) addEdge(b.id, a.id, `${a.id} deletes ${d}, which ${b.id} uses`);
    }
  }

  // Write overlaps: only look at each pair once.
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      const a = fps[i], b = fps[j];
      for (const c of a.wholeWrites) {
        if (b.wholeWrites.has(c) || b.nodeWrites.has(c)) {
          collisions.push({ tasks: [a.id, b.id], key: c });
          addEdge(a.id, b.id, `both write ${c}; serialized in submission order`);
        }
      }
      for (const [c, aNodes] of a.nodeWrites) {
        if (b.wholeWrites.has(c) && !a.wholeWrites.has(c)) {
          collisions.push({ tasks: [a.id, b.id], key: c });
          addEdge(a.id, b.id, `both write ${c}; serialized in submission order`);
          continue;
        }
        const bNodes = b.nodeWrites.get(c);
        if (!bNodes) continue;
        const shared = [...aNodes].filter((n) => bNodes.has(n));
        if (shared.length) {
          for (const n of shared) collisions.push({ tasks: [a.id, b.id], key: `${c}#${n}` });
          addEdge(a.id, b.id, `both change ${c}#${shared.join(',')}; serialized in submission order`);
        } else {
          mergeable.push({ tasks: [a.id, b.id], component: c, nodes: [...new Set([...aNodes, ...bNodes])] });
        }
      }
    }
  }

  // Kahn's algorithm in layers. Layer = wave of tasks that can run concurrently.
  const indeg = new Map(fps.map((f) => [f.id, 0]));
  for (const e of edges) indeg.set(e.after, (indeg.get(e.after) ?? 0) + 1);
  const order = new Map(fps.map((f) => [f.id, f.order]));
  const waves: Schedule['waves'] = [];
  const done = new Set<string>();
  let current = fps.filter((f) => indeg.get(f.id) === 0).map((f) => f.id);

  while (current.length) {
    current.sort((x, y) => order.get(x)! - order.get(y)!);
    const reasons = current.map((t) => {
      const waitedOn = edges.filter((e) => e.after === t).map((e) => e.before);
      return waitedOn.length ? `${t} after ${waitedOn.join(', ')}` : `${t} has no prerequisites`;
    });
    waves.push({ index: waves.length + 1, tasks: current, reason: reasons.join('; ') });
    for (const t of current) done.add(t);
    const next: string[] = [];
    for (const e of edges) {
      if (!current.includes(e.before)) continue;
      indeg.set(e.after, indeg.get(e.after)! - 1);
      if (indeg.get(e.after) === 0 && !done.has(e.after)) next.push(e.after);
    }
    current = [...new Set(next)];
  }

  if (done.size !== fps.length) {
    const stuck = fps.filter((f) => !done.has(f.id)).map((f) => f.id);
    throw new Error(`Dependency cycle between tasks: ${stuck.join(', ')}. Split or reorder these stories.`);
  }

  return { waves, edges, mergeable, collisions };
}
