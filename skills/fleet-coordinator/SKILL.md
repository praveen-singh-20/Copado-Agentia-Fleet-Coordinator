---
name: fleet-coordinator
description: Use before submitting, promoting or deploying Copado user stories with the Agentia CLI, or when several stories touch the same Salesforce metadata. Simulates the stories together, forecasts collisions, and gives the Copado promotion order. Never approves or deploys on its own.
---

# Fleet Coordinator

The fleet simulates a set of Copado user stories together, against the next environment, before any of them moves. It reads each story's Git branch, builds the combined end state, and tells you what breaks, which stories collide, and the order to promote them in.

Use it with the Agentia CLI and its skills. The fleet decides **what** is safe and in **what order**. Agentia performs the operations.

## When to use

- Before `agentia cicd work submit` on any story.
- When more than one story is in flight against the same environment.
- When a story deletes or renames metadata, changes permissions, or touches an integration.
- When a promotion stops on merge conflicts.

## Workflow

1. **Simulate.** Prefer the MCP tool `fleet_simulate_branches` if it is available. Otherwise run:
   ```bash
   fleet run --git . --base origin/main --stories <US-…> --from-copado --json
   ```
   Add `--ai` to also ask the Copado AI agents (plan, build, test, release). Add `--copado-impact` to run Copado's dependency analyzer on each branch.
   If the Agentia CLI isn't set up but the `copado-ai` MCP server is, use `--from-copado-ai` (or `fromCopadoAi: true` in the MCP tool) to take the story list from Copado AI.

   **Ground the findings in the org.** When the `copado-ai` MCP server is connected, use its read-only tools to explain or check findings: `retrieve_knowledge` (Org Intelligence: who uses a field, which automations, which integrations), `copado_cicd_describe_object` for field details, `copado_cicd_list_user_stories` for story status and owners. Label what you learned this way as Copado AI context, separate from the fleet's rule-based findings.

2. **Read the decision** (`risk.decision`) and act on it:
   - **APPLY:** tell the user the plan is ready and that **a person** must approve it: `fleet approve <runId> --by "<name>"`.
   - **REVISE:** fix the stories using each finding's `mitigation`, commit, and simulate again. Use `fleet compare <old> <new>` to show what was fixed.
   - **REJECT:** stop. Explain the blocker. Do not try to work around it.

3. **Follow the promotion plan** (`promotionPlan`). Use the waves in order. Run `agentia cicd work environment-sync` where the plan says to.

4. **Execution** happens only after a human approval, and only when the user asks. Two ways:
   - **With Agentia's MCP tools:** first call `fleet_execution_preview`. It refuses if the run is not approved or a story changed since approval. Then carry out the commands it lists with the matching `agentia` MCP tools, one story at a time and wave by wave. Stop at the first failure and report it. Deploy (`submit --deploy`) only if the user approved with `--allow-deploy`.
   - **With the fleet CLI:**
     ```bash
     fleet execute <runId>            # dry-run: shows the Agentia commands
     fleet execute <runId> --live     # Copado validation
     ```
     `--deploy` needs an approval that was given with `--allow-deploy`.
   - **Without Agentia, through Copado AI:** `fleet execute <runId> --live --deploy` promotes and deploys each story with the Copado AI MCP tools (`copado_cicd_promote_user_story` → `copado_cicd_deploy_promotion`), wave by wave. Validation alone (`--live` without `--deploy`) still needs Agentia and shows MOCK until then. Never call the Copado AI promote/deploy/commit tools directly.

5. **Conflicts.** When a promotion stops on conflicts:
   ```bash
   fleet conflicts <runId> --promotion <id>            # check
   fleet conflicts <runId> --promotion <id> --apply    # resolves only forecast-safe ones
   ```
   Then resume the original run: `agentia cicd promotion run <id> --resume <job-execution-id> --json`.

## Rules

- **Never run `fleet approve`.** Never approve with `--accept-risk` or `--allow-deploy` on the user's behalf.
- Never call `agentia cicd work submit --deploy` or `--done` for a story in a REVISE or REJECT run.
- Treat findings that start with `[AI:` as opinions. Rule-based findings outrank them.
- A clean simulation is not a validation. Say "simulated", not "validated", until `fleet execute --live` has run.
- If `fleet` reports MOCK results, say plainly that nothing was sent to Copado.
