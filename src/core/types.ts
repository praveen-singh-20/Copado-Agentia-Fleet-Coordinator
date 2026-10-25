// Shared contracts. Every agent talks to the coordinator through these shapes,
// never through free-form conversation.

// ---------- Metadata model ----------

/** Where a dependency edge came from. Lets every finding say how much to trust it. */
export type Provenance = 'metadata' | 'source-code' | 'configuration' | 'external-tool' | 'inference';

/** Component id format: "<Type>:<ApiName>", e.g. "CustomField:Account.Customer_Tier__c". */
export type ComponentId = string;

export interface Component {
  id: ComponentId;
  type: string;
  attributes: Record<string, unknown>;
  /** Sub-nodes for large container files (Profile / PermissionSet), keyed like "fieldPermissions:Account.Industry". */
  nodes?: Record<string, Record<string, unknown>>;
  /** Free tags used by rules: "security", "pii", "integration", "production-automation", "external-consumer". */
  tags?: string[];
  /** Hash of the source file(s) when imported from a project; equal hashes mean the component did not change. */
  hash?: string;
}

export type DependencyKind = 'reads' | 'writes' | 'grants' | 'references' | 'runs-as' | 'groups-by';

/** "from depends on to". A change to `to` can affect `from`. */
export interface Dependency {
  from: ComponentId;
  to: ComponentId;
  kind: DependencyKind;
  source: Provenance;
  note?: string;
}

export interface MetadataSnapshot {
  name: string;
  capturedAt: string;
  /** Where the snapshot came from: a curated fixture, a retrieved org, an Agentia export... */
  origin: string;
  components: Component[];
  dependencies: Dependency[];
}

// ---------- Tasks / stories ----------

export type ChangeOp =
  | { op: 'create'; component: Component; references?: ReferenceSpec[] }
  | { op: 'update'; id: ComponentId; attributes?: Record<string, unknown>; references?: ReferenceSpec[]; removeReferences?: ComponentId[] }
  | { op: 'delete'; id: ComponentId }
  | { op: 'set-node'; id: ComponentId; node: string; value: Record<string, unknown> }
  | { op: 'remove-node'; id: ComponentId; node: string };

export interface ReferenceSpec {
  to: ComponentId;
  kind: DependencyKind;
  source?: Provenance;
}

export type TaskKind = 'change' | 'investigation' | 'analysis';

export interface TaskInput {
  id: string;
  title: string;
  kind?: TaskKind;
  description?: string;
  acceptanceCriteria?: string[];
  /** Proposed metadata changes. Required for kind "change". */
  changes?: ChangeOp[];
  /** Assumptions the story author made, checked against the simulated end state. */
  assumptions?: Assumption[];
  /** Copado User Story name or id (e.g. "US-0247"), used for Agentia validation after approval. */
  copadoStory?: string;
  /** Where the task came from when it was derived from Git. */
  source?: { branch: string; commit: string; mergeBase: string; behindBase: boolean };
}

/** An assumption is a machine-checkable expectation, e.g. "Integration_User can edit Customer_Tier__c". */
export type Assumption =
  | { type: 'component-exists'; id: ComponentId; reason?: string }
  | { type: 'node-flag'; id: ComponentId; node: string; flag: string; equals: unknown; reason?: string };

export interface TaskBatch {
  name: string;
  tasks: TaskInput[];
}

// ---------- Agents ----------

export type Capability =
  | 'requirement.analyze'
  | 'requirement.enrich'
  | 'plan.schedule'
  | 'impact.analyze'
  | 'impact.external'
  | 'conflict.detect'
  | 'architecture.review'
  | 'build.propose'
  | 'test.select'
  | 'simulation.run'
  | 'risk.assess'
  | 'release.review'
  | 'incident.rca'
  | 'deploy.validate'
  | 'deploy.promote'
  | 'conflict.resolve'
  | 'audit.record';

export type Mechanism = 'in-process' | 'cli' | 'mcp' | 'http' | 'manual';
export type Tier = 'none' | 'low' | 'medium' | 'high';

export interface AgentPermissions {
  /** May change files, org metadata or Copado records. */
  write: boolean;
  /** May validate/promote/deploy through Copado. Always also needs human approval. */
  deploy: boolean;
  /** Network calls leave this machine (third-party AI, Copado cloud). */
  network: boolean;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  provider: string;
  capabilities: Capability[];
  mechanism: Mechanism;
  inputSchema: string;
  outputSchema: string;
  permissions: AgentPermissions;
  costTier: Tier;
  latencyTier: Tier;
  /** Lower number = preferred when several agents offer the same capability. */
  preference: number;
  /** True when the adapter returns simulated results; results are labeled MOCK everywhere. */
  mock?: boolean;
  restrictions?: string[];
  docs?: string;
}

export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface ExecutionContext {
  runId: string;
  dryRun: boolean;
  /** Approval record id when the plan has been explicitly approved by a human. */
  approvalId?: string;
  log: (event: string, data?: Record<string, unknown>) => void;
}

export interface AgentResult<T = unknown> {
  ok: boolean;
  output?: T;
  error?: string;
  /** Labels what kind of truth this result represents. */
  evidence: 'local-simulation' | 'external-tool' | 'ai-opinion' | 'copado-validation' | 'copado-deployment' | 'mock' | 'none';
  durationMs?: number;
  costNote?: string;
  /** Which concrete sub-agent answered, e.g. "copado build agent". */
  via?: string;
}

export interface AgentAdapter {
  descriptor: AgentDescriptor;
  isAvailable(): Promise<Availability>;
  execute(capability: Capability, input: unknown, ctx: ExecutionContext): Promise<AgentResult>;
}

// ---------- Findings / reports ----------

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'blocker';

export type FindingCategory =
  | 'dependency'
  | 'conflict'
  | 'security'
  | 'integration'
  | 'automation'
  | 'reporting'
  | 'deployment'
  | 'assumption'
  | 'scope'
  | 'unverified';

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: Severity;
  title: string;
  /** Why the engine believes this. */
  explanation: string;
  components: ComponentId[];
  stories: string[];
  evidence: Provenance[];
  mitigation?: string;
  tests?: string[];
}

export interface ImpactEntry {
  component: ComponentId;
  depth: number;
  via: { from: ComponentId; to: ComponentId; kind: DependencyKind; source: Provenance }[];
  tags: string[];
}

export interface BlastRadius {
  changed: ComponentId[];
  direct: ImpactEntry[];
  indirect: ImpactEntry[];
}

export interface ComponentDiff {
  id: ComponentId;
  change: 'added' | 'removed' | 'modified';
  attributes?: { key: string; before: unknown; after: unknown }[];
  nodes?: { node: string; before: unknown; after: unknown }[];
  stories: string[];
}

export interface ScheduleWave {
  index: number;
  tasks: string[];
  reason: string;
}

export interface Schedule {
  waves: ScheduleWave[];
  edges: { before: string; after: string; reason: string }[];
  mergeable: { tasks: string[]; component: ComponentId; nodes: string[] }[];
  collisions: { tasks: string[]; key: string }[];
}

export type Decision = 'APPLY' | 'REVISE' | 'REJECT';

export interface RiskDimension {
  name: string;
  level: Tier;
  reasons: string[];
}

export interface RiskReport {
  overall: Tier;
  decision: Decision;
  decisionReason: string;
  dimensions: RiskDimension[];
  mitigations: string[];
  tests: string[];
  missingInformation: string[];
  limitations: string[];
}

export interface SimulationResult {
  baseline: { name: string; components: number; dependencies: number };
  after: { components: number; dependencies: number };
  diff: ComponentDiff[];
  blastRadius: BlastRadius;
  findings: Finding[];
  reevaluate: { task: string; because: string; triggeredBy: string[] }[];
  limitations: string[];
}
