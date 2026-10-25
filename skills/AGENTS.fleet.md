# Fleet Coordinator rules

Paste this section into your project's AGENTS.md **outside** the `<!-- agentia:managed:start/end -->` markers. A later `agentia setup` run replaces everything between those markers.

## Before you submit or promote

- Simulate every Copado user story with the fleet first: `fleet_simulate_branches` (MCP) or `fleet run --git . --base <next-env-branch> --stories <US-…> --from-copado --json`.
- Do not submit, promote or deploy a story whose run is REVISE or REJECT. Fix the story and simulate again.
- Before running any `agentia` submit, promote or deploy tool, call `fleet_execution_preview`. Act only if it succeeds, and follow its order.
- Promote in the fleet's wave order. Run `agentia cicd work environment-sync` where the promotion plan lists it.
- Approval is human-only. Never run `fleet approve`, and never pass `--accept-risk` or `--allow-deploy`.
- To resolve a promotion conflict, use `fleet conflicts <runId> --promotion <id>` before resolving by hand.

## Copado AI MCP server (`copado-ai`), when connected

- Use its read-only tools freely for context: `copado_cicd_list_user_stories`, `copado_cicd_list_pipelines`, `copado_cicd_project_overview`, `copado_cicd_describe_object`, `retrieve_knowledge` (Org Intelligence), `copado_cicd_analyze_job_execution`, `copado_cicd_get_error_log_analysis`.
- Never call `copado_cicd_promote_user_story`, `copado_cicd_deploy_promotion` or `copado_cicd_commit_metadata` yourself; they are denied in `.claude/settings.json`. Approved delivery runs through `fleet execute <runId> --live --deploy`, which a person starts.
