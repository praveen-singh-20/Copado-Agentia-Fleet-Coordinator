# Architecture

```
  Copado (agentia cicd work list/get)      Git: base ref + feature/<story> branches      fleet.overlay.json
                │                                         │                                      │
                └──────────────► Story source: SFDX importer → branch diff → change ops ◄────────┘
                                                          │
┌──────────────────────────────────── Fleet Coordinator ─────────────────────────────────────────────┐
│ intake → discovery → ┬ plan (waves, collisions) → impact per wave → SIMULATE combined end state ┐  │
│                      ├ Copado Plan agent: intent vs. changes, per story (parallel)              │  │
│                      └ Copado dependency analyzer per branch (temporary worktrees)              ┘  │
│   → Copado Build / Release / Test agents in parallel (+ optional second opinion)                   │
│   → consolidate (rules outrank AI) → explainable RISK → promotion & back-promotion plan             │
│   → HUMAN APPROVAL bound to plan hash                                                               │
│   → Agentia delivery per story, wave by wave: set → env-sync → gates → [publish] → [evidence]       │
│     → submit [--deploy] → status;  on failure: stop + Copado Operate agent RCA                      │
│   → risk re-assessed with Copado evidence → forecast-guided conflict resolution → audit (hash chain)│
└──────────────┬──────────────────────────────────────────────────────────────────────────────────────┘
               │ every step is a capability request
┌──────────────▼──────── Agent Registry + Router ───────────────────────────────────────────────────┐
│ match capability → availability → policy (offline, deny, write, deploy needs approval)            │
│ → score (preference, cost, latency, failure rate, mock penalty) → retry (read-only only) → fallback │
│ (never from a failed real agent to a mock) → invokeMany for second opinions                        │
└────┬─────────────────────┬────────────────────────────┬───────────────────────┬────────────────────┘
 in-process            agentia CLI                   third-party AI CLIs        MOCK (labeled)
 requirements          agentia.ai (plan/build/       claude-code, codex,        mock.delivery
 planner               test/release/operate)         cursor, copilot
 impact                agentia.dependency
 simulation            agentia.delivery
 risk                  agentia.conflicts

Surfaces: CLI · web UI (127.0.0.1) · MCP server (no approve tool) · Agentia plugin · Agent Skill
```

## Design decisions

| Decision | Reason |
|---|---|
| Deterministic core, AI on top | The core works without AI or an org. AI findings are labeled, capped at medium, and never change a rule-based decision |
| Copado first for every AI capability | Copado AI is preference 1; each capability goes to the matching Copado agent. Third-party AI is fallback or a second opinion |
| Capabilities, not agent names | The coordinator asks for `deploy.validate`, not "Agentia". Adding an agent means registering an adapter (a test proves it) |
| Real metadata as input | Story changes are the diff of each branch against its merge-base, parsed from the same XML/Apex files Copado deploys. Unchanged files (same hash) never count as changes |
| Placeholders for absent metadata | A reference to a field not in the repo is kept, so the simulation reports it missing unless a story in the batch creates it. Standard objects count as present |
| Node-level footprints | Profiles/permission sets are tracked per `fieldPermissions:Object.Field`, so stories touching different entries of one file run in parallel and their Git conflict is auto-resolvable |
| Combined simulation | Stories are applied in wave order to one virtual state, then rules run on the end state. That's how cross-story breakage appears |
| Provenance on every edge | `metadata`, `source-code`, `configuration`, `external-tool`, `inference`. Inferred edges are reported one level lower |
| Approval bound to plan hash | Editing a story voids the approval. Deploy needs an approval given with `--allow-deploy` |
| No retries for writes, no mock after a real failure | A retried submit could deploy twice; a mock would hide a real failure |
| Hash-chained audit | Every agent call, wave, approval, Agentia step and conflict decision is recorded; `fleet audit --verify` detects edits |
| Zero runtime dependencies | Node ≥ 22.18 runs TypeScript directly |

## Logical agents from the brief

| Agent | Implementation |
|---|---|
| Requirement | `local.requirements` (contract validation) + Copado **Plan** agent (intent vs. changes) |
| Planning, agent selection | `local.planner` + `AgentRegistry.route` |
| Impact | `local.impact` (per story), blast radius (combined), Copado dependency analyzer |
| Architecture | Copado **Build** agent (+ second opinion from a third-party AI) |
| Conflict | Planner forecast + simulation rules + `agentia.conflicts` |
| Build | Coding agents through Agentia's MCP + the fleet skill; the fleet decides order, not code |
| Test | Copado **Test** agent + rule-derived tests; local quality gates via `agentia cicd work test` |
| Simulation | `local.simulation` |
| Deployment | `agentia.delivery` (validate / deploy to next environment) |
| Release | Copado **Release** agent (order and back-promotion review) |
| Operate / RCA | Copado **Operate** agent on failed steps |
| Audit | `AuditLog` + optional evidence Manual Task on the Copado story |

## Simulation rules

| # | Rule | Category, severity |
|---|---|---|
| 1 | A change that can't apply at its point in the schedule | deployment, high |
| 2 | A reference to a deleted component, or to one that never existed and no story creates | high (inferred: medium) |
| 2b | A permission node left pointing at a deleted field | deployment, high |
| 3 | Same element written by two stories | conflict, serialized |
| 3b | Same file, different nodes | info, parallel-safe |
| 4 | Story assumptions checked on the end state, with re-evaluation | assumption, high |
| 5 | An inbound integration mapping needs edit access for its run-as user | integration, high |
| 6 | A report audience needs read access on the report's fields | reporting, medium |
| 7 | Access granted to a PII/security field | medium |
| 7b | Any grant to an external profile | blocker |
| 8 | Production automation in the blast radius | automation, medium |
| 8b | Inferred paths | unverified, low |
| — | From the source: a branch behind base | deployment, low (adds env-sync) |
| — | From Copado: a dependency missing in the target | high |

**Decision:** any blocker → REJECT. Any high, or a failed Copado validation → REVISE. Otherwise APPLY.
