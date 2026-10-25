# agentia-plugin-fleet

Adds `agentia fleet check` to the Agentia CLI: simulate the story you are working on together with the other in-flight Copado stories, before you submit.

```bash
# 1. the fleet CLI must be on PATH
cd ../ && npm link

# 2. build and link the plugin
cd agentia-plugin
npm install
npm run build
agentia plugins link .

# 3. use it
agentia cicd work set US-0000104
agentia fleet check --base origin/main          # add --ai to ask the Copado AI agents
```

## Status: written against the documented SDK, not yet built

The build environment used to write this plugin could not install `@copado/agentia-plugin-sdk`. The code uses only what Copado's docs show (`AgentiaCommand`, `getAgentiaHost`, `host.work.getWorkItem()`, `host.format.table()`, `this.display()`), but it has not been compiled against the real SDK.

Two assumptions to check on first build:

1. **Starting another program.** The `agentia.permissions.commands: ["fleet"]` entry assumes plugins declare the programs they run. If the CLI rejects this, run `fleet run --git . --stories <story> --from-copado` directly. Nothing else changes.
2. **Story field name.** The plugin reads `name` (or `Name`) from `getWorkItem()`. Adjust it if the SDK returns another field.

## Why a thin plugin

Copado's docs list what plugins cannot do yet: call Copado endpoints, receive credentials, wrap existing commands, or register MCP tools. So the simulation runs in the `fleet` CLI, which reaches Copado only through the Agentia CLI. The plugin puts it where Agentia users already work.
