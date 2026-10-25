# Integration feasibility matrix

Every command line used by an adapter, and where it comes from. Checked 11–12 Oct 2026.
"Verified" = taken from the vendor's own documentation. Agentia adapters are tested against a local CLI **stub** (`test/stubs/agentia.mjs`) that checks commands, order and guards; nothing here has run against a live Copado org yet.

## Copado / Agentia

| Candidate | Mechanism | Programmatic? | Auth | Data format | Limits | Rules fit | 48 h feasibility | Adapter |
|---|---|---|---|---|---|---|---|---|
| Agentia CLI — dependency analysis | CLI `agentia cicd metadata dependency list --from-changes --base-ref <ref> --json` | Yes | `agentia auth set --cicd <key> --region na` or `agentia setup` | JSON (shape not publicly documented → stored raw, labeled external-tool) | Source Format only; needs Git repo | Required foundation (V1) | High | `agentia.dependency` |
| Agentia CLI — stories | `agentia cicd work list [--assigned-to-me] --json`, `agentia cicd work get <story> --json` | Yes | CI/CD auth | JSON (names read defensively) | — | Yes | Done | story source |
| Copado AI agents | `agentia ai agent ask --agent plan\|build\|test\|release\|operate -p "<prompt>" --no-stream --json` | Yes (`ask` only; `chat` is TTY-only) | AI auth via `agentia setup` | JSON | quota: `agentia ai quota get --json` | Yes | Done | `agentia.ai` (5 capabilities) |
| Copado delivery | `work set` → `work environment-sync` → `work test` → [`work publish`] → [`work deployment-step create`] → `work submit [--deploy]` → `work status` | Yes | CI/CD auth; story needs Credential + Project | JSON | Needs clean tracked tree; local flow only | Yes; needs explicit approval (V3) | Done | `agentia.delivery` |
| Copado conflicts | `agentia cicd promotion conflict list\|resolve --promotion <id> [--mode auto] --json` | Yes | CI/CD auth | JSON | Use `attachmentId`; resume original run | Yes | Done | `agentia.conflicts` |
| Copado Robotic Testing | `agentia testing build run --json`, poll `agentia testing build get` | Yes | Separate CRT auth; gate on `ready: true` from `agentia auth get --crt --json` | JSON | `--watch`/`--stream-logs` not with `--json` | Yes | Low–medium (needs CRT project) | not planned for 48 h |
| Agentia local MCP | `agentia mcp start` (stdio) | Yes, for MCP clients | CLI auth | MCP tools `agentia_*` | Plugins cannot add tools | Yes | Used by coding agents, not by the coordinator | — |
| Copado AI MCP server (AI Context Hub) | Remote MCP, streamable HTTP: `https://copadogpt-api[.eu\|.au\|.sg]-robotic.copado.com/mcp/`; tools `copado_cicd_list_user_stories`, `copado_cicd_promote_user_story`, `copado_cicd_deploy_promotion`, `retrieve_knowledge` and 48 more | Yes | Headers `X-Authorization` (personal access key), `X-Organization-Id`, optional `X-Workspace-Id` | MCP tool results (JSON in text content) | Needs Copado CI/CD + Salesforce integrations in the AI Context Hub; Beta | Yes | Done (stub-tested; argument names read from schemas at runtime) | `copado-ai.delivery`, `--from-copado-ai`, `copado-ai` server in Claude Code |
| Agentia plugin | `npm init @copado/agentia-plugin`, `agentia plugins link .` | Commands only | none passed to plugin | oclif `--json` | No Copado calls, no credentials, no wrapping, no MCP tools | Yes ("ship a plugin") | Written; not compiled (SDK not installable in the build environment) | `agentia-plugin/` |

Sources: https://developer.copado.com/docs · https://developer.copado.com/training · https://developer.copado.com/extend

## External AI agents (all optional)

They do **not** share an API. Each adapter uses that product's own non-interactive CLI and asks for the same JSON contract (`{"concerns":[...]}`), then parses whatever envelope the CLI wraps around it.

| Candidate | Non-interactive interface | Read-only how | Auth | Output | Notes | 48 h feasibility | Adapter |
|---|---|---|---|---|---|---|---|
| Claude Code | `claude -p "<prompt>" --output-format json --permission-mode plan` | plan mode | Claude login / API key | single JSON (`result` field) | Verified working in this environment | High | `claude-code` |
| OpenAI Codex CLI | `codex exec --json --sandbox read-only "<prompt>"` | read-only sandbox (default for exec) | saved CLI auth or `CODEX_API_KEY` | JSON Lines | needs `--skip-git-repo-check` outside a repo | High | `codex` |
| Cursor CLI | `cursor-agent -p --output-format json "<prompt>"` | no `--force` → no file writes | `cursor-agent login` or `CURSOR_API_KEY` | single JSON | binary may be named `agent` in newer installs | Medium | `cursor` |
| GitHub Copilot CLI | `copilot -p "<prompt>" -s` | no `--allow-tool` given | Copilot plan + GitHub login | text (JSON extracted) | public preview | Medium | `copilot` |
| Cursor / Copilot / VS Code IDE chat | IDE only | — | — | — | Not reliably controllable from a script → **manual**: a human can paste the review prompt and the JSON answer | Manual only | — |

Sources: https://docs.claude.com/en/docs/claude-code/headless · https://developers.openai.com/codex/noninteractive · https://cursor.com/docs/cli/headless · https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference

## Technical tools

| Tool | Use | Status |
|---|---|---|
| Salesforce DX project files | Snapshot source: the importer reads `force-app` at any Git ref (`git archive`) | Done; `sf project retrieve start` is how you get the files into Git |
| Git | Isolated branches per story; base ref for Agentia dependency analysis | Used by Agentia adapters |
| Node.js ≥ 22.18 | Runs TypeScript directly; zero runtime dependencies | In use |

## Unverified assumptions (keep visible)

1. The JSON shape of `agentia cicd metadata dependency list` and `agentia ai agent ask` responses — the adapters store raw output and only extract a `concerns` array where present.
2. Cursor's binary name (`cursor-agent` vs `agent`) depends on install version.
3. Whether third-party AI is allowed in the hackathon.
