# How the fleet uses Copado Agentia

Every command below is taken from developer.copado.com/docs or /training (checked 11 Oct 2026) and lives in one file, `src/agentia/client.ts`. The CLI is alpha, so if a flag changes, that is the only file to edit.

| Stage | Agentia command | Why | Guard |
|---|---|---|---|
| Doctor | `agentia --version`, `agentia cicd health-check --json`, `agentia ai quota get --json` | Confirm the CLI, the Copado org and AI quota before a run | read-only |
| Story intake | `agentia cicd work list [--assigned-to-me] --json` | In-flight stories become the batch (`--from-copado`) | read-only |
| | `agentia cicd work get <story> --json` | Story titles | read-only |
| Requirement check | `agentia ai agent ask --agent plan -p … --no-stream --json` | Copado **Plan** agent: components the story should touch vs. what it does | opinion only |
| Impact | `agentia cicd metadata dependency list --from-changes --base-ref <sha> --json` | Copado's analyzer on each story branch, in a temporary `git worktree` | read-only; your checkout untouched |
| Architecture review | `agentia ai agent ask --agent build …` | Copado **Build** agent: risks the rules may miss | opinion, capped at medium |
| Release review | `agentia ai agent ask --agent release …` | Copado **Release** agent: promotion order and back-promotion risks | opinion |
| Test selection | `agentia ai agent ask --agent test …` | Copado **Test** agent: smallest test set for the blast radius | added to "Tests to run" |
| Delivery (per story, per wave) | `agentia cicd work set <story> --json` | Select the story, check out its branch | needs human approval |
| | `agentia cicd work environment-sync` | Back-promotion: pull earlier waves into this branch | only for stories that build on earlier ones or are behind |
| | `agentia cicd work test --json` | Local quality gates | `--no-gates` to skip |
| | `agentia cicd work publish --json` | Register the Copado commit | only with `--publish` |
| | `agentia cicd work deployment-step create --type "Manual Task" --sequence after --no-run-on-validation --skip-back-promotion …` | Puts the approval, plan hash and findings on the Copado story | only with `--evidence` |
| | `agentia cicd work submit --json` | Copado validation | `--live` |
| | `agentia cicd work submit --deploy --json` | Deploy to the next environment | `--live --deploy` + approval given with `--allow-deploy` |
| | `agentia cicd work status <story> --json` | Record the job state | — |
| Failure | `agentia ai agent ask --agent operate …` | Copado **Operate** agent: root cause + fix for the failed step | chain stops; later stories marked NOT-RUN |
| Conflicts | `agentia cicd promotion conflict list --promotion <id> --json` | Read conflicts | read-only |
| | `agentia cicd promotion conflict resolve <attachmentId> --promotion <id> --mode auto --json` | Only for files the forecast proved node-disjoint | `--apply` + approved run |
| | (printed, not run) `agentia cicd promotion run <id> --resume <job> --json` | Resume the original run, as Copado's docs require | human |
| Coding agents | `agentia mcp start` next to `fleet mcp` | Claude Code / Cursor get both tool sets | fleet MCP has no approve/deploy tool |

## Safety rules built into the adapters

- **One flow per story.** Only the local flow (`work set` → `submit`) is used. Copado's docs say local and cloud flows must not be mixed for one story.
- **No automatic retries for anything that writes.** A retried submit could deploy twice.
- **A mock never replaces a real Agentia call that failed.** It would hide the failure.
- **Responses are read defensively.** Response shapes aren't published, so the fleet stores raw JSON and only extracts what it needs: story names, `attachmentId`, `type`/`name`, and statuses containing "missing".
