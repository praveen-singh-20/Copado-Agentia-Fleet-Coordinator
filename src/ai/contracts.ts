// Structured contracts for every AI capability. Each AI agent — Copado AI or a third-party
// CLI — gets the same compact JSON input and must answer with the same JSON shape.
// Answers are validated and clamped here, so a malformed or oversized reply cannot
// leak into the coordinator.

import type { Capability } from '../core/types.ts';
import { deepFind } from '../adapters/exec.ts';

export type AiCapability = 'requirement.enrich' | 'architecture.review' | 'test.select' | 'release.review' | 'incident.rca';
export const AI_CAPABILITIES: AiCapability[] = ['requirement.enrich', 'architecture.review', 'test.select', 'release.review', 'incident.rca'];
export const isAiCapability = (c: Capability): c is AiCapability => (AI_CAPABILITIES as string[]).includes(c);

export interface ReviewConcern {
  title: string;
  severity: 'low' | 'medium' | 'high';
  components: string[];
  reason: string;
}

export interface EnrichInput {
  story: { id: string; title: string; description?: string; acceptanceCriteria?: string[] };
  changes: string[];
}
export interface EnrichOutput {
  expectedComponents: string[];
  acceptanceCriteria: string[];
  gaps: string[];
}

export interface ReviewInput {
  stories: { id: string; title: string; changes: string[] }[];
  findings: { id: string; severity: string; title: string }[];
  blastRadius: string[];
  waves?: { index: number; tasks: string[] }[];
}

export interface TestSuggestion {
  name: string;
  type: 'apex' | 'flow' | 'robotic' | 'integration' | 'manual';
  components: string[];
  reason: string;
}

export interface RcaInput {
  story: string;
  step: string;
  error: string;
}
export interface RcaOutput {
  rootCause: string;
  suggestedFix: string;
  components: string[];
}

const ONLY_JSON = 'Respond with ONLY a JSON object, no prose, in exactly this shape:';
const str = (v: unknown, max = 1000) => String(v ?? '').slice(0, max);
const strList = (v: unknown, n = 25, max = 300) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);
const sev = (v: unknown): ReviewConcern['severity'] => (v === 'high' || v === 'medium' ? v : 'low');

interface Contract<I, O> {
  key: string;
  prompt(input: I): string;
  parse(found: Record<string, unknown>): O;
}

const concernsContract = (intro: string): Contract<ReviewInput, ReviewConcern[]> => ({
  key: 'concerns',
  prompt: (input) =>
    [
      intro,
      'A deterministic simulator already produced the findings listed below. Do not repeat them; add only risks it may have missed.',
      'Do not modify any files.',
      ONLY_JSON,
      '{"concerns":[{"title":string,"severity":"low"|"medium"|"high","components":["Type:ApiName"],"reason":string}]}',
      '',
      JSON.stringify(input, null, 2),
    ].join('\n'),
  parse: (o) =>
    (Array.isArray(o.concerns) ? o.concerns : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).title === 'string')
      .slice(0, 20)
      .map((x) => ({ title: str(x.title, 200), severity: sev(x.severity), components: strList(x.components, 20, 200), reason: str(x.reason) })),
});

export const CONTRACTS = {
  'requirement.enrich': {
    key: 'expectedComponents',
    prompt: (input: EnrichInput) =>
      [
        'You are checking a Salesforce user story before it is merged.',
        'From the story intent, list the Salesforce components (format "Type:ApiName", e.g. "CustomField:Account.Customer_Tier__c", "Flow:My_Flow", "Profile:Sales") this story needs to change.',
        'If acceptance criteria are missing, propose them. List gaps between the intent and the changes actually made.',
        ONLY_JSON,
        '{"expectedComponents":[string],"acceptanceCriteria":[string],"gaps":[string]}',
        '',
        JSON.stringify(input, null, 2),
      ].join('\n'),
    parse: (o: Record<string, unknown>): EnrichOutput => ({
      expectedComponents: strList(o.expectedComponents, 40, 200).filter((c) => /^[A-Za-z]+:.+$/.test(c)),
      acceptanceCriteria: strList(o.acceptanceCriteria, 10),
      gaps: strList(o.gaps, 10),
    }),
  },
  'architecture.review': concernsContract('You are reviewing a batch of Salesforce metadata changes before deployment, as a Salesforce architect. Focus on semantic conflicts between stories, data, security and integration effects.'),
  'release.review': concernsContract('You are the release manager. Review the proposed promotion order (waves) and the overlaps between stories. Flag ordering, back-promotion or environment risks.'),
  'test.select': {
    key: 'tests',
    prompt: (input: ReviewInput) =>
      [
        'You are selecting tests for a batch of Salesforce changes before promotion.',
        'Use the changed components, the blast radius and the findings. Prefer the smallest set that covers the risky paths.',
        ONLY_JSON,
        '{"tests":[{"name":string,"type":"apex"|"flow"|"robotic"|"integration"|"manual","components":["Type:ApiName"],"reason":string}]}',
        '',
        JSON.stringify(input, null, 2),
      ].join('\n'),
    parse: (o: Record<string, unknown>): TestSuggestion[] =>
      (Array.isArray(o.tests) ? o.tests : [])
        .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).name === 'string')
        .slice(0, 15)
        .map((x) => ({
          name: str(x.name, 200),
          type: (['apex', 'flow', 'robotic', 'integration', 'manual'] as const).includes(x.type as TestSuggestion['type']) ? (x.type as TestSuggestion['type']) : 'manual',
          components: strList(x.components, 10, 200),
          reason: str(x.reason, 400),
        })),
  },
  'incident.rca': {
    key: 'rootCause',
    prompt: (input: RcaInput) =>
      [
        'A Copado step failed for a Salesforce user story. Find the most likely root cause and the smallest fix.',
        ONLY_JSON,
        '{"rootCause":string,"suggestedFix":string,"components":["Type:ApiName"]}',
        '',
        JSON.stringify({ ...input, error: input.error.slice(0, 4000) }, null, 2),
      ].join('\n'),
    parse: (o: Record<string, unknown>): RcaOutput => ({ rootCause: str(o.rootCause, 800), suggestedFix: str(o.suggestedFix, 800), components: strList(o.components, 10, 200) }),
  },
} satisfies Record<AiCapability, Contract<never, unknown>>;

/** Which Copado AI agent answers which capability. */
export const COPADO_AGENT_FOR: Record<AiCapability, 'plan' | 'build' | 'test' | 'release' | 'operate'> = {
  'requirement.enrich': 'plan',
  'architecture.review': 'build',
  'test.select': 'test',
  'release.review': 'release',
  'incident.rca': 'operate',
};

export function buildPrompt(capability: AiCapability, input: unknown): string {
  return (CONTRACTS[capability].prompt as (i: unknown) => string)(input);
}

export function parseAnswer(capability: AiCapability, values: unknown[]): unknown {
  const c = CONTRACTS[capability];
  const found = deepFind(values, c.key);
  if (!found) throw new Error(`answer has no "${c.key}" field`);
  return c.parse(found);
}
