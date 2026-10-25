// Simulation Engine: apply every proposed story to an isolated copy of the baseline,
// in the order the scheduler chose, then compare BEFORE with SIMULATED AFTER and run
// deterministic rules over the combined end state.
//
// This is a model of metadata and dependencies, not a Salesforce runtime. Results are
// labeled "local-simulation"; only Copado/Salesforce validation counts as validated.

import type {
  ComponentDiff,
  ComponentId,
  Finding,
  Schedule,
  SimulationResult,
  TaskInput,
} from '../core/types.ts';
import { MetadataState, nodeTarget } from '../graph/metadataGraph.ts';

export const SIMULATION_LIMITATIONS = [
  'Local model of metadata and dependencies; no Apex, Flow or formula is executed.',
  'Only dependencies present in the snapshot are known; dynamic SOQL, string-built field names and external systems not described in configuration are invisible.',
  'Field-level security is evaluated per Profile/Permission Set node; permission set groups, muting and sharing rules are not modeled.',
  'Data-dependent effects (existing records failing new validation, volumes, limits) are not modeled.',
  'A clean simulation is not a deployment validation. Run Copado validation (agentia cicd work submit) before promotion.',
];

export interface SimulationInput {
  baseline: MetadataState;
  baselineName: string;
  tasks: TaskInput[];
  schedule: Schedule;
}

export function simulate({ baseline, baselineName, tasks, schedule }: SimulationInput): SimulationResult {
  const after = baseline.clone(); // the baseline is never touched
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const touchedBy = new Map<ComponentId, Set<string>>();
  const nodeTouchedBy = new Map<string, Set<string>>();
  const findings: Finding[] = [];
  let seq = 0;
  const fid = () => `F${String(++seq).padStart(3, '0')}`;
  const mark = (map: Map<string, Set<string>>, key: string, story: string) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(story);
  };

  // 1. Apply in scheduled order.
  for (const wave of schedule.waves) {
    for (const taskId of wave.tasks) {
      const task = byId.get(taskId)!;
      for (const op of task.changes ?? []) {
        const problems = after.apply(op);
        const id = op.op === 'create' ? op.component.id : op.id;
        mark(touchedBy, id, task.id);
        if (op.op === 'set-node' || op.op === 'remove-node') mark(nodeTouchedBy, `${op.id}#${op.node}`, task.id);
        for (const p of problems) {
          findings.push({
            id: fid(),
            category: 'deployment',
            severity: 'high',
            title: `Change cannot be applied: ${p}`,
            explanation: `${task.id} expects state that does not exist at its point in the schedule (wave ${wave.index}).`,
            components: [id],
            stories: [task.id],
            evidence: ['metadata'],
            mitigation: 'Check the story against the current org state, or add the missing prerequisite story.',
          });
        }
      }
    }
  }

  const changed = [...touchedBy.keys()];
  const storiesFor = (id: ComponentId) => [...(touchedBy.get(id) ?? [])];

  // 2. Dangling references created by deletions.
  for (const d of after.danglingReferences()) {
    // Only problems this batch causes or touches; pre-existing gaps in the org are not ours to report.
    if (!touchedBy.has(d.to) && !touchedBy.has(d.from)) continue;
    const from = after.get(d.from)!;
    const wasReal = baseline.exists(d.to);
    if (!wasReal) {
      findings.push({
        id: fid(),
        category: 'dependency',
        severity: d.source === 'inference' ? 'medium' : 'high',
        title: `${d.from} ${d.kind} ${d.to}, which does not exist`,
        explanation: `${storiesFor(d.from).join(', ') || 'A story'} makes ${d.from} depend on ${d.to}, but it is not in the baseline and no story in this batch creates it. The deployment is expected to fail with a missing dependency.`,
        components: [d.to, d.from],
        stories: storiesFor(d.from),
        evidence: [d.source],
        mitigation: `Add the story that creates ${d.to} to this batch (it will be scheduled first), or remove the reference.`,
      });
      continue;
    }
    const prodAutomation = from.tags?.includes('production-automation');
    const inferred = d.source === 'inference';
    findings.push({
      id: fid(),
      category: from.type === 'Flow' || from.type === 'ApexClass' || from.type === 'ApexTrigger' ? 'automation' : 'dependency',
      // An inferred edge may be wrong, so it is reported one level lower and says so.
      severity: inferred ? 'medium' : 'high',
      title: `${d.from} still ${d.kind} ${d.to}, which is deleted`,
      explanation:
        `${storiesFor(d.to).join(', ') || 'A story'} deletes ${d.to}, but ${d.from} ${d.kind} it (found via ${d.source}). ` +
        (inferred
          ? 'This dependency is inferred (e.g. dynamic SOQL), so confirm it before acting; if real, the component fails at runtime, not at deploy time.'
          : prodAutomation
            ? `${d.from} is tagged production-automation, so this breaks running automation and the deployment is expected to fail.`
            : 'The deployment is expected to fail or the component will break.'),
      components: [d.to, d.from],
      stories: storiesFor(d.to),
      evidence: [d.source],
      mitigation: `Remove the reference in ${d.from} first (same story or an earlier one), or deprecate ${d.to} instead of deleting it.`,
      tests: [`Regression test for ${d.from}`],
    });
  }

  // 2b. Permission nodes that still point at deleted components. Copado documents that
  // profiles referencing metadata missing from the target org can fail retrieval/commit.
  for (const c of after.components.values()) {
    if (c.type !== 'Profile' && c.type !== 'PermissionSet') continue;
    for (const node of Object.keys(c.nodes ?? {})) {
      const target = nodeTarget(node);
      if (!target || after.exists(target) || !touchedBy.has(target)) continue;
      findings.push({
        id: fid(),
        category: 'deployment',
        severity: 'high',
        title: `${c.id} still has ${node} for deleted ${target}`,
        explanation: `${storiesFor(target).join(', ')} deletes ${target}, but ${c.id} keeps a permission entry for it. Profiles and permission sets that reference missing metadata fail to deploy.`,
        components: [c.id, target],
        stories: storiesFor(target),
        evidence: ['metadata'],
        mitigation: `Add a remove-node for ${c.id}#${node} to the story that deletes ${target}.`,
      });
    }
  }

  // 3. Write collisions and parallel-safe merges found by the scheduler.
  for (const c of schedule.collisions) {
    findings.push({
      id: fid(),
      category: 'conflict',
      severity: 'medium',
      title: `Overlapping change on ${c.key}`,
      explanation: `${c.tasks.join(' and ')} change the same element. The coordinator serialized them, but the later story overwrites the earlier one unless it is rebased on it.`,
      components: [c.key.split('#')[0]],
      stories: c.tasks,
      evidence: ['metadata'],
      mitigation: `Rebase ${c.tasks[1]} on ${c.tasks[0]} before commit, or merge both changes into one story.`,
    });
  }
  for (const m of schedule.mergeable) {
    findings.push({
      id: fid(),
      category: 'conflict',
      severity: 'info',
      title: `Same file, different elements: ${m.component}`,
      explanation: `${m.tasks.join(' and ')} edit different nodes (${m.nodes.join(', ')}). A node-level merge is safe, so they may run in parallel. A file-level Git merge may still show a textual conflict.`,
      components: [m.component],
      stories: m.tasks,
      evidence: ['metadata'],
      mitigation: 'Merge at XML node level; let Copado auto-resolve or use agentia cicd promotion conflict resolve --mode auto.',
    });
  }

  // 4. Task assumptions checked against the combined end state.
  const reevaluate: SimulationResult['reevaluate'] = [];
  for (const task of tasks) {
    for (const a of task.assumptions ?? []) {
      let holds = true;
      let detail = '';
      let related: ComponentId = a.id;
      if (a.type === 'component-exists') {
        holds = after.exists(a.id);
        detail = `${a.id} must exist`;
      } else {
        const actual = after.get(a.id)?.nodes?.[a.node]?.[a.flag];
        holds = actual === a.equals;
        detail = `${a.id} ${a.node}.${a.flag} must be ${JSON.stringify(a.equals)}, simulated value is ${JSON.stringify(actual)}`;
        related = a.id;
      }
      if (holds) continue;
      const culprits = [
        ...storiesFor(related),
        ...(a.type === 'node-flag' ? [...(nodeTouchedBy.get(`${a.id}#${a.node}`) ?? [])] : []),
      ].filter((s, i, arr) => s !== task.id && arr.indexOf(s) === i);
      findings.push({
        id: fid(),
        category: 'assumption',
        severity: 'high',
        title: `${task.id} assumption broken: ${a.reason ?? detail}`,
        explanation: `${detail}.${culprits.length ? ` Changed by ${culprits.join(', ')}.` : ' No story in this batch provides it.'}`,
        components: [a.id],
        stories: [task.id, ...culprits],
        evidence: ['metadata'],
        mitigation: culprits.length
          ? `Align ${culprits.join(', ')} with ${task.id}, then rerun the simulation.`
          : `Add the missing prerequisite to the batch or drop the assumption from ${task.id}.`,
      });
      reevaluate.push({ task: task.id, because: detail, triggeredBy: culprits });
    }
  }

  // 5. Integration rule: inbound field mappings need edit access for the run-as user.
  for (const c of after.components.values()) {
    if (c.type !== 'IntegrationMapping') continue;
    const runAs = c.attributes.runAs as ComponentId | undefined;
    const mappings = (c.attributes.fieldMappings as { field: ComponentId; direction: string }[] | undefined) ?? [];
    if (!runAs) continue;
    for (const m of mappings) {
      if (m.direction !== 'inbound' && m.direction !== 'bidirectional') continue;
      const node = `fieldPermissions:${m.field.replace(/^CustomField:/, '')}`;
      const nodeKey = `${runAs}#${node}`;
      const relevant = touchedBy.has(c.id) || touchedBy.has(m.field) || nodeTouchedBy.has(nodeKey);
      if (!relevant) continue;
      const editable = after.get(runAs)?.nodes?.[node]?.editable === true;
      if (editable) continue;
      const mappingStories = storiesFor(c.id);
      const permStories = [...(nodeTouchedBy.get(nodeKey) ?? [])];
      findings.push({
        id: fid(),
        category: 'integration',
        severity: 'high',
        title: `${c.id} writes ${m.field}, but ${runAs} cannot edit it`,
        explanation:
          `The mapping is ${m.direction} and runs as ${runAs}. In the simulated end state ${runAs} ${node} has editable=${String(after.get(runAs)?.nodes?.[node]?.editable ?? 'unset')}. ` +
          `Each story looks fine alone; the conflict only appears when ${[...mappingStories, ...permStories].join(' + ') || 'the batch'} are combined.`,
        components: [c.id, runAs, m.field],
        stories: [...new Set([...mappingStories, ...permStories])],
        evidence: ['configuration', 'metadata'],
        mitigation: `Grant edit on ${m.field} to ${runAs}, or change the mapping direction to outbound.`,
        tests: [`Integration test: ${c.id} upsert with ${m.field} populated, running as ${runAs}`],
      });
      for (const s of mappingStories) {
        reevaluate.push({ task: s, because: `${runAs} cannot edit ${m.field} in the combined end state`, triggeredBy: permStories.filter((p) => p !== s) });
      }
    }
  }

  // 6. Reporting rule: report audiences need read access on fields the report uses.
  for (const c of after.components.values()) {
    if (c.type !== 'Report') continue;
    const audience = (c.attributes.audience as ComponentId[] | undefined) ?? [];
    for (const d of after.requirements(c.id)) {
      if (!d.to.startsWith('CustomField:') || !after.exists(d.to)) continue;
      const relevant = touchedBy.has(c.id) || touchedBy.has(d.to);
      if (!relevant) continue;
      for (const who of audience) {
        const node = `fieldPermissions:${d.to.replace(/^CustomField:/, '')}`;
        if (after.get(who)?.nodes?.[node]?.readable === true) continue;
        findings.push({
          id: fid(),
          category: 'reporting',
          severity: 'medium',
          title: `${who} cannot read ${d.to}, used by ${c.id}`,
          explanation: `${c.id} ${d.kind} ${d.to} and is shared with ${who}, but ${who} has no read access in the simulated end state. The column will be empty or the report will fail to run for those users.`,
          components: [c.id, d.to, who],
          stories: [...new Set([...storiesFor(c.id), ...storiesFor(d.to)])],
          evidence: ['metadata', 'configuration'],
          mitigation: `Grant read on ${d.to} to ${who} in the FLS story.`,
          tests: [`Run ${c.id} as a ${who} user`],
        });
      }
    }
  }

  // 7. Security rule: access granted to sensitive fields, or to external audiences.
  for (const [nodeKey, stories] of nodeTouchedBy) {
    const [holder, node] = nodeKey.split('#');
    const value = after.get(holder)?.nodes?.[node];
    const target = nodeTarget(node);
    if (!value || !target) continue;
    const grants = value.readable === true || value.editable === true;
    const field = after.get(target);
    const holderTags = after.get(holder)?.tags ?? [];
    if (!grants) continue;
    if (holderTags.includes('external')) {
      findings.push({
        id: fid(),
        category: 'security',
        severity: 'blocker',
        title: `External audience ${holder} gains access to ${target}`,
        explanation: `${[...stories].join(", ")} ${stories.size > 1 ? "grant" : "grants"} ${JSON.stringify(value)} on ${target} to ${holder}, which is tagged external (guest/community).`,
        components: [holder, target],
        stories: [...stories],
        evidence: ['metadata'],
        mitigation: 'Remove the grant, or get explicit security sign-off.',
      });
    } else if (field?.tags?.some((t) => t === 'pii' || t === 'security')) {
      findings.push({
        id: fid(),
        category: 'security',
        severity: 'medium',
        title: `Access to sensitive field ${target} granted to ${holder}`,
        explanation: `${target} is tagged ${field.tags!.join(', ')}; ${[...stories].join(', ')} grant ${JSON.stringify(value)} to ${holder}.`,
        components: [holder, target],
        stories: [...stories],
        evidence: ['metadata'],
        mitigation: 'Confirm the access with the data owner.',
      });
    }
  }

  // 8. Blast radius, plus automation and unverified edges inside it.
  const blastRadius = after.blastRadius(changed);
  for (const e of [...blastRadius.direct, ...blastRadius.indirect]) {
    const already = findings.some((f) => f.components.includes(e.component) && (f.category === 'automation' || f.category === 'dependency'));
    if (e.tags.includes('production-automation') && !already) {
      findings.push({
        id: fid(),
        category: 'automation',
        severity: 'medium',
        title: `Production automation in blast radius: ${e.component}`,
        explanation: `Reached at depth ${e.depth} via ${e.via.map((v) => `${v.from} ${v.kind} ${v.to}`).join(' → ')}.`,
        components: [e.component],
        stories: [...new Set(e.via.flatMap((v) => storiesFor(v.to)))],
        evidence: e.via.map((v) => v.source),
        tests: [`Regression test for ${e.component}`],
      });
    }
    const inferred = e.via.filter((v) => v.source === 'inference');
    if (inferred.length) {
      findings.push({
        id: fid(),
        category: 'unverified',
        severity: 'low',
        title: `Unverified dependency: ${e.component}`,
        explanation: `The path to ${e.component} includes inferred edges (${inferred.map((v) => `${v.from} ${v.kind} ${v.to}`).join('; ')}). Confirm with a code search or the Agentia dependency analyzer.`,
        components: [e.component],
        stories: [],
        evidence: ['inference'],
      });
    }
  }

  return {
    baseline: { name: baselineName, components: baseline.components.size, dependencies: baseline.dependencies.length },
    after: { components: after.components.size, dependencies: after.dependencies.length },
    diff: diffStates(baseline, after, touchedBy),
    blastRadius,
    findings,
    reevaluate,
    limitations: SIMULATION_LIMITATIONS,
  };
}

export function diffStates(before: MetadataState, after: MetadataState, touchedBy: Map<ComponentId, Set<string>>): ComponentDiff[] {
  const out: ComponentDiff[] = [];
  const ids = new Set([...before.components.keys(), ...after.components.keys()]);
  for (const id of [...ids].sort()) {
    const b = before.get(id);
    const a = after.get(id);
    const stories = [...(touchedBy.get(id) ?? [])];
    if (!b && a) out.push({ id, change: 'added', stories });
    else if (b && !a) out.push({ id, change: 'removed', stories });
    else if (a && b) {
      const attributes: NonNullable<ComponentDiff['attributes']> = [];
      for (const k of new Set([...Object.keys(b.attributes), ...Object.keys(a.attributes)])) {
        if (JSON.stringify(b.attributes[k]) !== JSON.stringify(a.attributes[k])) attributes.push({ key: k, before: b.attributes[k], after: a.attributes[k] });
      }
      const nodes: NonNullable<ComponentDiff['nodes']> = [];
      for (const n of new Set([...Object.keys(b.nodes ?? {}), ...Object.keys(a.nodes ?? {})])) {
        if (JSON.stringify(b.nodes?.[n]) !== JSON.stringify(a.nodes?.[n])) nodes.push({ node: n, before: b.nodes?.[n], after: a.nodes?.[n] });
      }
      if (attributes.length || nodes.length) out.push({ id, change: 'modified', attributes, nodes, stories });
    }
  }
  return out;
}
