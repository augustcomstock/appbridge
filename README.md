# AppBridge

A local macOS proof of concept: pick two installed apps, let an AI agent investigate both (conventional
interfaces plus reverse engineering with [REA](https://github.com/morluto/rea) and Ghidra), and have it build,
test and save a reusable adapter that moves data between them.

## Run

```bash
npm install
npm start        # http://localhost:4317
npm test         # engine tests (sandbox, runner contract, candidate validation)
```

Requirements: Node 22+, the `rea` CLI (`npm i -g rea-agents`), Ghidra 12.1.x with a JDK 21, and Claude Code
signed in (`claude auth login`). Ghidra is looked up via `GHIDRA_INSTALL_DIR` or `~/.appbridge/tools/ghidra_*`;
Java via `JAVA_HOME` or Homebrew's `openjdk@21`. On Apple Silicon, build Ghidra's native decompiler once with
`support/gradle/gradlew buildNatives`.

## Architecture

| Part | Where | Role |
|---|---|---|
| Engine | `src/engine/` | App enumeration, integration library, sandboxed adapter runner. No UI or model dependency. |
| Agent | `src/engine/agent.mjs`, `prompts.mjs` | Headless Claude Code with REA attached over MCP. Only used to discover and build. |
| Server | `src/server.mjs` | Localhost-only HTTP + server-sent events between UI and engine. |
| UI | `public/` | The AppBridge design, driven by real engine state. |

Why this architecture rather than a Claude Desktop extension: an MCP App inside Claude Desktop can only ask the
chat to act, so the chat itself would have to be the coding agent using nothing but MCP tools. Claude Code is
already a tool-calling coding runtime that speaks MCP to REA, needs no API key, and can be driven and tested
headlessly. The engine does not know about either, so it can be wrapped as an MCP server later.

## How an integration is made

1. **Discover.** The agent investigates both apps read-only: scripting dictionaries, URL schemes, local stores,
   then REA/Ghidra. It appends candidates to `discovery.jsonl`; the UI shows them as they arrive.
2. **Build.** For each selected candidate the agent writes `adapter.mjs` (exports `plan`, `apply`, `verify`),
   tests with synthetic fixtures, a read-only dry run, and `integration.json`.
3. **Preview.** `plan()` runs and the UI shows create / update / skip / delete counts. Nothing has changed yet.
4. **Run.** After approval, exactly the previewed items are applied. Deletes need a separate confirmation.
5. **Verify.** `verify()` re-reads the destination independently, and the run is logged.

Saved adapters are plain executable files. Re-running one involves no model call.

## Safety

- Adapters run under `sandbox-exec`: no network, and file writes only under the paths the integration declares
  (`resources.write`). `plan` and `verify` get no declared write paths at all.
- The agent's shell runs inside Claude Code's OS sandbox and is told to investigate structure, not content.
- Default targets are dedicated test containers (`~/AppBridge Test`, lists named "AppBridge Test").
- Password managers and credential stores are not listed.
- An integration is labelled "REA / Ghidra" only if REA tools actually ran for that pair; otherwise the label
  is downgraded to "Local" regardless of what the agent claimed.

## Data

Everything lives in `~/.appbridge/`:

```
library/<bundleA>__<bundleB>/
  notes.md                 findings shared across sessions
  discovery.jsonl          candidates from the latest discovery
  runs.jsonl               execution history
  agent-logs/              full agent transcripts (every tool call)
  <integration-id>/
    integration.json       identity, versions, directions, config, resources, validation, evidence, last run
    adapter.mjs            the reusable adapter
    adapter.test.mjs       its tests
    state.json             source-to-destination mapping used to prevent duplicates
```

Not built (by design, for now): scheduling, sync, cloud accounts, the Phase 2 "repair integration" flow.
