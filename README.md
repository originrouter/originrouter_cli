# originrouter-cli

Open-source local CLI and connector for OriginRouter Agent Control.

This project is the local daemon and CLI for OriginRouter Agent Control.

Current implementation:

- daemon
- session manager
- relay client
- pipe executor
- pty executor interface
- tmux executor interface
- terminal / claude / codex adapters

The structure is intentionally inspired by Happy's CLI architecture, but this code is a clean implementation for OriginRouter.

## Commands

```bash
# Stage 7.7: provider / profile management (catalog fidelity)
# --type is optional; defaults to litellm. Every flag below corresponds to a
# field in the catalog profile selected by --litellm-provider. Unknown flags
# are rejected at save time (the catalog is the source of truth).
originrouter provider add <name> [--type litellm] --litellm-provider <id> [--base-url <u>] [--api-key <k>] [--auth-token <k>] [--organization <o>] [--model <m>] [--small-fast-model <m>] [--api-version <v>] [--aws-region <r>] [--aws-access-key-id <id>] [--aws-secret-access-key <k>] [--aws-session-token <t>] [--aws-profile-name <p>] [--aws-bedrock-runtime-endpoint <u>] [--aws-role-name <r>] [--aws-session-name <n>] [--aws-web-identity-token <t>] [--aws-sts-endpoint <u>] [--sagemaker-base-url <u>] [--vertex-project <id>] [--vertex-location <loc>] [--vertex-credentials <json>] [--google-application-credentials <path>] [--azure-ad-token <t>] [--hf-token <t>]
originrouter provider update <name> [same flags as add]

# Secrets can be literal values OR env references. Env references are
# `os.environ/VAR_NAME` strings; LiteLLM is given the literal at render time
# and reads the env var on its own. The shell variable name is stored
# verbatim — nothing is substituted by OriginRouter.
#
# Examples:
#   --api-key os.environ/DEEPSEEK_API_KEY
#   --aws-region os.environ/AWS_REGION_NAME
#   --aws-web-identity-token os.environ/AWS_WEB_IDENTITY_TOKEN_FILE
originrouter provider list
originrouter provider show <name>
originrouter provider use <name> [--agent claude|codex] [--force]
originrouter provider remove <name>
originrouter env print [--provider <name>] [--agent claude|codex]
originrouter doctor provider <name>

# Legacy config commands (deprecated, prefer 'originrouter provider add'):
originrouter config show
originrouter config set claude.<key> <value>
originrouter config unset claude.<key>
originrouter claude-config --base-url <url> --api-key <key> --model <model> --small-fast-model <model>

# Runtime
originrouter status
originrouter doctor
originrouter sessions [--json]
originrouter daemon
originrouter run -- <command> [args...]
originrouter claude [args...]
originrouter claude-sdk [args...]
originrouter codex [args...]
```

Examples:

```bash
npm run originrouter -- provider add minimax \
  --type anthropic \
  --base-url https://api.easytransnote.com/coding \
  --api-key sk-v1-xxxxxx \
  --model MiniMax-M3 \
  --small-fast-model MiniMax-M2.7
npm run originrouter -- provider use minimax
npm run originrouter -- env print
npm run originrouter -- claude                       # uses current provider
npm run originrouter -- claude --provider deepseek   # transient override
npm run originrouter -- doctor provider minimax
npm run originrouter -- status
npm run originrouter -- daemon
npm run originrouter -- run -- node -e "console.log('hello')"
npm run originrouter -- claude --resume
npm run originrouter -- claude-sdk --model MiniMax-M3
npm run originrouter -- codex --model gpt-5-codex
```

## Claude provider config

Users who normally start Claude Code with these shell exports:

```bash
export ANTHROPIC_BASE_URL=https://api.easytransnote.com/coding
export ANTHROPIC_API_KEY=sk-v1-xxxxxx
export ANTHROPIC_MODEL=MiniMax-M3
export ANTHROPIC_SMALL_FAST_MODEL=MiniMax-M2.7
```

can save them once:

```bash
originrouter claude-config \
  --base-url https://api.easytransnote.com/coding \
  --api-key sk-v1-xxxxxx \
  --model MiniMax-M3 \
  --small-fast-model MiniMax-M2.7
```

Then start Claude through the wrapper:

```bash
originrouter claude
```

The values are stored locally in `~/.originrouter/config.json` and injected into the local Claude Code process. API keys are masked in CLI output and are not sent to the relay metadata.

## Providers and profiles

Stage 1 introduces named provider profiles that can be switched per-session or set as the default per agent. The legacy single Claude block is still supported (and auto-migrates to a `default-claude` provider on first read).

```bash
# Save a profile
# Stage 7.8: --small-fast-model is [legacy]. The fast route is owned by
# the routes layer — use `originrouter route set claude.small --provider <name>`
# or the provider detail's "Set as Claude Fast route" button. The legacy
# flag is still accepted; the field round-trips on disk and prints a
# one-line note pointing at the routes layer.
originrouter provider add minimax \
  --type anthropic \
  --base-url https://api.easytransnote.com/coding \
  --api-key sk-v1-xxxxxx \
  --model MiniMax-M3

# Save an OpenAI-compatible endpoint for future LiteLLM use (Stage 4)
originrouter provider add deepseek \
  --type openai-compatible \
  --base-url https://api.deepseek.com/v1 \
  --api-key sk-xxxxxx \
  --model deepseek-chat

# Make minimax the default Claude provider
originrouter provider use minimax

# Show what Claude will see (apiKey is masked)
originrouter env print
# Resolved provider:
#   name:   minimax
#   type:   anthropic
#   source: current (currentProvider.claude)
#
# Effective env (what claude will see):
#   ANTHROPIC_BASE_URL=https://api.easytransnote.com/coding
#   ANTHROPIC_API_KEY=sk-v...xx
#   ANTHROPIC_MODEL=MiniMax-M3
#   ANTHROPIC_SMALL_FAST_MODEL=MiniMax-M2.7
#
# System env (overridden by providerEnv when both present):
#   ANTHROPIC_BASE_URL  ...overridden by provider (system value was ...)
#   ...

# Launch Claude with the resolved provider
originrouter claude

# Override the default for a single session (no config change)
originrouter claude --provider deepseek
#   Stage 1: openai-compatible providers cannot route Claude directly.
#   The launcher will refuse to start with PROVIDER_UNSUPPORTED.

# Validate a stored profile
originrouter doctor provider minimax
# Doctor provider 'minimax':
#   ok: true
```

Provider resolution priority (any of these alone is enough to drive `originrouter claude`):

1. `--provider <name>` flag — transient, does not write to config.
2. `currentProvider.claude` set by `provider use <name>`.
3. Legacy `config.claude` block — preserved for backward compatibility; auto-migrated to `providers.default-claude` on first Stage-1 read.
4. Inherited system env (`process.env.ANTHROPIC_*`) — only when nothing above matched.

Two rules to remember:

- If the resolved provider is `openai-compatible` for agent `claude`, the launcher refuses to start. Install LiteLLM (Stage 4) to route through an OpenAI-compatible endpoint. `env print --provider <openai-compatible name>` shows the situation without erroring.
- The legacy `config set claude.<k>` and `claude-config` commands still work but write to a deprecated block that is no longer the source of truth once any named provider exists.

## LiteLLM proxy (Stage 4)

Once a `provider use <name> --agent claude` points at an `openai-compatible` profile, Claude Code can only reach it through a local LiteLLM proxy. OriginRouter owns the proxy lifecycle so the venv, config, and process are all managed in `~/.originrouter/`.

Prerequisite: Python 3.10+ on `PATH`. Stage 4 does not auto-install Python.

```bash
# 1. Install LiteLLM into a venv under ~/.originrouter/runtimes/litellm/<v>/
originrouter proxy install
# [proxy] python Python 3.10.10 detected at /Users/.../python3
# [proxy] creating venv at .../runtimes/litellm/1.83.0/venv ...
# [proxy] installing litellm[proxy]==1.83.0 ...
# [proxy] installed. python=.../venv/bin/python

# 2. Add an openai-compatible provider (any DeepSeek/OpenAI-style endpoint works)
originrouter provider add deepseek \
  --type openai-compatible \
  --base-url https://api.deepseek.com/v1 \
  --api-key sk-ds-xxx \
  --model deepseek-chat

# 3. Start the proxy bound to a free port on 127.0.0.1
originrouter proxy start --provider deepseek --port 40123
# [proxy] started. port=40123, pid=54321, provider=deepseek

# 4. Make it the current Claude provider and launch Claude Code
originrouter provider use deepseek --agent claude
originrouter claude
# Previously: PROVIDER_UNSUPPORTED
# Now: ANTHROPIC_BASE_URL=http://127.0.0.1:40123, ANTHROPIC_API_KEY=sk-noop-litellm-passthrough
#       Claude Code starts, LiteLLM translates Anthropic-format requests to OpenAI format,
#       forwards to DeepSeek with the real key from the proxy config.

# 5. Stop the proxy
originrouter proxy stop
```

The proxy status is also visible from the local API and the local-console.html UI:

```bash
originrouter proxy status
# running. port=40123, pid=54321, provider=deepseek, version=1.83.0.
```

Notes:
- One proxy process at a time. Starting a new one requires an explicit `proxy stop` first.
- The proxy binds 127.0.0.1 only; no LAN exposure.
- The user's real DeepSeek key lives in `~/.originrouter/proxy.state.d/config-deepseek.yaml` (mode 0600) and never enters the Claude Code process environment. Claude Code only sees the no-op `sk-noop-litellm-passthrough`.
- `originrouter proxy install` is a one-time 50–100MB download. Re-running it on an existing install prints "already installed" and exits 0.

## Local Console (Stage 5)

`originrouter daemon` starts a local-first HTTP API. It does not require
`originrouter login`: the daemon can run as a local service and expose provider,
route, proxy, and session controls to the desktop app. If the user later runs
`originrouter login`, the already-running daemon notices the new credentials on
its next relay retry and connects the account-authorized remote bridge.

By default the Local API binds `127.0.0.1` and first tries port `7437`; if that
port is already in use, it falls back to an OS-assigned port. The browser control
surface in `originrouter-test/local-console.html` discovers it via the
`?daemon=127.0.0.1:<port>` query param:

```bash
originrouter daemon
# [daemon] local API: http://127.0.0.1:7437
# Open: file:///path/to/originrouter-test/local-console.html?daemon=127.0.0.1:7437
```

`GET /local/status` reports both local daemon state and relay state. A healthy
local daemon can show `relay.connected=false` when the user is not logged in or
the remote bridge is temporarily unavailable.

To run the daemon as a user-level background service:

```bash
originrouter service install
originrouter service start
originrouter service status
```

`service start` and `service restart` wait until the Local API responds, so a
successful command prints the URL and is ready for immediate App / curl tests:

```bash
originrouter service restart
# OriginRouter service stopped. Autostart file remains installed.
# OriginRouter service started: http://127.0.0.1:7437

curl -fsS http://127.0.0.1:7437/local/status
# {"ok":true,"daemon":{"port":7437,...},"relay":{"connected":false},...}
```

The service manager is platform-specific behind one CLI:

- macOS: `launchd` LaunchAgent in `~/Library/LaunchAgents/com.originrouter.daemon.plist`
- Linux: `systemd --user` unit in `~/.config/systemd/user/originrouter.service`
- Windows: Task Scheduler task named `OriginRouterDaemon`

The service starts on user login and is configured to recover after crashes.
Use `originrouter service stop` to stop the current daemon while keeping
autostart installed, and `originrouter service uninstall` to remove autostart.
Logs are written to `~/.originrouter/logs/daemon.out.log` and
`~/.originrouter/logs/daemon.err.log`.

macOS local service smoke test used during development:

```bash
originrouter local config set --port 7437 --bind 127.0.0.1 --allow-lan off
originrouter service install
originrouter service start
originrouter service status
originrouter service restart
curl -fsS http://127.0.0.1:7437/local/status
tail -80 ~/.originrouter/logs/daemon.out.log
tail -80 ~/.originrouter/logs/daemon.err.log
```

Expected results:

- `service status` shows `state = running` on macOS and `Local API: http://127.0.0.1:7437`.
- `/local/status` returns `ok: true`, `daemon.port: 7437`, and `proxy.state`.
- `relay.connected` can be `false` when the CLI is not logged in or the server rejects the relay websocket; local control should still work.
- `daemon.err.log` may show relay retry errors such as `Unexpected server response: 403`; those are remote bridge/auth issues, not Local API failures.

The page adds / edits / removes providers, starts / stops / restarts the LiteLLM proxy, and shows live provider + proxy state. The "Usable for Claude" badge on each provider is derived from `provider.type` + the live proxy status: `anthropic` is always available; `openai-compatible` is only available when the proxy is running for that exact provider.

- **Routes tab (Stage 7.9 + Stage 8.2)** — full-screen editor for `originrouter-claude-model`, `originrouter-claude-fast-model`, and `originrouter-codex-model`. Pick a LiteLLM provider per slot and click Save. Codex has no fast route and does not fall back to Claude. The left Routes sidebar shows compact `claude main / claude small / codex main` rows (grouped under section labels) with one clear button per set slot.

Provider CRUD exists in the CLI local API, browser local console, and Flutter
App Local Control page. The App prefers direct local control at
`127.0.0.1:7437`, so provider inventory, LiteLLM proxy state, route state, and
Claude main provider assignment can work without signing in to the App. When
the user is signed in and the local daemon is unavailable, the App can fall back
to the account-authorized bridge for supported snapshot / route / restart
actions. Provider writes over the direct Local API require the local key shown
by `originrouter local key show`. The full wire shape is in
[`docs/agent-protocol.md` §7](docs/agent-protocol.md#7-daemon-local-api-stage-3).

When signed in, `originrouter daemon` also posts a display-safe Local Control
heartbeat to `/cli/v1/local-control/runtime` every 20 seconds and immediately
after the relay WebSocket opens. The heartbeat contains only daemon version,
uptime, proxy running state, and proxy base URL. It does not include provider
records or upstream API keys. The App bridge snapshot treats this heartbeat as
the remote online signal; stale heartbeats are shown as offline even if an old
device grant still exists.

## Local API authentication (Stage 6)

The default local HTTP API is bound to `127.0.0.1`; loopback requests from the same machine do not require a bearer token. If you enable LAN control with a non-loopback bind address, write endpoints — provider CRUD, proxy start/stop/restart, session input/permission/interrupt — require `Authorization: Bearer <local-api.token>`. The token is auto-generated on first daemon start and stored in `~/.originrouter/local-api.token` (mode 0o600).

```bash
# Mint or rotate the token (also prints the new browser URL).
originrouter token rotate

# Print the current URL without rotating.
originrouter token show

# Print the running daemon's local API URL alone.
originrouter daemon-port
```

The browser console (`local-console.html`) reads the token from the `?daemon=127.0.0.1:<port>&token=<token>` URL query param on first visit, then stores it in `localStorage` so subsequent visits don't need the query param. If you rotate the token, re-open the URL the daemon prints and click "Save token" in the topbar.

**In LAN mode, the token grants write access to the local API; anyone who can read it can mutate your providers and the proxy.** Don't share screens with `?token=` visible. The full wire shape, the `WWW-Authenticate` header contract, and the Flutter discovery recipe are in [`docs/agent-protocol.md` §7.1 and §7.2](docs/agent-protocol.md#7-daemon-local-api-stage-3).

### LAN control mode

Direct LAN control is an advanced mode and is off by default. To expose the local API beyond loopback, the daemon must be started with both a non-loopback bind address and `--allow-lan`:

```bash
originrouter daemon --bind 0.0.0.0 --allow-lan --local-port 7437
originrouter local key show
```

All non-loopback write endpoints still require `Authorization: Bearer <local-api.token>`. The account-authorized bridge/relay path remains the recommended production path for mobile and cross-network control.

Persist the local API bind/port defaults with:

```bash
originrouter local config set --port 7437 --bind 127.0.0.1 --allow-lan off
originrouter local config show
```

These settings live in `~/.originrouter/local-api.json`. The access key lives separately in `~/.originrouter/local-api.token` and can be shown or rotated with `originrouter local key show|rotate`. The live daemon writes its actual bound address and port to `~/.originrouter/daemon.state.json`.

## LiteLLM provider catalog (Stage 7)

Stage 7 expands the provider model from a binary (`anthropic | openai-compatible`) to a typed LiteLLM-backed catalog of 34 adapters. The browser console (`local-console.html`) reads the catalog from `GET /catalog/litellm-providers` and renders a dynamic form that swaps fields based on the chosen `litellmProvider`.

Core routing rule: `type=anthropic` is the direct path (injects `ANTHROPIC_*` env vars into Claude Code). `type=litellm` is the LiteLLM path. `type=openai-compatible` is a legacy alias that read-projects to `litellm/custom_openai` and auto-migrates on the next save.

```bash
# Vertex AI
originrouter provider add vertex --type litellm --litellm-provider vertex_ai \
  --vertex-project my-proj --vertex-location us-central1 --model gemini-1.5-pro

# AWS Bedrock with inline credentials
originrouter provider add bedrock-anthropic --type litellm --litellm-provider bedrock \
  --aws-region us-east-1 --aws-access-key-id AKIA... --aws-secret-access-key ... \
  --model anthropic.claude-3-5-sonnet-20241022-v2:0

# Bedrock WITHOUT inline credentials (uses env / profile / SSO / instance role)
originrouter provider add bedrock-env --type litellm --litellm-provider bedrock \
  --aws-region us-east-1 --model anthropic.claude-3-5-sonnet-20241022-v2:0

# HuggingFace
originrouter provider add hf --type litellm --litellm-provider huggingface \
  --hf-token hf_xxx --model meta-llama/Meta-Llama-3-8B-Instruct

# Z.AI / GLM
originrouter provider add glm --type litellm --litellm-provider zai \
  --api-key zai-xxx --model glm-4.5

# Ollama local
originrouter provider add local-llama --type litellm --litellm-provider ollama \
  --base-url http://localhost:11434 --model llama2
```

The full 34-entry catalog (grouped by OpenAI-family / Cloud managed / Single-key APIs / Local servers / Chinese vendors / GitHub / Aliases) is documented in [`docs/agent-protocol.md` §9](docs/agent-protocol.md#9-provider-catalog-stage-7).

## Model routes (Stage 7.5 + 7.6 + 8.0)

Stage 7.5 introduced a stable **Route** layer between Claude Code and the provider. Stage 7.6 collapses the entire provider system to a single path: every Claude Code session goes through the local LiteLLM proxy and two fixed alias names that never change: `originrouter-claude-model` (main) and `originrouter-claude-fast-model` (small). The user changes what those aliases point to via `originrouter route set`; the daemon rebuilds the LiteLLM proxy YAML and restarts the proxy automatically.

Stage 8.0 brings **Codex** into the same routes contract with a third alias: `originrouter-codex-model`. Codex 8.0 has only one slot (main); `codex.small` is a hard error. Codex and Claude routes do not share, do not fallback into each other, and do not inherit each other's slots. The proxy YAML renders whichever aliases are configured.

Mental model:

```
Provider = inventory      (e.g. deepseek, moonshot, anthropic-via-3p, vertex_ai, ...)
Route    = current choice (e.g. claude.main -> deepseek, claude.fast -> moonshot, codex.main -> openai_codex)
Proxy    = executor       (LiteLLM, mode=route, reads routes.{claude,codex})
Daemon   = control plane  (HTTP API + lifecycle owner)
```

Canonical flow (Stage 7.6 + 7.8 + 8.0 — single path; fast route owned by the routes layer; Codex rides the same routes contract):

```bash
# Inventory: every provider is type=litellm. --type is optional.
# Stage 7.8: do NOT pass --small-fast-model on add. The fast route is
# owned by the routes layer; set it via `route set claude.small`, the
# provider detail's "Set as Claude Fast route" button, or the new Routes
# tab in the local console.
originrouter provider add default-claude \
  --litellm-provider anthropic \
  --base-url https://api.easytransnote.com/coding \
  --api-key sk-xxx \
  --model MiniMax-M3
originrouter provider add deepseek \
  --litellm-provider deepseek \
  --api-key sk-ds \
  --model deepseek-chat

# Routes — provider use writes ONLY routes.claude.main
originrouter provider use default-claude --agent claude
# Claude main route updated:
#   model originrouter-claude-model      -> default-claude / MiniMax-M3
#   fast  (unset; the fast alias will fall back to main)
# To set fast route: `originrouter route set claude.small --provider default-claude`

# Set fast route explicitly — proxy auto-restarts
originrouter route set claude.small --provider deepseek --model deepseek-mini

# Switch models — proxy auto-restarts
originrouter route set claude.main --provider deepseek --model deepseek-v4-flash

# Proxy in routes mode (default)
originrouter proxy start --port 40123
# [proxy] started. port=40123, pid=..., mode=route

# Verify env
originrouter env print --agent claude
# Claude routes:
#   model originrouter-claude-model      -> deepseek / deepseek-v4-flash
#   fast  originrouter-claude-fast-model -> deepseek / deepseek-mini
# Effective env (what claude will see):
#   ANTHROPIC_BASE_URL=http://127.0.0.1:40123
#   ANTHROPIC_API_KEY=sk-noop-litellm-passthrough
#   ANTHROPIC_MODEL=originrouter-claude-model
#   ANTHROPIC_SMALL_FAST_MODEL=originrouter-claude-fast-model

originrouter claude
```

Rules:

- **All providers are `type=litellm`**. The legacy `type=anthropic` and `type=openai-compatible` are no longer accepted on add. Existing records auto-migrate to the new shape on next PUT or `provider use`.
- Alias names are fixed: `originrouter-claude-model` and `originrouter-claude-fast-model`. They are not stored in config and not user-editable.
- Routes can only point at `type=litellm` providers. `provider use` is the recommended way to wire a provider to the main route; the old "type=anthropic direct path" is gone for Claude.
- `proxy start` without `--provider` requires `routes.claude.main`; otherwise it errors with a clear "run route set first" hint.
- The legacy `proxy start --provider <name> --port <p>` is **debug-only**. `originrouter claude` and `env print --agent claude` only accept route mode.
- `proxy restart` and `proxy switch` default to routes mode. They reuse the running port when the proxy is already running; if stopped, they require an explicit `--port`.
- PUT on `/routes/claude` (or `route set` on the CLI) **only auto-restarts the proxy when the proxy is currently running** in route mode. If the proxy is stopped, the route is persisted and you start the proxy explicitly.
- **Stage 7.8: `provider use --agent claude` writes ONLY `routes.claude.main`**. `routes.claude.small` is independent state owned by the routes layer; the CLI prints a hint pointing at `originrouter route set claude.small --provider <name>`. The legacy `--small-fast-model` flag is still accepted on `provider add` for backward compatibility but no longer seeds `routes.claude.small`. The field is shown in `provider show` with a `(legacy; routes.claude.small is source of truth)` annotation.
- **Stage 8.0: Codex routes are independent of Claude routes.** `routes.codex.main` is the sole Codex entry point (alias `originrouter-codex-model`). `codex.small` is a hard error — Codex 8.0 has no small/fast slot. Codex never falls back to Claude. `provider use --agent codex` writes `routes.codex.main` (it no longer writes `currentProvider.codex`). The `CodexAdapter` injects `--model originrouter-codex-model` unless the user passed `--model` / `-m` in any form (`--model X`, `--model=X`, `-m X`, `-m=X`), in which case it warns and passes args through. `originrouter codex` errors with `Codex requires routes.codex.main` if the route is unset.
- `provider remove <name>` (CLI) and `DELETE /providers/:name` (API) clear any `routes.claude.{main,small}` AND `routes.codex.main` entries that point at the removed provider. The API path auto-restarts the proxy if it is running in route mode; the CLI path does not (matches `route set` / `route clear`).
- Claude Code **never** sees anything other than the two fixed alias names. `currentProvider.claude` and `--provider` flags are advisory only; the env comes from routes + the route-mode proxy. Codex sees `OPENAI_BASE_URL=http://127.0.0.1:<port>/v1`, `OPENAI_API_KEY=sk-noop-litellm-passthrough`, `OPENAI_MODEL=originrouter-codex-model` (Stage 8.0).

**Verification (Stage 8.3):** the Codex route → config → proxy → env chain is exercised end-to-end by `npm test` (offline, no daemon, no LiteLLM) and by the manual A–G checklist in [`docs/codex-e2e-verification.md`](docs/codex-e2e-verification.md). The shortest path:

```bash
originrouter provider add openai_codex \
  --type litellm --litellm-provider openai \
  --api-key sk-test --model gpt-5-codex

originrouter route set codex.main \
  --provider openai_codex --model gpt-5-codex

originrouter proxy start --port 40123    # verification port
originrouter env print --agent codex
```

> `env print` proves env injection only; it does NOT prove the `--model` CLI argument. The offline test suite covers both. The LiteLLM log is the only ground truth for the network path.

**Stage 8.4 — Codex process lifecycle hardening:** the Codex app-server child is now guarded by `processEpoch` (stale callbacks from a previous child are ignored), and `disconnect()` is idempotent with a 2-second SIGTERM → SIGKILL escalation. `codex.app_server.exit` maps to a structured `agent.adapter.status` event. Session-start events carry a top-level `runtime` field that reads `"codex-app-server"` when the structured app-server path is active, `null` otherwise. The full lifecycle contract is in [`docs/agent-protocol.md` §10.10](docs/agent-protocol.md). 11 new lifecycle cases in `tests/codexAppServerClient.test.js` lock the contract.

**Stage 8.5 — Hook forwarder reliability:** the Claude hook forwarder at `scripts/claude-session-hook-forwarder.cjs` now retries transient local-hook-server failures with bounded backoff (3 attempts, 50ms + 150ms delays) and an event-conditional per-attempt socket timeout (5s for `SessionStart`, 58s for `PermissionRequest` to cover the 55s server hold-open). On retry exhaustion or fatal 4xx, the forwarder writes a structured JSON diagnostic to stderr; the user-visible behavior is otherwise unchanged. Full contract in [`docs/agent-protocol.md` §10.11](docs/agent-protocol.md). 10 cases in `tests/hookForwarder.test.js`.

**Stage 8.6 — Runtime cleanup:** spawn defaults cleanup. Two production call sites (`src/executors/pipeExecutor.js`, `src/adapters/codex/appServerClient.js`) now share `src/utils/spawn.js` (`spawnCommand` + `buildSpawnOptions` + `SPAWN_DEFAULTS = { shell: false, windowsHide: true }`). On macOS/Linux the helper is a behavior no-op (`windowsHide` is Windows-only); the value is centralizing defaults so future sites inherit them. **Stage 8.6 is not a `cross-spawn` migration** — Windows `.cmd`/`.ps1` shim safety remains deferred to platform hardening. Four regression tests in `tests/codexAppServerClient.test.js` (cases 31–34) lock the Codex app-server env contract: `RUST_LOG` default applied, user `RUST_LOG` wins, `CODEX_SANDBOX` not injected by default, user `CODEX_SANDBOX` preserved. Verification:
```bash
node ./tests/codexAppServerClient.test.js   # 34 cases green
node ./tests/spawnCommand.test.js           # 5 cases green
npm test                                   # 19 suites + 2 binary smokes
```
Full contract in [`docs/agent-protocol.md` §10.12](docs/agent-protocol.md).

**Stage 8.7 — Claude runtime event normalization plan:** documents and tests the target `agent.*` event contract for Claude PTY and SDK runtimes. **No production session-runner refactor yet.** Stage 8.7 contracts the current event names (`agent.text`, `agent.task.completed`) and locks the future target shapes; rename proposals (`agent.message`, `agent.task.complete`) are documented but **deferred**. The contract helper (`src/runtime/claudeEventContract.js`) is a pure module — production code does not import it. The 11-case test suite (`tests/claudeEventContract.test.js`) locks the contract: top-level `runtime`, `metadata.runtime` mirror, `provider: "claude"` forced on every `agent.*` event, explicit `runtime` override preserved, non-agent events untouched. Full contract in [`docs/agent-protocol.md` §10.13](docs/agent-protocol.md). Verification:
```bash
node ./tests/claudeEventContract.test.js    # 11 cases green
npm test                                   # 20 suites + 2 binary smokes
```

**Stage 8.8 — Interactive blocking-prompt contract:** generalizes `agent.permission.*` into an `agent.interaction.*` envelope with kinds `permission | confirm | single_select | multi_select | free_text | raw_terminal` and sources `hook | jsonl | app-server | pty`. The contract helper (`src/runtime/agentInteractionContract.js`) is a pure module. Stage 8.8 ships the contract only; **runtime wiring landed in Stage 8.9** (production now imports the helper, see below). The 10-case test suite (`tests/agentInteractionContract.test.js`) locks the wire shape: forward map (permission → interaction, new `eventType`), reverse map (permission-only, legacy `eventType`), and `buildInteractionResolved` validation (with optional `value` / `data` passthrough). No UI work; no provider/auth/login (those are Stage 9.0). Full contract in [`docs/agent-protocol.md` §10.14](docs/agent-protocol.md) and [`docs/agent-interaction-contract.md`](docs/agent-interaction-contract.md). Verification:
```bash
node ./tests/agentInteractionContract.test.js    # 10 cases green
npm test                                        # 21 suites + 2 binary smokes
```

**Stage 8.9 — Runtime interaction wiring + temporary console:** promotes the 8.8 helper to production. `claudeAdapter.js` and `codexAdapter.js` dual-emit `agent.permission.request.detected` AND `agent.interaction.requested` for every permission request. `localAgentSession.js#handleRemoteEvent` accepts `agent.interaction.resolve` and routes it to the existing permission resolver. `localApi.js` exposes `POST /sessions/:id/interaction`. The local session emits one `agent.mode.status` per `session.started` (read-only; `modeControl: "unsupported"`; Claude modes `default | acceptEdits | bypassPermissions | plan`, Codex modes `default | read-only | safe-yolo | yolo`). The temporary console (`originrouter-test/local-console.html`, outside the CLI repo) renders the new envelope, deduplicates against the legacy event, and shows a `Mode:` pill. `agent.permission.*` events remain emitted and consumed unchanged. Stage 8.9 does NOT remove the legacy event, does NOT wire remote mode switching, does NOT emit non-permission kinds from production adapters, and does NOT change the relay protocol. The 8-case test suite (`tests/agentInteractionRuntime.test.js`) locks the dual-emit, resolve routing, unknown-id error, raw fallback, and `agent.mode.status` emission. Full contract in [`docs/agent-interaction-contract.md` §11](docs/agent-interaction-contract.md) and [`docs/agent-protocol.md` §10.14.4](docs/agent-protocol.md). Verification:
```bash
node ./tests/agentInteractionRuntime.test.js    # 8 cases green
npm test                                        # 22 suites + 2 binary smokes
```

**Stage 9.0 — App / Provider / Login Credential Architecture:** locks the canonical provider types (`originrouter | proxy | remote`). The legacy `litellm` CLI string is accepted as an input alias and persisted as `proxy(engine=litellm)`. `openai-compatible` is rejected on write. `src/config/providerRoutes.js` is the pure route resolver; originrouter endpoints always include `/coding/...`, proxy uses bare `/v1/...`. The login credential architecture is contracted: `uuid` is NOT a long-term /coding key; the CLI / App hold a `ManagedCodingKey` (30-day default, device-bound, `scope: "coding"`, `source: originrouter_cli|originrouter_app`); the CLI stores it in `<stateDir>/coding-key.json` (mode 0o600). The login-code / device-grant exchange and rotation are 9.1+; 9.0 ships storage + shape helpers + tests + endpoint contract doc. New CLI flags: `--key-ref`, `--engine`, `--device-id`, `--grant-ref`, `--target`. Routes are no longer proxy-only: a route entry can point at originrouter / proxy / remote. The temporary console is **out of scope** for 9.0. Verification:
```bash
node ./tests/providerConfigNormalization.test.js    # 13 cases green
node ./tests/providerRouteResolution.test.js       # 14 cases green
node ./tests/codingAuthStorage.test.js             # 10 cases green
npm test                                           # 25 suites + 2 binary smokes
```

**Stage 9.1A — OriginRouter Login + Device Grant + Managed Coding Key:** turns the 9.0 contract into a real CLI + Backend flow. Five new CLI commands: `originrouter login [--manual-code <code>]` (the required 9.1A completion path; the browser callback is experimental pending Universal_PDF_H5 in 9.1A.1), `logout`, `auth status`, `auth rotate`, `auth device list` (current_device_only). Backend registers the 5 endpoints under `/originrouter/cli/auth/...` — `POST /login-code` (browser uuid auth), `POST /device/exchange` (atomic single transaction), `POST /device/rotate-coding-key`, `POST /device/revoke` (idempotent; returns `already_revoked`), `GET /devices` (returns only the calling device). SQL migration at `ai/server/sql/originrouter_auth.sql` creates three tables (`originrouter_device_grants`, `originrouter_login_codes`, `api_model_key_metadata` — the side-table intentionally has no FK onto `api_model_keys.id`). New modules: `src/auth/originrouterAuthClient.js` (Node 18+ fetch helpers; `requestBrowserLoginCodeForTesting` is exported only for tests), `src/auth/originrouterLogin.js` (callback server + manual-code path + cross-platform `openBrowser` with no `shell: true` on darwin/linux). `isManagedKeyShape` now requires `deviceGrant` + `deviceId`; accepts optional idle/absolute expiries. No new npm / pip deps. Verification:
```bash
# CLI
npm test                                           # 28 suites + 2 binary smokes
node ./tests/originrouterAuthClient.test.js        # ~8 cases green
node ./tests/originrouterLogin.test.js             # ~9 cases green
node ./tests/cliLogin.test.js                      # ~9 cases green
# Backend
python3 originrouter_auth_contract_test.py          # 10 cases green (Stage 9.0)
python3 originrouter_auth_store_test.py            # 9.1A store helpers
python3 originrouter_auth_route_test.py            # 9.1A Flask test_client route tests
```

**Stage 9.1B — Runtime Claude/Codex → OriginRouter /coding direct:** the file written by `originrouter login` is now read by `originrouter claude` / `originrouter codex` at runtime. Routes of `type=originrouter` return direct env (`ANTHROPIC_BASE_URL=<base>/coding`, `OPENAI_BASE_URL=<base>/coding/v1`) with the managed coding key injected — no local LiteLLM proxy required. `originrouter env print --agent <claude|codex>` prints `Source: originrouter-coding` on success and an agent-aware `Effective env (what <agent> will see):` header. The Codex branch now lists `OPENAI_*` env vars (previously Claude-only); `OPENAI_API_KEY` is masked. `readManagedCodingKeyForRuntime` rejects malformed `coding-key.json` (missing `deviceGrant`, missing `scopes`, wrong `source`) with a `PROVIDER_UNSUPPORTED` error pointing to `originrouter login --manual-code`. `auth.keyRef` is a local managed-coding-key reference, not a fixed key id — after `originrouter auth rotate`, the new key id differs but the runtime always reads the current `<stateDir>/coding-key.json`. Working example:

```bash
export ORIGINROUTER_HOME="$(mktemp -d)"
originrouter login --manual-code <code> --api-base-url <api>
originrouter provider add official --type originrouter --key-ref current --model claude-sonnet-4-6
originrouter route set claude.main --provider official
originrouter env print --agent claude
# Source: originrouter-coding
# ANTHROPIC_BASE_URL=https://server.easytransnote.com/coding
# ANTHROPIC_API_KEY=sk-o...ey
# ANTHROPIC_MODEL=claude-sonnet-4-6
# ANTHROPIC_SMALL_FAST_MODEL=claude-sonnet-4-6

originrouter route set codex.main --provider official-codex --model gpt-5-codex
originrouter env print --agent codex
# Source: originrouter-coding
# OPENAI_BASE_URL=https://server.easytransnote.com/coding/v1
# OPENAI_API_KEY=sk-o...ey
# OPENAI_MODEL=gpt-5-codex

cd originrouter-cli && npm test   # expect 29 suites + 2 binary smokes
```

The proxy branch (`type=proxy`) is unchanged; the 28-suite regression surface stays green. Remote provider (`type=remote`) is still future. No edits under Universal_PDF_H5 / Flutter; no backend route changes; no new npm dependencies.

Security:

- The routes HTTP API (`GET /routes`, `PUT /routes/{claude,codex}`, `POST /routes/{claude,codex}/{main,small}`, `DELETE /routes/{claude,codex}/{main,small}`) requires the bearer token. `POST /routes/codex/small` returns 400 (Codex 8.0 has no small slot). Only `/catalog/litellm-providers` and `/local/auth/challenge` remain public.

## Claude SDK runtime

`originrouter claude` keeps the first implementation route: a PTY wrapper around the local Claude Code terminal UI.

`originrouter claude-sdk` starts the second route inspired by Happy: a structured Claude Agent SDK runtime. It does not parse the terminal screen. Instead, tool calls and permission requests are emitted as structured `agent.event` messages, and remote clients respond with semantic decisions such as `approved`, `approved_for_session`, `denied`, or `abort`.

Install the SDK before using this route:

```bash
npm install @anthropic-ai/claude-agent-sdk
```

Then run:

```bash
originrouter claude-sdk
```

## Architecture

```text
bin/originrouter.js
  -> src/index.js
  -> src/daemon/daemon.js
  -> src/daemon/sessionManager.js
  -> src/adapters/*
  -> src/executors/*
  -> src/relay/relayClient.js
```

Local state:

```text
~/.originrouter/
  config.json
  device.json
  daemon.state.json
  logs/
```

Executors:

- `pipe`: current zero-dependency executor.
- `pty`: uses `node-pty` when installed.
- `tmux`: starts a session in tmux when tmux is available.

Adapters:

- `terminal`: generic command adapter.
- `claude`: launches `claude` and scans Claude JSONL transcript files for structured events.
- `claude-sdk`: launches Claude through `@anthropic-ai/claude-agent-sdk` and handles permissions through a structured runtime adapter.
- `codex`: launches `codex` and exposes the future Codex app-server adapter boundary.

## Local relay PoC

Run the private relay server:

```bash
cd ../originrouter-server
npm start
```

Run the local daemon:

```bash
cd ../originrouter-cli
npm run daemon
```

Use another executor:

```bash
npm run daemon -- --executor pty
npm run daemon -- --executor tmux
```

Open the temporary test page:

```text
../originrouter-test/index.html
```

## Roadmap

- Install and validate `node-pty`.
- Replace the default executor with `pty`.
- Add Claude hook settings and structured permission events.
- Add Codex app-server adapter.
- Add relay client.
- Harden optional tmux executor.

## Stage 9.2 — Remote Provider (target=proxy) — local PoC, no auth

A route of `type=remote, target=proxy` makes the caller's local
Claude/Codex talk to a worker device's local LiteLLM proxy through
`originrouter-server` as a typed relay. The worker does not need a
public IP — it just opens an SSE connection to the relay and waits
for `remote.coding.request` events.

```
# Worker device (with a real local LiteLLM proxy running on port 40123):
originrouter provider add office --type proxy --litellm-provider openai \
  --api-key sk-... --model gpt-5-codex
originrouter route set codex.main --provider office
originrouter proxy start --port 40123
originrouter daemon                        # worker daemon listens for remote.coding.request

# Caller device (anywhere reachable to the worker via originrouter-server):
originrouter provider add laptop-remote \
  --type remote --device-id office --grant-ref current --target proxy
originrouter route set codex.main --provider laptop-remote --model gpt-5-codex
originrouter env print --agent codex       # starts a temporary relay proxy in this process,
                                          # prints the real port, then tears it down
# Source: remote-coding
# OPENAI_BASE_URL=http://127.0.0.1:<ephemeral-port>/v1
# OPENAI_API_KEY=sk-n...gh                  # masked
# OPENAI_MODEL=gpt-5-codex
originrouter codex                         # local wrapper starts the relay proxy for real,
                                          # spawns Codex, tears the proxy down on exit
```

**No auth in 9.2.** The relay is a pure message broker: it routes
`remote.coding.*` events by `deviceId` alone, with no `Authorization`
header. A future "9.x security" stage will add a `relayAccessToken`
signed by the worker's `deviceGrant`; 9.2 deliberately leaves the seam
clear. The relay also masks `headers` and `body` in its debug ring so
keys and prompts never appear there. The worker strips caller-supplied
`authorization` / `x-api-key` / `host` / `content-length` / `connection`
/ `transfer-encoding` headers before forwarding to its local proxy —
the caller's noop key never reaches the model API; the worker's local
proxy authenticates using its own config.

**Only `target=proxy` is supported.** `target=agent` (run the worker's
own Claude/Codex) and WebRTC/P2P are deferred to a later stage.

## Stage 9.2.1 — Remote Relay Runtime Smoke & Hardening

9.2.1 hardened the runtime with five negative smokes (worker
offline, worker 5xx, worker timeout, caller abort, relay
disconnect), a 3-process happy-path smoke against the real
spawned `originrouter-server`, a process cleanup audit (clean
exit + SIGINT + SIGTERM + uncaught exception all close the
ephemeral port and reap the pid), a concurrent-in-flight test
(two simultaneous requests on the same bridge, no cross-talk),
and a secret-leak audit (no prompt / body / `x-api-key` /
authorization value ever appears in `/debug/events`).

Test count: 31 → 34 CLI suites + 2 binary smokes; server
unchanged. See `docs/agent-runtime-audit.md` for the full
Stage 9.2.1 note with measured numbers.

## Stage 9.3 — Surety v2 + Relay Auth

9.3 promotes the 9.2 no-auth relay to a real auth-backed service.
The CLI now acquires a short-lived `relayAccessToken` from Surety
v2 (using the long-lived `deviceGrant` already stored in
`<stateDir>/coding-key.json`) and sends it to the relay as
`Authorization: Bearer <relayAccessToken>` on every
`/relay/v1/devices/{device_id}/ws` and `/relay/v1/messages` call. The LLM API key is
never touched by Surety or the relay — the two credentials are
fully separated.

**Dev / local bypass:** set `ORIGINROUTER_RELAY_AUTH=off` on **both**
the server and the CLI to run the 9.2 dev path with no Surety.
Production sets `on` on both.

**New env vars:**
- `ORIGINROUTER_RELAY_AUTH` — `off` (default) or `on`. Asymmetric
  config (server=on, CLI=off) causes silent 401s.
- `SURETY_BASE_URL` — Surety base URL (e.g.
  `http://127.0.0.1:9001`). Used by `RemoteCodingProxyManager`
  and the worker daemon to acquire tokens. Stage 9.4 unified
  this name across the relay and CLI; the prior 9.3 name has
  been removed.

**Scope name:** `relay.remote_coding` (not `coding`). The local
managed-key field `KEY_SCOPE.CODING` is a separate concept —
identifies what the LLM-side key unlocks, not what the relay
bearer authorizes.

**Wire protocol:** `body.v = "v1"`. Stage 9.3 is the "Surety v2"
API generation; the wire version follows the existing Surety
convention where `v` is per-module (`/api/object/encode` uses
`v1`, `/api/object_strong` uses `v1`).

**Test count:** 34 → 36 CLI suites; 2 → 5 server suites; 0 → 1
Surety `pytest` suite (11 cases). All green. Multi-process
`e2eSurety.test.js` proves real Gunicorn 4 workers + relay
auth + real Surety verify round-trip works. Negative
`negativeSurety.test.js` covers all 7 Surety failure modes
(503, slow, expired, revoked, device_mismatch,
insufficient_scope, internal_error).

See `docs/agent-runtime-audit.md` and
`docs/originrouter-login-credential-architecture.md` for the
full Stage 9.3 docs.

## Stage 9.4 — local auth-on acceptance

9.4 verifies the CLI's auth-on chain against a real running Surety
and a local `originrouter-server` with `ORIGINROUTER_RELAY_AUTH=on`.
The changes from 9.3 are:

- **Env var name unification.** The CLI's `RemoteCodingProxyManager`
  now reads `SURETY_BASE_URL`. The relay already read `SURETY_BASE_URL`
  since 9.3. The prior 9.3 name has been removed entirely from the
  codebase; the canonical name is `SURETY_BASE_URL` on both sides.
- **No code change to `acquireRelayAccessToken`**, `readCodingAuth`,
  or `maskSecret`. The auth flow is byte-for-byte 9.3; only the env
  var name moved.

**Local acceptance recipe (Mac):**

```bash
# 1. local relay (in another terminal)
cd /Users/chengaoyan/Desktop/originrouter-server
ORIGINROUTER_RELAY_AUTH=on \
SURETY_BASE_URL=https://surety.easytransnote.com \
PORT=18787 \
npm start

# 2. CLI env print — env print only supports --agent claude|codex,
#    not --route/--target. relayUrl is read from ORIGINROUTER_RELAY
#    (default http://localhost:8787, which won't match the local relay
#    on 18787 — set it explicitly).
cd /Users/chengaoyan/Desktop/originrouter-cli
ORIGINROUTER_RELAY_AUTH=on \
ORIGINROUTER_RELAY=http://127.0.0.1:18787 \
SURETY_BASE_URL=https://surety.easytransnote.com \
node ./bin/originrouter.js env print --agent claude
# expect: exit 0, stdout includes ANTHROPIC_BASE_URL=http://127.0.0.1:<port>,
# no fallback/no-auth/surety_unavailable warning, no plaintext grant/token leak.
# Do NOT curl /health on the printed port — RemoteCodingRelayProxy has no
# /health route; any GET is wrapped as remote.coding.request.
```

## Stage 9.5 — production auth-on worker support

Stage 9.5 wires the worker/control side of the CLI to acquire Surety tokens when `ORIGINROUTER_RELAY_AUTH=on`, and ships the `RemoteCodingProxyManager` fix that makes `env print --agent claude` work in real environments where `device.json.deviceId !== coding-key.json.deviceId`.

### `relayAuthBootstrap` — the worker/control helper

A new module `src/relay/relayAuthBootstrap.js` centralizes the "read coding-key, acquire Surety token, build RelayClient options" pattern. It exports:

- `isRelayAuthOn()` — boolean, mirrors `isAuthOn()` in `RemoteCodingProxyManager`.
- `buildRelayClientOptions({ stateDir, relayUrl, fallbackDeviceId, fetchFn })` — async, returns `{ relayUrl, deviceId, authToken, authState, tokenExpiresAt }`. On any failure, throws `RelayAuthBootstrapError` with `err.code` set to the mapped Surety error string and `err.message === err.code` exactly (no concatenation, no Surety original message, no deviceGrant, no token).

The caller-side `RemoteCodingProxyManager` already wires this same contract for `env print` and remote-coding; 9.5 applies the same contract to the three worker/control call sites so a worker can actually connect to an `auth=on` relay.

### Three call sites updated

- `src/daemon/daemon.js` — at boot, calls `buildRelayClientOptions(...)` to acquire a token and construct `RelayClient`. The effective `deviceId` (from `coding-key.json` when `auth=on`) is passed to the `SessionManager` constructor. In the SSE reconnect loop, re-acquires via `buildRelayClientOptions` and updates BOTH `relayClient.deviceId` AND `relayClient.authToken` before the next reconnect attempt. On re-acquire failure, logs `code=...` only and backs off 1.5s.
- `src/local/localAgentSession.js` — same pattern. The `appendSessionStart` deviceId field uses `effectiveDeviceId` so the local session log records the relay-side identity.
- `src/runtime/claudeSdkSession.js` — same pattern. The SDK session's reconnect loop re-acquires before the next attempt.

### `RemoteCodingProxyManager` deviceId fix (the `env print` fix)

When `auth=on`, the manager now reads `coding-key.json.deviceId` inside `start()` and overrides the constructor-supplied `this.deviceId` (which came from `ensureDeviceForLogin()` via `device.json`) before constructing the inner `RemoteCodingRelayProxy`. Without this, the inner proxy would open its SSE with the wrong deviceId and the relay would return 403 `device_mismatch` even with a fresh token.

The 9.5 test `tests/remoteCodingProxyManagerDeviceId.test.js` asserts this by spying on the manager's `fetchFn` and inspecting the inner proxy's `/relay/v1/devices/{deviceId}/ws` URL.

### `coding-key.json` shape for prod

The shape MUST satisfy `isManagedKeyShape()` in `src/runtime/authContract.js`. Required fields: `kind` (`"managed"`), `keyId`, `key`, `deviceGrantId`, `deviceGrant`, `deviceId`, `expiresAt` (number, ms), `scopes` (array including `"coding"`), `source` (`"originrouter_cli"`). The `key` field is the per-route API key (a no-op placeholder is fine for the 9.5 smoke). The file is mode `0o600` at the default `stateDir` (`~/.originrouter/coding-key.json` when run as root).

### ESM token smoke (the only one that works)

The CLI does NOT have an `auth print-token` command. The actual operator recipe is ESM:

```bash
node --input-type=module -e '
  import fs from "node:fs";
  import { acquireRelayAccessToken } from "/opt/originrouter-cli/src/auth/suretyTokenClient.js";
  const k = JSON.parse(fs.readFileSync(process.env.HOME + "/.originrouter/coding-key.json", "utf8"));
  const r = await acquireRelayAccessToken({
    suretyUrl: "http://127.0.0.1:9001",
    deviceId: k.deviceId,
    deviceGrant: k.deviceGrant,
  });
  if (!r.ok) throw new Error(JSON.stringify(r));
  console.log("token len=" + r.token.length + " ttl=" + Math.floor(r.expiresAt - Date.now() / 1000));
'
```

The TTL is computed from `r.expiresAt` (a Unix epoch in seconds), not from a separate `expiresInSec` field.

### Residual risk (documented)

9.5 ships **re-acquire on reconnect only**. A worker that is fully idle (no SSE reconnect, no `connectEvents` re-entry) past the token's `expiresAt` will attempt to reconnect with a stale token; the relay returns 401, the re-acquire path runs, and the worker recovers on the next reconnect tick. 9.5 does not schedule a timer to refresh proactively. A 9.6+ timer refresh (modelled on the proven `REFRESH_LEAD_MS = 60_000` pattern in `RemoteCodingProxyManager`) is the next step.

### Tests added in 9.5

- `tests/relayAuthBootstrap.test.js` — 6 cases (off, on-happy, on-surety-fail, on-surety-5xx, on-no-coding-key, on-no-surety-url). Asserts `err.message === err.code` exactly and no grant/token in `err.message`.
- `tests/remoteCodingProxyManagerDeviceId.test.js` — asserts the inner proxy's `connectEvents` URL contains the coding-key `deviceId` (NOT the constructor's value).

These are targeted non-GUI tests; the full `npm test` is NOT run end-to-end because the full suite opens browser fixtures.

## Stage 9.6/9.7 — OriginRouter Login (RFC 8628 Device Flow)

Stage 9.6 introduced the browser-callback login flow (dev-mint +
local HTTP server). Stage 9.7 replaced it with the standard
**OAuth 2.0 Device Authorization Grant (RFC 8628)**: the CLI
prints an 8-character user code + verification URL, optionally
opens the browser, then polls the backend until the user
approves on the H5 page. No local HTTP server, no dev-only
backend routes, no Surety stub. Works for SSH / Docker / CI
out of the box.

### Login flow

The default `originrouter login` uses device flow. There is
**only one path now** — `--device-flow` was the 9.6 opt-in
flag and was promoted to default in 9.7.

**Default (desktop, opens the browser):**

```bash
originrouter login
# ! To complete login, visit:
# !   https://originrouter.com/cli/authorize
# ! and enter this code:
# !   ABCDEFGH
# ! Or open the URL directly (code is pre-filled):
# !   https://originrouter.com/cli/authorize?user_code=ABCDEFGH
# ! Waiting for authorization (expires in 600s)...
# (browser opens; user clicks Authorize; CLI prints ✓ Authorization received.)
# Logged in to https://originrouter.com
# Device:    device-...
# Grant:     og_... (idle 89d / abs 364d)
# Key:       sk-or-****abcd (id ok_..., expires 30d)
```

**Headless (SSH / Docker / CI, no browser):**

```bash
originrouter login --no-browser
# Same URL + code printout, no browser launch. Suitable when
# the CLI runs on a machine without a GUI session or browser.
```

### What the 9.6 paths became

| 9.6 path | Status in 9.7 |
|---|---|
| `originrouter login --manual-code <code>` | **Removed.** Manual code copy-paste is gone — device flow is always available and works without a browser. |
| `loginWithDevMintCallback` (browser callback flow) | **Removed.** Required a local HTTP server on 127.0.0.1 to receive the H5 redirect; replaced by device flow's polling loop. |
| `/login-code/dev-mint` (backend) | **Removed.** The dev-mode Surety bypass is gone; production wire-up is the only path. |
| `/device/approve` (backend, dev) | **Removed.** Surety uuid auth will gate the production `/device/approve` when Surety v2 lands; the dev stub is no longer needed. |
| `ORIGINROUTER_CLI_DEV_MINT=1` (backend env) | **Removed.** No dev-mode flag — the backend serves the same routes in dev and prod. |

### CLI flags for `originrouter login`

| Flag | Default | Notes |
|---|---|---|
| `--api-base-url <url>` | `process.env.ORIGINROUTER_API_BASE_URL` or `https://server.easytransnote.com` | OriginRouter auth gateway base URL (where `/device/code` and `/device/token` live). |
| `--device-name <name>` | `<username>'s CLI` | Friendly device name shown on the H5 approve page. Derived from `os.userInfo().username` so it reads naturally (e.g. `chengaoyan's CLI`). Override with this flag for a custom label. |
| `--no-browser` | browser opens | Don't auto-open the browser; only print URL + code. Use in SSH / Docker / CI. |
| `--login-url <url>` | `process.env.ORIGINROUTER_LOGIN_URL` or `https://originrouter.com` | H5 authorize page base URL. The API gateway and the H5 page are on **different domains** in production. |

### Env vars

| Var | Default | Notes |
|---|---|---|
| `ORIGINROUTER_API_BASE_URL` | `https://server.easytransnote.com` | Backend base URL for the auth gateway. Honored when `--api-base-url` is omitted. |
| `ORIGINROUTER_LOGIN_URL` | `https://originrouter.com` | H5 authorize page base URL. Honored when `--login-url` is omitted. |
| `ORIGINROUTER_CLI_H5_BASE_URL` (backend) | `https://originrouter.com` | H5 base URL returned in `/device/code`'s `verification_uri`. Set on the gateway side. |

### `coding-key.json` shape

The on-disk shape is written by `persistExchangeResponse()` and must satisfy `isManagedKeyShape()`:

```jsonc
{
  "kind": "managed",
  "source": "originrouter_cli",
  "keyId": "ok_x",
  "key": "sk-or-x",
  "deviceGrantId": "og_x",
  "deviceGrant": "<raw-grant>",
  "deviceId": "smoke",
  "expiresAt": 1700000000000,
  "scopes": ["coding"],
  "deviceGrantIdleExpiresAt": 1702592000000,    // optional
  "deviceGrantAbsoluteExpiresAt": 1731456000000 // optional
}
```

Stage 9.5's `relayAuthBootstrap` reads this file directly via `readCodingAuth()`; no further conversion needed.

### No secret in log

Errors from `originrouterAuthClient.js` throw `AuthClientError` whose `body` is `null` and whose `message` contains only an error code or the missing-field name — never the raw `deviceGrant`, `managed_coding_key`, or login code. The CLI's post-login print shows `deviceId` + `deviceGrantId` (opaque `og_<token>`) + masked key. A `grep -iE "deviceGrant|sk-or-[a-zA-Z0-9]+"` on the operator's terminal finds only the masked form `sk-or-****abcd`.

### Targeted tests (9 + 1 e2e)

```bash
node ./tests/cliLogin.test.js                  # 4 cases (status, help, rotate, --device-flow e2e)
node ./tests/originrouterAuthClient.test.js    # exchangeResponseToManagedKeyShape + helpers
node ./tests/originrouterLogin.test.js         # 11 cases (loginUrlFor, callback, device flow unit)
node ./tests/codingAuthStorage.test.js         # isManagedKeyShape + TTL bounds
node ./tests/relayAuthBootstrap.test.js        # 9.5 bootstrap reads coding-key.json
node ./tests/remoteCodingProxyManagerDeviceId.test.js
node ./tests/suretyTokenClient.test.js
node ./tests/relayClientAuth.test.js
node ./tests/9.6-e2e.test.js                   # 9.6 Loop B end-to-end (legacy shape; still green)
```
