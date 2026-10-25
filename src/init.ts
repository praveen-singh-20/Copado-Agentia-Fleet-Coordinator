// `fleet init`: wire an existing Salesforce repository for Claude Code (or Cursor).
//   .mcp.json                         fleet MCP server (+ Agentia's, unless --no-agentia); merged if the file exists
//   .claude/skills/fleet-coordinator  the fleet playbook
//   .claude/settings.json             read-only fleet tools allowed without prompts (merged)
//   CLAUDE.md, AGENTS.md              the fleet rules, in a marked section (replaced on re-run, rest kept)
//   .gitignore                        .fleet/
//   --copado-ai: "copado-ai" MCP server (Copado AI Context Hub) + .fleet/copado-ai.env template;
//                its read-only tools are allowed, promote/deploy/commit are denied (delivery goes through fleet execute)

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPADO_AI_READ_TOOLS, COPADO_AI_REGIONS, COPADO_AI_WRITE_TOOLS, ENV, ENV_FILE } from './copado/mcpClient.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const READ_ONLY_TOOLS = ['fleet_simulate_branches', 'fleet_simulate_file', 'fleet_report', 'fleet_compare', 'fleet_execution_preview', 'fleet_agents', 'fleet_runs'].map((t) => `mcp__fleet__${t}`);
const START = '<!-- fleet:start -->';
const END = '<!-- fleet:end -->';

export interface InitOptions {
  agentia?: boolean;
  /** Add Copado AI's MCP server (AI Context Hub). */
  copadoAi?: boolean;
  copadoRegion?: string;
  /** Text placed above the rules in CLAUDE.md/AGENTS.md when those files are new. */
  projectIntro?: string;
}

export interface InitResult {
  repo: string;
  changed: string[];
  /** Credentials file to fill in, when --copado-ai wrote a new template. */
  copadoAiEnv?: string;
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON; fix or remove it and run again.`);
  }
}

export function rulesText(): string {
  return readFileSync(path.join(ROOT, 'skills', 'AGENTS.fleet.md'), 'utf8').replace(/^Paste this section[\s\S]*?markers\.\n\n/m, '').trim();
}

function upsertSection(file: string, section: string, intro?: string) {
  const block = `${START}\n${section}\n${END}`;
  if (!existsSync(file)) {
    writeFileSync(file, `${intro ? intro.trim() + '\n\n' : ''}${block}\n`);
    return;
  }
  const text = readFileSync(file, 'utf8');
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a >= 0 && b > a) writeFileSync(file, text.slice(0, a) + block + text.slice(b + END.length));
  else writeFileSync(file, `${text.replace(/\s*$/, '')}\n\n${block}\n`);
}

export function initRepo(repoArg: string, opts: InitOptions = {}): InitResult {
  const repo = path.resolve(repoArg);
  if (!existsSync(path.join(repo, '.git'))) throw new Error(`${repo} is not a Git repository root.`);
  const changed: string[] = [];
  const cli = path.join(ROOT, 'src', 'cli.ts');

  // .mcp.json
  const mcpFile = path.join(repo, '.mcp.json');
  const mcp = readJson(mcpFile) as { mcpServers?: Record<string, unknown> };
  mcp.mcpServers = mcp.mcpServers ?? {};
  const envFile = path.join(repo, ENV_FILE);
  mcp.mcpServers.fleet = { type: 'stdio', command: process.execPath, args: [cli, 'mcp', '--work-dir', path.join(repo, '.fleet')], env: { COPADO_AI_ENV_FILE: envFile } };
  const q = (s: string) => JSON.stringify(s);
  if (opts.copadoAi) {
    // Headers come from a helper so the access key stays in the git-ignored .fleet/copado-ai.env.
    mcp.mcpServers['copado-ai'] = {
      type: 'http',
      url: COPADO_AI_REGIONS[opts.copadoRegion ?? 'us'],
      headersHelper: `${q(process.execPath)} ${q(cli)} copado headers --cwd ${q(repo)}`,
    };
  }
  if (opts.agentia !== false) mcp.mcpServers.agentia = { type: 'stdio', command: 'agentia', args: ['mcp', 'start'], env: { AGENTIA_PROJECT_ROOT: repo } };
  else delete mcp.mcpServers.agentia;
  writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + '\n');
  changed.push('.mcp.json');

  // Skill
  const skillDir = path.join(repo, '.claude', 'skills', 'fleet-coordinator');
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(path.join(ROOT, 'skills', 'fleet-coordinator', 'SKILL.md'), path.join(skillDir, 'SKILL.md'));
  changed.push('.claude/skills/fleet-coordinator/SKILL.md');

  // Permissions for read-only fleet tools
  const settingsFile = path.join(repo, '.claude', 'settings.json');
  const settings = readJson(settingsFile) as { permissions?: { allow?: string[] } };
  settings.permissions = settings.permissions ?? {};
  settings.permissions.allow = [...new Set([...(settings.permissions.allow ?? []), ...READ_ONLY_TOOLS, ...(opts.copadoAi ? COPADO_AI_READ_TOOLS.map((t) => `mcp__copado-ai__${t}`) : [])])];
  if (opts.copadoAi) {
    const p = settings.permissions as { deny?: string[] };
    p.deny = [...new Set([...(p.deny ?? []), ...COPADO_AI_WRITE_TOOLS.map((t) => `mcp__copado-ai__${t}`)])];
  }
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  changed.push('.claude/settings.json');

  // Rules
  const rules = rulesText();
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    upsertSection(path.join(repo, f), rules, opts.projectIntro);
    changed.push(f);
  }

  // .gitignore
  const gi = path.join(repo, '.gitignore');
  const giText = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!/^\.fleet\/?$/m.test(giText)) {
    appendFileSync(gi, `${giText && !giText.endsWith('\n') ? '\n' : ''}.fleet/\n`);
    changed.push('.gitignore');
  }
  let copadoAiEnv: string | undefined;
  if (opts.copadoAi && !existsSync(envFile)) {
    mkdirSync(path.dirname(envFile), { recursive: true });
    writeFileSync(
      envFile,
      [
        '# Copado AI (AI Context Hub) MCP credentials. Git-ignored. Used by the fleet and by Claude Code.',
        '# Personal access key: AI Context Hub > Profile > Personal Access Keys. Org id: numeric. Workspace id: optional UUID.',
        `${ENV.pat}=`,
        `${ENV.org}=`,
        `# ${ENV.workspace}=`,
        `${ENV.region}=${opts.copadoRegion ?? 'us'}`,
        `# ${ENV.url}=https://copadogpt-api.robotic.copado.com/mcp/`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    changed.push(ENV_FILE);
    copadoAiEnv = envFile;
  }
  return { repo, changed, ...(copadoAiEnv ? { copadoAiEnv } : {}) };
}
