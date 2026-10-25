// Client for Copado's AI Context Hub MCP server (Copado AI "Claude MCP access").
//
// It is a remote MCP server over streamable HTTP. Endpoints (Copado docs, "AI Context Hub MCP
// Server: Integrate with External LLMs and Development Tools"):
//   US https://copadogpt-api.robotic.copado.com/mcp/     EU https://copadogpt-api.eu-robotic.copado.com/mcp/
//   AU https://copadogpt-api.au-robotic.copado.com/mcp/  SG https://copadogpt-api.sg-robotic.copado.com/mcp/
// Headers: X-Authorization (personal access key), X-Organization-Id, optional X-Workspace-Id.
//
// The fleet uses it where the Agentia CLI is not available: in-flight user stories
// (copado_cicd_list_user_stories) and, after a human approval that allows deployment,
// promotion + deployment (copado_cicd_promote_user_story → copado_cicd_deploy_promotion).
// Tool argument names are not documented, so they are read from each tool's inputSchema at runtime.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { get } from '../agentia/client.ts';

export const COPADO_AI_REGIONS: Record<string, string> = {
  us: 'https://copadogpt-api.robotic.copado.com/mcp/',
  eu: 'https://copadogpt-api.eu-robotic.copado.com/mcp/',
  au: 'https://copadogpt-api.au-robotic.copado.com/mcp/',
  sg: 'https://copadogpt-api.sg-robotic.copado.com/mcp/',
};

export const ENV = {
  url: 'COPADO_AI_MCP_URL',
  pat: 'COPADO_AI_PAT',
  org: 'COPADO_AI_ORG_ID',
  workspace: 'COPADO_AI_WORKSPACE_ID',
  region: 'COPADO_AI_REGION',
} as const;

/** Default place for the credentials file; .fleet/ is git-ignored by `fleet init`. */
export const ENV_FILE = path.join('.fleet', 'copado-ai.env');

export interface CopadoAiConfig {
  url: string;
  pat: string;
  orgId: string;
  workspaceId?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
}

/** KEY=VALUE lines; # comments; optional quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Credentials from the environment, then from .fleet/copado-ai.env (or COPADO_AI_ENV_FILE).
 * Returns undefined with the reason when something required is missing.
 */
export function loadCopadoAiConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): { config?: CopadoAiConfig; reason?: string; source?: string } {
  const file = env.COPADO_AI_ENV_FILE ?? path.join(cwd, ENV_FILE);
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  const pick = (k: string) => (env[k] && env[k]!.trim()) || fromFile[k] || undefined;
  const region = (pick(ENV.region) ?? 'us').toLowerCase();
  const url = pick(ENV.url) ?? COPADO_AI_REGIONS[region];
  const pat = pick(ENV.pat);
  const orgId = pick(ENV.org);
  const missing = [!url && `${ENV.url} (or ${ENV.region}=us|eu|au|sg)`, !pat && ENV.pat, !orgId && ENV.org].filter(Boolean);
  if (missing.length) return { reason: `Copado AI MCP not configured: set ${missing.join(', ')} in your environment or in ${ENV_FILE}` };
  return { config: { url: url!, pat: pat!, orgId: orgId!, workspaceId: pick(ENV.workspace) }, source: Object.keys(fromFile).length ? file : 'environment' };
}

export class CopadoMcpError extends Error {}

type Fetch = typeof fetch;

export class CopadoMcpClient {
  private session?: string;
  private initialized?: Promise<void>;
  private nextId = 1;
  private toolCache?: McpTool[];
  readonly config?: CopadoAiConfig;
  readonly reason?: string;
  private readonly fetchImpl: Fetch;
  private readonly timeoutMs: number;

  constructor(opts: { config?: CopadoAiConfig; env?: NodeJS.ProcessEnv; cwd?: string; fetch?: Fetch; timeoutMs?: number } = {}) {
    if (opts.config) this.config = opts.config;
    else {
      const loaded = loadCopadoAiConfig(opts.env, opts.cwd);
      this.config = loaded.config;
      this.reason = loaded.reason;
    }
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  get configured(): boolean {
    return !!this.config;
  }

  private headers(): Record<string, string> {
    const c = this.config!;
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      'X-Authorization': c.pat,
      'X-Organization-Id': c.orgId,
      ...(c.workspaceId ? { 'X-Workspace-Id': c.workspaceId } : {}),
      ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
    };
  }

  private async post(body: Record<string, unknown>): Promise<unknown> {
    if (!this.config) throw new CopadoMcpError(this.reason ?? 'Copado AI MCP not configured');
    const res = await this.fetchImpl(this.config.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (res.status === 202 || body.id === undefined) return undefined;
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' Check the personal access key, organization id and region.' : '';
      throw new CopadoMcpError(`Copado AI MCP HTTP ${res.status}: ${text.slice(0, 300)}${hint}`);
    }
    const ctype = res.headers.get('content-type') ?? '';
    const messages: { id?: unknown; result?: unknown; error?: { message?: string; code?: number } }[] = [];
    if (ctype.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (data) try { messages.push(JSON.parse(data)); } catch { /* keep-alive or partial */ }
      }
    } else if (text.trim()) messages.push(JSON.parse(text));
    const msg = messages.find((m) => m.id === body.id) ?? messages.at(-1);
    if (!msg) throw new CopadoMcpError('Copado AI MCP returned no response');
    if (msg.error) throw new CopadoMcpError(`Copado AI MCP error ${msg.error.code ?? ''}: ${msg.error.message ?? 'unknown'}`);
    return msg.result;
  }

  private request(method: string, params: Record<string, unknown> = {}) {
    return this.post({ jsonrpc: '2.0', id: this.nextId++, method, params });
  }

  private init(): Promise<void> {
    this.initialized ??= (async () => {
      await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agentia-fleet-coordinator', version: '1.0.0' } });
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })().catch((e) => {
      this.initialized = undefined;
      throw e;
    });
    return this.initialized;
  }

  async listTools(): Promise<McpTool[]> {
    if (this.toolCache) return this.toolCache;
    await this.init();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
    } while (cursor);
    this.toolCache = tools;
    return tools;
  }

  async tool(name: string): Promise<McpTool> {
    const t = (await this.listTools()).find((x) => x.name === name);
    if (!t) throw new CopadoMcpError(`Copado AI MCP has no tool ${name}. Enable its toolset in the AI Context Hub (MCP Clients tab), or check X-toolsets.`);
    return t;
  }

  /** Call a tool; returns structured content, else the text content parsed as JSON when possible. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.init();
    const r = (await this.request('tools/call', { name, arguments: args })) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
    const text = (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    if (r?.isError) throw new CopadoMcpError(`${name} failed: ${text.slice(0, 500)}`);
    if (r?.structuredContent !== undefined) return r.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async available(): Promise<{ ok: boolean; reason?: string; version?: string }> {
    if (!this.config) return { ok: false, reason: this.reason };
    try {
      const n = (await this.listTools()).length;
      return { ok: true, version: `${n} tools at ${new URL(this.config.url).host}` };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }
}

// ---------- Argument mapping from a tool's inputSchema ----------

export interface ArgHint {
  /** Matched against the property name. */
  key: RegExp;
  value: unknown;
}

/**
 * Fill a tool's arguments from hints, using the property names its inputSchema declares.
 * The first hint whose pattern matches a property wins. Throws, showing the schema, when a
 * required property can't be filled, so a wrong guess never reaches Copado.
 */
export function fillArgs(tool: McpTool, hints: ArgHint[]): Record<string, unknown> {
  const props = tool.inputSchema?.properties ?? {};
  const args: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(props)) {
    const h = hints.find((x) => x.key.test(name));
    if (!h || h.value === undefined) continue;
    if (spec?.type === 'array' && !Array.isArray(h.value)) args[name] = [h.value];
    else if (spec?.type === 'boolean') args[name] = Boolean(h.value);
    else args[name] = h.value;
  }
  const missing = (tool.inputSchema?.required ?? []).filter((r) => args[r] === undefined);
  if (missing.length) {
    throw new CopadoMcpError(`Can't fill ${tool.name} argument(s) ${missing.join(', ')}. Schema: ${JSON.stringify(tool.inputSchema).slice(0, 600)}. Run \`fleet copado tools\` and report the names.`);
  }
  return args;
}

/** User story names (US-…) and, when present, their record ids, from any list response. */
export function storyRecords(raw: unknown): { name: string; id?: string; title?: string }[] {
  const out = new Map<string, { name: string; id?: string; title?: string }>();
  const visit = (o: Record<string, unknown>) => {
    const name = Object.values(o).find((v) => typeof v === 'string' && /^US-\d+$/.test(v)) as string | undefined;
    if (!name) return false;
    const id = (get(o, 'Id') ?? get(o, 'recordId') ?? get(o, 'userStoryId')) as string | undefined;
    const title = (get(o, 'copado__User_Story_Title__c') ?? get(o, 'title') ?? get(o, 'User_Story_Title__c') ?? get(o, 'subject')) as string | undefined;
    if (!out.has(name)) out.set(name, { name, ...(id && id !== name ? { id: String(id) } : {}), ...(title ? { title: String(title) } : {}) });
    return true;
  };
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (!visit(v as Record<string, unknown>)) Object.values(v).forEach(walk);
    } else if (typeof v === 'string' && /^US-\d+$/.test(v) && !out.has(v)) out.set(v, { name: v });
  };
  if (typeof raw === 'string') for (const m of raw.matchAll(/\bUS-\d+\b/g)) out.set(m[0], { name: m[0] });
  else walk(raw);
  return [...out.values()];
}

/** A promotion record id (preferred) or name (P-…) from a promote response. */
export function promotionRef(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.match(/promotion\W+(?:id\W+)?([a-zA-Z0-9]{15,18})\b/i)?.[1] ?? raw.match(/\bP-\d+\b/)?.[0];
  let byKey: string | undefined;
  let byName: string | undefined;
  const walk = (v: unknown) => {
    if (byKey || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    for (const [k, x] of Object.entries(v)) {
      if (/^promotion(_?(record_?)?id)?$/i.test(k) && typeof x === 'string' && x) byKey = x;
      else if (/^promotion$/i.test(k) && x && typeof x === 'object' && !Array.isArray(x)) {
        const o = x as Record<string, unknown>;
        const r = get(o, 'Id') ?? get(o, 'id') ?? get(o, 'Name');
        if (typeof r === 'string') byKey = r;
      } else if (typeof x === 'string' && /^P-\d+$/.test(x)) byName ??= x;
      if (byKey) return;
    }
    Object.values(v).forEach(walk);
  };
  walk(raw);
  return byKey ?? byName;
}

export const COPADO_AI_TOOLS = {
  listStories: 'copado_cicd_list_user_stories',
  promote: 'copado_cicd_promote_user_story',
  deployPromotion: 'copado_cicd_deploy_promotion',
  analyzeJob: 'copado_cicd_analyze_job_execution',
  errorLog: 'copado_cicd_get_error_log_analysis',
} as const;

/** Tool names that change Copado or Salesforce. Claude Code is told to deny these; delivery goes through `fleet execute`. */
export const COPADO_AI_WRITE_TOOLS = ['copado_cicd_promote_user_story', 'copado_cicd_deploy_promotion', 'copado_cicd_commit_metadata'];
/** Read-only tools Claude Code may call without asking. */
export const COPADO_AI_READ_TOOLS = [
  'copado_cicd_list_user_stories', 'copado_cicd_list_epics', 'copado_cicd_list_features', 'copado_cicd_list_applications',
  'copado_cicd_list_projects', 'copado_cicd_project_overview', 'copado_cicd_list_releases', 'copado_cicd_list_sprints',
  'copado_cicd_list_pipelines', 'copado_cicd_list_vsms', 'copado_cicd_get_vsm_detail', 'retrieve_knowledge',
  'copado_cicd_analyze_job_execution', 'copado_cicd_get_record_information', 'copado_cicd_describe_object',
  'copado_cicd_find_team', 'copado_cicd_get_error_log_analysis', 'salesforce_read_metadata',
];
