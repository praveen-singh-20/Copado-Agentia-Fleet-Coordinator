# Agentia Fleet Coordinator + Simulation Engine

Before Copado promotes anything, the fleet takes **every in-flight user story together**, builds the org as it would look after all of them, and tells you:

- what breaks,
- which stories collide, and
- the order to promote them in.

After a person approves that exact plan, it drives the stories through Copado with the Agentia CLI, wave by wave.

**Copado Agentia does the real work at every stage:**

- **Stories:** the in-flight stories come from Copado.
- **AI review:** five Copado AI agents review the batch.
- **Dependencies:** Copado's dependency analyzer checks each story branch.
- **Delivery:** Copado runs quality gates, back-promotion sync, validation and deployment.
- **Conflicts:** promotion conflicts are resolved through Copado.

Third-party AI (Claude Code, Codex, Cursor, Copilot) is optional, for fallback and second opinions.

| Doc | What's in it |
|---|---|
| [docs/AGENTIA.md](docs/AGENTIA.md) | Every Agentia command the fleet uses, at which stage, and why |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, design decisions, simulation rules |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Each agent/tool, how it is invoked, sources |
| [docs/COPADO_AI.md](docs/COPADO_AI.md) | **Copado AI MCP server** (your "Claude MCP access"): Org Intelligence in Claude Code; stories + approved deployment without the Agentia CLI |

## What's built

| Phase | What | State |
|---|---|---|
| 1 Core | Registry/router, planner, simulation, explainable risk, approval, hash-chained audit | ✅ tested |
| 2 Real metadata | XML parser, SFDX importer (fields, validation rules, flows, Apex, triggers, profiles, permission sets, reports, dashboards), overlay file, branch diff → change ops, Git loader | ✅ tested |
| 3 Agentia everywhere | Copado stories, 5 Copado AI agents, dependency analyzer, delivery loop, conflicts, RCA, doctor | ✅ tested against a CLI **stub**; not yet run against a real Copado org |
| 4 Web UI | Local page: verdict, strip board, findings, before/after, blast-radius graph, risk, commands, approve | ✅ tested |
| 3b Copado AI MCP | AI Context Hub MCP client: stories, promote → deploy after approval; `copado-ai` server for Claude Code with write tools denied | ✅ tested against an MCP **stub**; argument names read from Copado's schemas at runtime |
| 5 Agent surfaces | MCP server (no approve tool), Agent Skill, AGENTS.md rules, Agentia plugin | MCP + skill ✅ tested; plugin written, **not built yet** (needs Copado's plugin SDK) |
| 6 Docs | This README, reference docs, sample repos | ✅ |

`npm test`: 55 tests, no runtime dependencies.

## Hackathon fit

The official judging criteria weren't public when this was written. These are the themes earlier Copado hackathons and entrants' write-ups point to.

| Theme | How this entry answers it |
|---|---|
| **Uses Agentia heavily** | Agentia handles every action in Copado (stories, quality gates, back-promotion sync, validation, deployment, conflicts) and every AI answer through its five agents (Plan, Build, Test, Release, Operate). In VS Code, Claude Code drives Copado through **Agentia's own MCP server**. See docs/AGENTIA.md |
| **Innovation** | Simulates *all in-flight stories together* and forecasts collisions down to single permission entries. It catches breakage that only appears when stories combine, which per-story review, code review and single-story conflict tools can't see |
| **Business value** | Fewer failed UAT and production deployments, fewer manual merge fixes, a correct promotion and back-promotion order, and an evidence trail for release managers and auditors |
| **Governance and safety** | The engine's decisions are deterministic and explainable. AI findings are labeled and can't override rules. Human approval is tied to the exact plan; the MCP server has no approve tool; writes are never retried; mocks are labeled. Tamper-evident audit |
| **Extensibility** | Agents plug in by capability (Copado AI, Claude Code, Codex, Cursor, Copilot). Ships an MCP server, an Agent Skill, AGENTS.md rules and an Agentia CLI plugin |

**Next steps after the hackathon:** an MCP-based connection from the fleet to Agentia (once Copado publishes the tool names), more metadata types, and data-volume checks.

## Use it on your own repository (works before Agentia is set up)

Run these in your Salesforce repo, on a clean working tree:

```bash
fleet init . --copado-ai                       # MCP config, skill, rules for Claude Code (add --no-agentia until Agentia works)
#   then fill in .fleet/copado-ai.env (Copado AI key + org id) and run: fleet doctor
fleet scenario seed .                          # writes the sample baseline into force-app + fleet.overlay.json
sf project deploy start --source-dir force-app --target-org <each pipeline org>
git add -A && git commit -m "Fleet sample baseline" && git push   # then merge into every environment branch
fleet scenario stories . --base <dev branch> --ids <5 Copado story IDs, in order>
git push origin feature/US-…                   # the five story branches
fleet run --git . --base <dev branch> --stories <the 5 IDs>   # → REVISE
```

`--variant revised` creates the fixed versions of the branches (→ APPLY).

**Without Agentia**, everything in the fleet works except the Copado actions:

| Works now | Works now with Copado AI MCP (`--copado-ai`) | Waits for Agentia |
|---|---|---|
| Simulation, collision forecast, risk, findings, promotion plan, approval, audit, UI, MCP in Claude Code, execution preview | Stories from Copado (`--from-copado-ai`); Org Intelligence and Copado reads inside Claude Code; approved promote + deploy (`fleet execute --live --deploy`) | Validate-only (`fleet execute --live`), back-promotion sync, local gates, `--copado-impact`, Agentia AI agents (`--ai` falls back to the Claude Code CLI), `fleet conflicts` |

Anything with no real agent shows `MOCK`. See [docs/COPADO_AI.md](docs/COPADO_AI.md).

## Quick start (no Copado needed)

You need **Node.js 22.18 or newer** and **git**.

```bash
cd fleet-coordinator
npm test                       # 55 tests
npm run sample:repos           # creates sample/acme-org (+ -revised): main + 5 story branches
npm run sample:git             # five stories from Git → REVISE
npm run sample:git-revised     # fixed stories → APPLY
node src/cli.ts ui             # http://127.0.0.1:4600
```

Then copy the run ID that `sample:git-revised` prints:

```bash
node src/cli.ts approve <runId> --by "Your Name"
node src/cli.ts execute <runId>          # dry-run: the exact Agentia commands
node src/cli.ts audit --verify
```

`npm link` once gives you a `fleet` command, used below.

## With Copado (your credentials)

```bash
npm install -g @copado/agentia-cli@beta
agentia setup                                   # CI/CD + AI auth, project defaults
fleet doctor                                    # checks Agentia, health check, AI quota

cd <your Salesforce repo>                       # Source Format pipeline
fleet run --git . --base origin/main --from-copado --copado-impact --ai
fleet approve <runId> --by "Your Name" [--allow-deploy]
fleet execute <runId> --live                    # validate each story through Copado
fleet execute <runId> --live --deploy           # deploy to the next environment (needs --allow-deploy)
fleet conflicts <runId> --promotion <P-id> --apply
```

**Branch naming.** Story branches are read as `feature/<story>`, which is Agentia's local flow. Use `--branch-pattern` for anything else.

**Overlay file.** Things that aren't Salesforce metadata go in `fleet.overlay.json` at the repo root: integrations, report audiences, PII tags. `sample/acme-org/fleet.overlay.json` is an example.

## Commands

| Command | What it does |
|---|---|
| `fleet run --git <repo> --base <ref> [--stories …] [--from-copado] [--copado-impact] [--ai] [--second-opinion]` | Simulate story branches together |
| `fleet run <stories.json> --snapshot <file or force-app>` | Simulate hand-written stories |
| `fleet show / runs / compare <a> <b>` | Read runs; compare before and after a revision |
| `fleet approve <run> --by "<name>" [--accept-risk] [--allow-deploy]` | Human approval of the exact plan |
| `fleet execute <run> [--live] [--deploy] [--evidence] [--publish] [--no-gates]` | Governed delivery through Agentia |
| `fleet conflicts <run> --promotion <id> [--apply]` | Forecast-guided conflict resolution |
| `fleet import <folder> [--out f.json]` | Snapshot of a Salesforce project |
| `fleet agents`, `fleet doctor`, `fleet audit [--verify]` | Fleet, environment, audit trail |
| `fleet ui [--port]`, `fleet mcp` | Web UI; MCP server for Claude Code / Cursor |

**Global flags:**

| Flag | Effect |
|---|---|
| `--work-dir` | Where runs are stored (default `.fleet`) |
| `--offline` | Never use agents that send data off this machine |
| `--deny <ids>` | Exclude specific agents |
| `--local-only` | Use only the built-in agents |
| `--json` | Machine-readable output |

## Coding agents (Claude Code, Cursor)

1. Merge `skills/mcp.example.json` into `.mcp.json` (Claude Code) or `.cursor/mcp.json`. That gives the agent both Agentia's tools and the fleet's.
2. Copy `skills/fleet-coordinator/` into `.claude/skills/` or `.cursor/skills/`.
3. Paste `skills/AGENTS.fleet.md` into `AGENTS.md`, outside Agentia's managed markers.

The MCP server has **no approve, live-execute, deploy or conflict-resolve tool**. Those stay with a person.

## Agentia plugin

`agentia-plugin/` adds `agentia fleet check`, which simulates the active story with all in-flight stories. See its README. It's written to Copado's documented SDK but hasn't been compiled yet; build it once you have the SDK.

## Project structure

```
src/
  cli.ts  app.ts                  CLI; shared entry points for CLI, MCP and UI
  core/                           contracts (types.ts), fleet wiring (fleet.ts)
  registry/registry.ts            capability routing, retries, fallback, second opinions
  coordinator/                    workflow, approval, execution, conflicts, planner, pool
  graph/ simulation/ risk/        metadata state + blast radius, simulation rules, risk
  importer/ xml/ sources/         SFDX import, branch diff, git reader, Copado story source
  agentia/client.ts               every Agentia CLI command in one place
  ai/contracts.ts                 JSON contracts for the 5 AI capabilities
  adapters/                       local agents; Agentia, third-party AI, mock adapters
  mcp/ ui/ report/ audit/
scripts/make-sample-repo.ts       sample Salesforce repo with 5 story branches
agentia-plugin/                   oclif plugin for the Agentia CLI
skills/                           Agent Skill, AGENTS.md section, MCP config
fixtures/  test/  docs/
```

## Common errors

| Error | Fix |
|---|---|
| `Unexpected token ':'` / `ERR_UNKNOWN_FILE_EXTENSION ".ts"` | Node older than 22.18. Upgrade |
| `Base ref "origin/main" not found` | `git fetch`, or pass `--base main` |
| `no branch feature/US-…` | Story not started locally, or a different naming. Use `--branch-pattern` |
| `agentia … exited 1: … clean tracked tree` | Commit or stash before `--live` |
| `does not allow deployment` | Approve again with `--allow-deploy` |
| `The plan changed after approval` | Run again, approve again |
| Execution shows `MOCK` | Agentia CLI not found. Nothing was sent to Copado |
| `npm run typecheck` fails | `npm install` once (TypeScript is only needed for type checking) |
