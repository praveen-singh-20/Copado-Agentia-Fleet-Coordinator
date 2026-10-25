// Terminal and Markdown views of runs, executions, conflict checks and run comparisons.

import type { ExecutionRecord, RunRecord } from '../coordinator/coordinator.ts';
import type { ConflictDecision } from '../adapters/externalAgents.ts';
import type { Finding, Severity, Tier } from '../core/types.ts';

const useColor = (process.stdout.isTTY || !!process.env.FORCE_COLOR) && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { bold: c(1), dim: c(2), red: c(31), green: c(32), yellow: c(33), blue: c(34), magenta: c(35), cyan: c(36) };

const sevColor: Record<Severity, (s: string) => string> = { blocker: color.red, high: color.red, medium: color.yellow, low: color.blue, info: color.dim };
const tierColor: Record<Tier, (s: string) => string> = { high: color.red, medium: color.yellow, low: color.blue, none: color.green };
const SEV_ORDER: Severity[] = ['blocker', 'high', 'medium', 'low', 'info'];
const bySeverity = (a: Finding, b: Finding) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || a.id.localeCompare(b.id);

export function renderTerminal(run: RunRecord): string {
  const out: string[] = [];
  const h = (s: string) => out.push('', color.bold(color.cyan(`━━ ${s} `.padEnd(72, '━'))));

  out.push(color.bold(`Fleet run ${run.runId}`) + color.dim(`  ${run.batch}`));
  out.push(color.dim(`Snapshot: ${run.snapshot.name} (${run.snapshot.origin})`));
  for (const n of run.notes ?? []) out.push(`  ${n.level === 'warning' ? color.yellow('!') : color.dim('i')} ${n.story === '*' ? '' : `${n.story}: `}${n.message}`);

  if (run.intakeIssues.length) {
    h('NEEDS HUMAN INPUT');
    for (const i of run.intakeIssues) out.push(`  ${color.red('✗')} ${i.task}: ${i.issues.join('; ')}`);
    return out.join('\n');
  }

  h('1. AGENTS USED');
  const groups = new Map<string, { call: RunRecord['agentCalls'][number]; n: number; failed: number; ms: number }>();
  for (const call of run.agentCalls) {
    const key = `${call.stage}|${call.capability}|${call.agent}|${call.via}`;
    const g = groups.get(key) ?? { call, n: 0, failed: 0, ms: 0 };
    g.n++;
    g.ms += call.ms ?? 0;
    if (!call.ok) g.failed++;
    groups.set(key, g);
  }
  for (const { call, n, failed, ms } of groups.values()) {
    const name = call.agent ? `${call.agent}${call.via ? ` (${call.via})` : ''}` : 'none';
    out.push(
      `  ${failed === n ? color.red('✗') : failed ? color.yellow('~') : color.green('✓')} ${call.stage.padEnd(14)} ${call.capability.padEnd(20)} → ${color.bold(name)}${n > 1 ? ` ×${n}` : ''} ${color.dim(`[${call.evidence}] ${ms}ms`)}` +
        (failed && call.error ? color.red(`  ${call.error.slice(0, 160)}`) : ''),
    );
    const skipped = call.candidates.filter((x) => x.excludedBecause && !/not found on PATH/.test(x.excludedBecause));
    if (skipped.length) out.push(color.dim(`      not chosen: ${skipped.map((x) => `${x.id}: ${x.excludedBecause}`).join(' | ')}`));
  }

  const s = run.schedule!;
  h('2. EXECUTION PLAN (collision forecast)');
  for (const w of s.waves) {
    out.push(`  Wave ${w.index}: ${color.bold(w.tasks.join(', '))}${w.tasks.length > 1 ? color.green('  (parallel)') : ''}`);
    out.push(color.dim(`    ${w.reason}`));
  }
  for (const m of s.mergeable) out.push(`  ${color.green('⇄')} ${m.tasks.join(' + ')} share ${m.component} but touch different nodes → parallel-safe`);
  for (const col of s.collisions) out.push(`  ${color.yellow('⚠')} ${col.tasks.join(' + ')} both change ${col.key} → serialized`);

  const sim = run.simulation!;
  h('3. BEFORE → SIMULATED AFTER');
  out.push(color.dim(`  baseline: ${sim.baseline.components} components, ${sim.baseline.dependencies} dependencies  →  after: ${sim.after.components} components, ${sim.after.dependencies} dependencies`));
  for (const d of sim.diff) {
    const sym = d.change === 'added' ? color.green('+') : d.change === 'removed' ? color.red('−') : color.yellow('~');
    out.push(`  ${sym} ${d.id} ${color.dim(`(${d.stories.join(', ')})`)}`);
    for (const a of d.attributes ?? []) out.push(color.dim(`      ${a.key}: ${short(a.before)} → ${short(a.after)}`));
    for (const n of d.nodes ?? []) out.push(color.dim(`      ${n.node}: ${short(n.before)} → ${short(n.after)}`));
  }

  h('4. BLAST RADIUS (combined batch)');
  out.push(`  Changed: ${sim.blastRadius.changed.length} components`);
  for (const e of sim.blastRadius.direct) out.push(`  ${color.yellow('●')} direct   ${e.component} ${tagStr(e.tags)} ${color.dim(`via ${e.via.at(-1)!.kind} [${e.via.at(-1)!.source}]`)}`);
  for (const e of sim.blastRadius.indirect) out.push(`  ${color.blue('○')} indirect ${e.component} ${tagStr(e.tags)} ${color.dim(e.via.map((v) => `${v.from}→${v.to} [${v.source}]`).join(' ⇒ '))}`);
  for (const x of run.externalImpact ?? []) out.push(`  ${color.magenta('◆')} Copado analyzer ${x.story}: ${x.components.length} dependencies${x.missing.length ? color.red(`, ${x.missing.length} missing in target`) : ''}`);

  h('5. FINDINGS');
  for (const f of [...sim.findings].sort(bySeverity)) {
    out.push(`  ${sevColor[f.severity](`[${f.severity.toUpperCase()}]`)} ${color.bold(f.id)} ${f.title}`);
    out.push(color.dim(`      why: ${f.explanation}`));
    if (f.stories.length) out.push(color.dim(`      stories: ${f.stories.join(', ')}   evidence: ${f.evidence.join(', ')}`));
    if (f.mitigation) out.push(`      ${color.green('fix:')} ${f.mitigation}`);
  }
  if (sim.reevaluate.length) {
    out.push('', color.bold('  Re-evaluate:'));
    for (const r of sim.reevaluate) out.push(`  ↻ ${r.task}: ${r.because}${r.triggeredBy.length ? ` (changed by ${r.triggeredBy.join(', ')})` : ''}`);
  }
  for (const o of run.aiOpinions ?? []) out.push(color.dim(`  AI ${o.agent}: ${o.concerns.length} concern(s), ${o.agreements.length} matched rule findings`));

  const r = run.risk!;
  h('6. RISK');
  for (const d of r.dimensions) {
    out.push(`  ${d.name.padEnd(20)} ${tierColor[d.level](d.level.toUpperCase().padEnd(6))} ${color.dim(d.reasons[0] ?? '')}`);
    for (const extra of d.reasons.slice(1)) out.push(color.dim(`  ${''.padEnd(27)} ${extra}`));
  }
  if (r.tests.length) {
    out.push('', color.bold('  Tests to run:'));
    for (const t of r.tests) out.push(`   • ${t}`);
  }
  out.push('', color.bold('  Missing information:'));
  for (const m of r.missingInformation) out.push(color.dim(`   • ${m}`));

  if (run.promotionPlan?.length) {
    h('7. PROMOTION & BACK-PROMOTION PLAN (Agentia)');
    let wave = 0;
    for (const p of run.promotionPlan) {
      if (p.wave !== wave) {
        wave = p.wave;
        out.push(color.bold(`  Wave ${wave}`));
      }
      out.push(`   ${p.story}${p.copadoStory && p.copadoStory !== p.story ? color.dim(` (${p.copadoStory})`) : ''}`);
      for (const n of p.notes) out.push(color.dim(`     · ${n}`));
      for (const cmd of p.commands) out.push(color.cyan(`     $ ${cmd}`));
    }
  }

  const decColor = r.decision === 'APPLY' ? color.green : r.decision === 'REVISE' ? color.yellow : color.red;
  out.push('', `  ${color.bold('RECOMMENDATION:')} ${decColor(color.bold(r.decision))}   overall risk ${tierColor[r.overall](r.overall.toUpperCase())}`);
  out.push(color.dim(`  ${r.decisionReason}`));
  out.push(color.dim('  Evidence: LOCAL SIMULATION' + (run.externalImpact?.length ? ' + Copado dependency analyzer' : '') + (run.aiOpinions?.length || run.enrichment ? ' + AI opinions' : '') + '. Nothing has been validated or deployed yet.'));
  out.push('');
  if (run.status === 'awaiting-approval') out.push(`  Next: ${color.bold(`fleet approve ${run.runId} --by "<your name>"`)}`);
  else if (run.status === 'revise') out.push(`  Next: fix the stories and rerun, or ${color.bold(`fleet approve ${run.runId} --by "<name>" --accept-risk`)}`);
  else if (run.status === 'rejected') out.push('  Next: this batch cannot be approved. Change the stories and run again.');
  return out.join('\n');
}

export function renderExecution(exec: ExecutionRecord): string {
  const tag = (s: string) => (s === 'VALIDATED' || s === 'DEPLOYED' ? color.green(s) : s === 'FAILED' ? color.red(s) : s === 'MOCK' ? color.yellow(s) : color.cyan(s));
  const out = [color.bold(`Execution (${exec.mode}, ${exec.action}) for ${exec.runId}`)];
  if (exec.results.some((r) => r.status === 'MOCK')) out.push(color.yellow('MOCK results — the Agentia CLI is not available, so nothing was sent to Copado.'));
  else if (exec.mode === 'dry-run') out.push(color.cyan('DRY RUN — the Agentia commands below were NOT sent.'));
  else out.push(color.green(`Live Copado ${exec.action === 'deploy' ? 'validation + deployment to the next environment' : 'validation (no deployment)'}.`));
  for (const r of exec.results) {
    out.push(`  ${tag(r.status.padEnd(9))} wave ${r.wave}  ${r.task.padEnd(12)} ${r.copadoStory ?? ''} ${color.dim(r.agent ?? '')}`);
    for (const s of r.steps ?? []) out.push(`     ${s.ok ? color.green('✓') : color.red('✗')} ${s.step.padEnd(28)} ${color.dim(s.command)}${s.error ? color.red(`\n        ${s.error}`) : ''}`);
    if (!r.steps && r.detail !== undefined) {
      const d = r.detail as { wouldRun?: string[] };
      if (d && Array.isArray(d.wouldRun)) for (const cmd of d.wouldRun) out.push(color.dim(`     would run: ${cmd}`));
      else out.push(color.dim(`     ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail).slice(0, 200)}`));
    }
    if (r.rca) {
      out.push(`     ${color.magenta('RCA')} (${r.rca.via ?? r.rca.agent}): ${r.rca.output.rootCause}`);
      out.push(`     ${color.green('fix:')} ${r.rca.output.suggestedFix}`);
    }
  }
  if (exec.riskAfter) out.push('', `  Risk re-assessed with Copado evidence: ${color.bold(exec.riskAfter.decision)} — ${exec.riskAfter.decisionReason}`);
  return out.join('\n');
}

export function renderConflicts(promotion: string, decisions: ConflictDecision[], resumeHint: string, applied: boolean): string {
  const out = [color.bold(`Promotion ${promotion}: ${decisions.length} conflict(s)`) + (applied ? '' : color.dim('  (check only — add --apply to auto-resolve the safe ones)'))];
  for (const d of decisions) {
    const tag = d.decision === 'auto' ? (d.resolved ? color.green('RESOLVED') : d.resolved === false ? color.red('AUTO FAILED') : color.green('AUTO-SAFE')) : color.yellow('MANUAL');
    out.push(`  ${tag.padEnd(12)} ${d.component} ${color.dim(`${d.conflictId}${d.story ? ` · ${d.story}` : ''}`)}`);
    out.push(color.dim(`      ${d.reason}${d.error ? ` (${d.error})` : ''}`));
  }
  out.push('', `  When every conflict is resolved: ${color.bold(resumeHint)}`);
  return out.join('\n');
}

export function compareRuns(a: RunRecord, b: RunRecord) {
  const key = (f: Finding) => `${f.category}|${f.title.replace(/^\[AI:[^\]]*\]\s*/, '')}`;
  const fa = new Map((a.simulation?.findings ?? []).filter((f) => f.severity !== 'info').map((f) => [key(f), f]));
  const fb = new Map((b.simulation?.findings ?? []).filter((f) => f.severity !== 'info').map((f) => [key(f), f]));
  return {
    before: { runId: a.runId, decision: a.risk?.decision, overall: a.risk?.overall },
    after: { runId: b.runId, decision: b.risk?.decision, overall: b.risk?.overall },
    resolved: [...fa.entries()].filter(([k]) => !fb.has(k)).map(([, f]) => f),
    introduced: [...fb.entries()].filter(([k]) => !fa.has(k)).map(([, f]) => f),
    remaining: [...fb.entries()].filter(([k]) => fa.has(k)).map(([, f]) => f),
  };
}

export function renderCompare(cmp: ReturnType<typeof compareRuns>): string {
  const out = [color.bold(`${cmp.before.runId} → ${cmp.after.runId}`), `  Decision: ${cmp.before.decision} (${cmp.before.overall}) → ${color.bold(String(cmp.after.decision))} (${cmp.after.overall})`];
  out.push('', color.green(`  Resolved (${cmp.resolved.length})`));
  for (const f of cmp.resolved.sort(bySeverity)) out.push(`   ✓ [${f.severity}] ${f.title}`);
  out.push('', color.red(`  New (${cmp.introduced.length})`));
  for (const f of cmp.introduced.sort(bySeverity)) out.push(`   + [${f.severity}] ${f.title}`);
  out.push('', color.yellow(`  Still open (${cmp.remaining.length})`));
  for (const f of cmp.remaining.sort(bySeverity)) out.push(`   · [${f.severity}] ${f.title}`);
  return out.join('\n');
}

export function renderMarkdown(run: RunRecord): string {
  const md: string[] = [`# Fleet run ${run.runId}`, '', `- **Batch:** ${run.batch}`, `- **Snapshot:** ${run.snapshot.name} — ${run.snapshot.origin}`, `- **Status:** ${run.status}`];
  for (const n of run.notes ?? []) md.push(`- _${n.level}:_ ${n.story === '*' ? '' : `${n.story}: `}${n.message}`);
  if (run.intakeIssues.length) {
    md.push('', '## Needs human input', ...run.intakeIssues.map((i) => `- **${i.task}:** ${i.issues.join('; ')}`));
    return md.join('\n');
  }
  const r = run.risk!;
  const sim = run.simulation!;
  md.push(`- **Recommendation:** ${r.decision} (overall risk ${r.overall}) — ${r.decisionReason}`, '- **Evidence:** local simulation (plus any Copado/AI sources listed below); nothing validated or deployed', '');
  md.push('## Agents used', '', '| Stage | Capability | Agent | Evidence | ms | OK |', '|---|---|---|---|---|---|');
  for (const a of run.agentCalls) md.push(`| ${a.stage} | ${a.capability} | ${a.agent ?? '—'}${a.via ? ` (${a.via})` : ''} | ${a.evidence} | ${a.ms ?? ''} | ${a.ok ? 'yes' : `no: ${(a.error ?? '').replace(/\|/g, '/')}`} |`);
  md.push('', '## Execution plan', '');
  for (const w of run.schedule!.waves) md.push(`- **Wave ${w.index}:** ${w.tasks.join(', ')} — ${w.reason}`);
  for (const m of run.schedule!.mergeable) md.push(`- ⇄ ${m.tasks.join(' + ')} share ${m.component}, different nodes → parallel-safe`);
  for (const c2 of run.schedule!.collisions) md.push(`- ⚠ ${c2.tasks.join(' + ')} both change ${c2.key} → serialized`);
  md.push('', '## Before → simulated after', '', '| Component | Change | Stories | Detail |', '|---|---|---|---|');
  for (const d of sim.diff) {
    const detail = [...(d.attributes ?? []).map((a) => `${a.key}: ${short(a.before)} → ${short(a.after)}`), ...(d.nodes ?? []).map((n) => `${n.node}: ${short(n.before)} → ${short(n.after)}`)].join('<br>');
    md.push(`| ${d.id} | ${d.change} | ${d.stories.join(', ')} | ${detail.replace(/\|/g, '/')} |`);
  }
  md.push('', '## Blast radius', '');
  for (const e of [...sim.blastRadius.direct, ...sim.blastRadius.indirect]) md.push(`- ${e.depth === 1 ? 'Direct' : 'Indirect'}: **${e.component}** — ${e.via.map((v) => `${v.from} ${v.kind} ${v.to} [${v.source}]`).join(' ⇒ ')}`);
  md.push('', '## Findings', '');
  for (const f of [...sim.findings].sort(bySeverity)) {
    md.push(`### ${f.id} [${f.severity}] ${f.title}`, '', f.explanation, '', `- Category: ${f.category}`, `- Stories: ${f.stories.join(', ') || '—'}`, `- Evidence: ${f.evidence.join(', ')}`);
    if (f.mitigation) md.push(`- Fix: ${f.mitigation}`);
    md.push('');
  }
  md.push('## Risk', '', '| Dimension | Level | Reasons |', '|---|---|---|');
  for (const d of r.dimensions) md.push(`| ${d.name} | ${d.level} | ${d.reasons.join('<br>').replace(/\|/g, '/') || '—'} |`);
  md.push('', '## Tests to run', ...r.tests.map((t) => `- ${t}`));
  if (run.promotionPlan?.length) {
    md.push('', '## Promotion & back-promotion plan', '');
    for (const p of run.promotionPlan) {
      md.push(`**Wave ${p.wave} · ${p.story}**`, ...p.notes.map((n) => `- ${n}`), '```', ...p.commands, '```', '');
    }
  }
  md.push('', '## Missing information', ...r.missingInformation.map((m) => `- ${m}`), '', '## Limitations', ...r.limitations.map((l) => `- ${l}`));
  return md.join('\n');
}

function short(v: unknown): string {
  if (v === undefined) return '∅';
  const s = JSON.stringify(v);
  return s.length > 70 ? s.slice(0, 67) + '...' : s;
}

function tagStr(tags: string[]): string {
  return tags.length ? color.magenta(`[${tags.join(',')}]`) : '';
}
