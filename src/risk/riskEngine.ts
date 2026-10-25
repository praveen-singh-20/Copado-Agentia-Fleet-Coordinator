// Explainable risk: every level comes with the findings that produced it.
// No probabilities or confidence percentages; levels are rule-based and say so.

import type { Decision, Finding, RiskDimension, RiskReport, Severity, SimulationResult, Tier } from '../core/types.ts';

const DIMENSIONS: { name: string; categories: Finding['category'][] }[] = [
  { name: 'Functional', categories: ['assumption'] },
  { name: 'Dependency', categories: ['dependency'] },
  { name: 'Security', categories: ['security'] },
  { name: 'Integration', categories: ['integration'] },
  { name: 'Automation', categories: ['automation'] },
  { name: 'Reporting', categories: ['reporting'] },
  { name: 'Conflict', categories: ['conflict'] },
  { name: 'Deployment', categories: ['deployment'] },
];

const severityToTier = (s: Severity): Tier =>
  s === 'blocker' || s === 'high' ? 'high' : s === 'medium' ? 'medium' : s === 'low' ? 'low' : 'none';

const rank: Record<Tier, number> = { none: 0, low: 1, medium: 2, high: 3 };
const maxTier = (ts: Tier[]): Tier => ts.reduce<Tier>((m, t) => (rank[t] > rank[m] ? t : m), 'none');

export interface RiskOptions {
  /** Evidence from Copado validation; absent means only local simulation was run. */
  validation?: { ran: boolean; passed?: boolean; source: string };
}

export function assessRisk(sim: SimulationResult, opts: RiskOptions = {}): RiskReport {
  const dimensions: RiskDimension[] = DIMENSIONS.map(({ name, categories }) => {
    const fs = sim.findings.filter((f) => categories.includes(f.category));
    return {
      name,
      level: maxTier(fs.map((f) => severityToTier(f.severity))),
      reasons: fs.filter((f) => f.severity !== 'info').map((f) => `[${f.id} ${f.severity}] ${f.title}`),
    };
  });

  // Test & validation evidence is its own dimension: it rises when nothing external has checked the plan.
  const v = opts.validation;
  dimensions.push({
    name: 'Validation evidence',
    level: v?.ran ? (v.passed ? 'none' : 'high') : 'medium',
    reasons: v?.ran
      ? [`${v.source}: ${v.passed ? 'passed' : 'failed'}`]
      : ['Only the local simulation has run. No Copado/Salesforce validation yet.'],
  });

  const unverified = sim.findings.filter((f) => f.category === 'unverified');
  const blockers = sim.findings.filter((f) => f.severity === 'blocker');
  const highs = sim.findings.filter((f) => f.severity === 'high');

  let decision: Decision;
  let decisionReason: string;
  if (blockers.length) {
    decision = 'REJECT';
    decisionReason = `${blockers.length} blocker finding(s): ${blockers.map((b) => b.id).join(', ')}. These need a policy decision, not a fix.`;
  } else if (highs.length || v?.passed === false) {
    decision = 'REVISE';
    decisionReason = `${highs.length} high finding(s) with known fixes: ${highs.map((h) => h.id).join(', ')}${v?.passed === false ? '; Copado validation failed' : ''}.`;
  } else {
    decision = 'APPLY';
    decisionReason = 'No blocker or high findings in the simulated end state. APPLY is a recommendation; a human must still approve before anything is promoted.';
  }

  const overall = maxTier(dimensions.filter((d) => d.name !== 'Validation evidence').map((d) => d.level));

  const missingInformation = [
    ...(v?.ran ? [] : ['Copado validation result (run `agentia cicd work submit --json` per story after approval).']),
    ...(unverified.length ? [`${unverified.length} dependency path(s) rely on inferred edges.`] : []),
    'Data volumes and existing records are not in the snapshot.',
  ];

  return {
    overall,
    decision,
    decisionReason,
    dimensions,
    mitigations: [...new Set(sim.findings.filter((f) => f.mitigation && f.severity !== 'info').map((f) => `${f.id}: ${f.mitigation}`))],
    tests: [...new Set(sim.findings.flatMap((f) => f.tests ?? []))],
    missingInformation,
    limitations: [
      'Risk levels are rule-based classifications of the findings, not probabilities.',
      ...sim.limitations,
    ],
  };
}
