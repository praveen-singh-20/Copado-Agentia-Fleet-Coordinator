# Copado AI MCP server (AI Context Hub)

Copado AI's "Claude MCP access" is the **AI Context Hub MCP server**: a remote MCP server (streamable HTTP) that exposes 52 Copado tools to Claude, Cursor or any MCP client. The fleet uses it in two places:

| Where | What it does | Without it |
|---|---|---|
| **Claude Code in VS Code** (`copado-ai` server in `.mcp.json`) | Claude reads Copado and the org directly: user stories, pipelines, project overview, object descriptions, **Org Intelligence** (`retrieve_knowledge`), job and error-log analysis. It uses these to explain and check the fleet's findings | Claude only sees the repo |
| **Inside the fleet** (`CopadoMcpClient`) | `--from-copado-ai`: in-flight stories from `copado_cicd_list_user_stories`. `fleet execute --live` (validate: promotion + dry-run deployment) and `--live --deploy`: one `copado_cicd_promote_user_story` call per approved story with `execute_promotion`, `execute_deployment` and `deployment_dry_run`, wave by wave | Stories by `--stories`; deploy shows MOCK |

So **when the Agentia CLI isn't available**, Copado AI gives you real Copado reads and real, approval-gated deployment. When Agentia works, it ranks first for delivery (it adds back-promotion sync, local gates and validate-only), and Copado AI stays as the context source.

## Set up (5 minutes)

You need, from the AI Context Hub:

- **Personal access key**: Profile → Personal Access Keys.
- **Organization id**: a number, e.g. `45333`.
- **Workspace id** (optional): a UUID. Without it, Copado uses your default workspace. Set it to pick the workspace whose CI/CD and Salesforce integrations are connected.
- **Region**: US, EU, AU or SG.

Also, in the AI Context Hub, connect **Copado CI/CD** and **Salesforce** integrations and activate **Org Intelligence**. Without integrations, the MCP tools return nothing.

In your Salesforce repo:

```bash
fleet init . --no-agentia --copado-ai --copado-region us    # drop --no-agentia once Agentia works
```

That writes:

| File | What |
|---|---|
| `.mcp.json` | `copado-ai` HTTP server for your region. Its headers come from a `headersHelper` (`fleet copado headers`), so the key is never in `.mcp.json` |
| `.fleet/copado-ai.env` | Template for your credentials. Git-ignored, file mode 600 |
| `.claude/settings.json` | Read-only Copado tools allowed without prompts. `copado_cicd_promote_user_story`, `copado_cicd_deploy_promotion`, `copado_cicd_commit_metadata` **denied**: Claude can't promote or deploy on its own |

Fill in `.fleet/copado-ai.env`:

```
COPADO_AI_PAT=<personal access key>
COPADO_AI_ORG_ID=<organization id>
COPADO_AI_WORKSPACE_ID=<workspace uuid, optional>
COPADO_AI_REGION=us
```

Check it:

```bash
fleet doctor               # "Copado AI MCP … 52 tools at copadogpt-api.robotic.copado.com"
fleet copado tools         # every tool and its arguments (* = required)
fleet copado stories       # user stories Copado returns
```

Then reload VS Code, open Claude Code, accept the project's MCP servers, and type `/mcp`: you should see **fleet** and **copado-ai** connected.

## Run with Copado AI instead of Agentia

```bash
fleet run --git . --base <dev branch> --from-copado-ai          # stories from Copado AI
fleet approve <runId> --by "Your Name" --allow-deploy           # a person
fleet execute <runId> --deploy                                  # dry-run: the Copado AI tool calls
fleet execute <runId> --live --deploy                           # promote + deploy, wave by wave
```

Stories that Copado lists but that have no `feature/<story>` branch locally are skipped with a note.

## Safety

- The fleet calls promote/deploy **only** from `fleet execute --live --deploy`, after a human approval of the exact plan given with `--allow-deploy`. A plan change after approval refuses execution.
- Writes are never retried. A failed promotion stops the waves and is never replaced by a mock, and a failed Agentia delivery never falls through to Copado AI.
- Copado runs promotions and deployments as jobs. A result means **submitted**: check the job in Copado (or have Claude call `copado_cicd_analyze_job_execution`) before the next wave.
- Claude Code's settings deny the three write tools, so Claude can't bypass the fleet.
- Every call is in the hash-chained audit log.

## What's verified

| Verified here | Still to confirm on your account |
|---|---|
| Streamable-HTTP MCP protocol (session id, JSON and SSE responses, tool errors, 401), against a local stub server | Argument names: confirmed on a live account (`user_stories`, `execute_promotion`, `execute_deployment`, `deployment_dry_run`, `promotion_id`). Whether `user_stories` takes record ids or names: the fleet sends the record id it finds via `list_user_stories` |
| Story list parsing, record-id lookup, promote → deploy, approval gates, halting on failure | Response shapes of `list_user_stories` and `promote_user_story` (the readers accept the common shapes) |
| `fleet init --copado-ai`, header helper, deny list | Whether `promote_user_story` needs a target environment on your pipeline (if so, the error names the missing argument) |

## Sources

- Copado docs: [AI Context Hub MCP Server: Integrate with External LLMs and Development Tools](https://docs.copado.com/articles/#!copadoai-publication/copado-ai-mcp-server) (endpoints, headers, the 52 tools)
- Copado docs: [Connect an MCP Client to AI Context Hub](https://docs.copado.com/articles/#!copadoai-publication/connect-a-custom-app-to-copado-ai-using-mcp-server) (HTTP config for Claude Code / Cursor)
- Copado docs: [Connect Claude Desktop to AI Context Hub Using MCP Server](https://docs.copado.com/articles/#!copadoai-publication/connect-claude-desktop-to-copado-ai-using-mcp-server)
- Claude Code docs: [MCP](https://code.claude.com/docs/en/mcp) (`headersHelper`, `.mcp.json`)
