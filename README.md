# OriginRouter CLI

OriginRouter CLI manages local LiteLLM routes and connects a CLI installation
to OriginRouter Cloud, remote devices, and Proxy Control.

Agent approval and external-change audit history is stored locally in an
append-only, hash-linked ledger. See `docs/agent-local-audit.md` for storage,
filtering, redaction, and App/Relay behavior.

Signed-in installations also maintain a display-safe Agent Activity index for
cross-device recall. Native `originrouter claude` / `originrouter codex` and
managed terminal sessions upload only a redacted title, task summary, first
prompt preview, latest message preview, device/workspace labels, and source
timestamps. Full transcripts, tool output, commands, source code, filesystem
paths, and credentials remain on the CLI device. The daemon incrementally
backfills eligible local Catalog records after login and retries from its last
successful cursor after transient failures.

## Install and test

```bash
npm install
npm test
node ./bin/originrouter.js --help
```

## Device identity

The CLI creates a cryptographically random `device-<32 hex>` identifier and
persists it in the local state directory. It never reads MAC addresses,
hardware serials, hostnames, machine IDs, or platform hardware UUIDs.

The same config directory keeps the same device ID across logins. Separate
config directories are separate installations, even on one physical machine.

## OAuth login

```bash
originrouter login
originrouter auth status
originrouter logout
```

Login uses RFC 8628 Device Authorization Grant directly with Surety:

1. CLI requests a Device Code from Surety.
2. CLI prints and opens the verification URL.
3. User approves the code in the H5 page.
4. CLI polls Surety and stores one rotating Refresh Token plus short-lived
   Control, AI, Coding, and Relay Access Tokens.

Credential prefixes:

```text
or_at_*   access token
or_rt_*   refresh token
or_dc_*   device code
or_ses_*  session identifier
```

Credentials are written with mode `0600`. Refresh rotation is protected by a
cross-process lock so two CLI processes cannot reuse the same Refresh Token.

Environment overrides:

```text
SURETY_BASE_URL=https://surety.easytransnote.com
ORIGINROUTER_LOGIN_URL=https://originrouter.com/cli/authorize
ORIGINROUTER_API_BASE_URL=https://app.easytransnote.com
ORIGINROUTER_CONTROL_BASE_URL=https://app.easytransnote.com
ORIGINROUTER_RELAY=https://app.easytransnote.com
```

## Route sources

Local providers are LiteLLM proxy configurations only:

```bash
originrouter provider add my-provider \
  --type proxy \
  --engine litellm \
  --litellm-provider anthropic \
  --base-url https://api.example.com \
  --api-key os.environ/PROVIDER_API_KEY \
  --model model-id
```

OriginRouter Cloud and remote CLI devices are login-backed sources, not local
providers:

```bash
originrouter route cloud models
originrouter route cloud set claude.main
originrouter route remote devices
originrouter route remote set claude.main
```

Audience use is strict:

```text
Control AT  device registry and runtime reporting
AI AT       Cloud model catalogue
Coding AT   Claude/Codex Cloud requests
Relay AT    remote coding and realtime relay
```

## Common commands

```bash
originrouter status
originrouter doctor
originrouter provider list
originrouter route list
originrouter env print --agent claude
originrouter proxy install
originrouter proxy start --port 4000
originrouter daemon
originrouter service install
originrouter claude
originrouter codex
```

`originrouter provider add` does not create an OriginRouter Cloud provider.
Cloud access exists only after OAuth login.

## Native Agent sessions

OriginRouter can wrap the installed Claude Code or Codex TUI while leaving the
agent's own environment, authentication, model, and configuration in control:

```bash
originrouter claude --originrouter-native-config
originrouter codex --originrouter-native-config
```

Resume syntax follows the installed agent:

```bash
originrouter claude --resume <claude-session-uuid>
originrouter claude -r <claude-session-uuid>
originrouter codex resume <codex-session-id-or-name>
originrouter codex resume --last
```

Claude does not support `-resume`; Codex does not use a `--resume` option.
OriginRouter-specific flags are removed and all remaining arguments are passed
to the native agent unchanged.

See [docs/native-agent-control.md](docs/native-agent-control.md) for the full
configuration/resume contract and
[docs/agent-autonomy.md](docs/agent-autonomy.md) for unattended execution.

Custom unattended allow-list example:

```bash
originrouter claude \
  --originrouter-auto-allow plan_continue,read_tools,workspace_edits \
  --originrouter-auto-allow workspace_commands
```

The App exposes the same per-session allow-list through the Agent conversation
control panel.

## Agent collaboration

Agent collaboration works from the CLI without the App. New collaborations use
an adaptive flow: a read-only Planner first turns the objective, participants,
and collaboration preferences into a validated task graph. Agents do not begin
execution until the user confirms that plan.

List the built-in starting patterns:

```bash
originrouter collaboration templates
```

Create a collaboration:

```bash
originrouter collaboration create \
  --objective "Investigate and fix provider reconnection" \
  --participant architect:codex:local:/path/to/project \
  --participant builder:claude:local:/path/to/project \
  --role architect="analyze the architecture and verify the result" \
  --role builder="implement and test the change" \
  --preference "research independently when useful"
```

The participant format is:

```text
participant-id:claude|codex:device-id:workspace-path
```

The first participant is the default Planner. `--role` is a natural-language
preference rather than a hard-coded role. The Planner may assign a different
task structure when the objective requires it.

In an interactive terminal, `create` waits for the proposed plan and asks
whether to start it. In scripts, add `--yes` to confirm automatically, or
manage the run explicitly:

```bash
originrouter collaboration list
originrouter collaboration show <run-id>
originrouter collaboration confirm <run-id>
originrouter collaboration cancel <run-id>
```

For reusable definitions or more participants, use a JSON specification:

```bash
originrouter collaboration create --spec collaboration.json
```

Budgets are optional. Independent dependency-ready tasks may run in parallel
on different participants, while one participant receives only one active task
at a time. Existing `plan_implement_verify` runs remain compatible.

Cross-device task prompts and results use the Device E2EE relay transport. The
server receives only a redacted run/status and usage projection. SQLite schema
upgrades are automatic, and interrupted adaptive tasks are reissued with a new
lease and fencing token after daemon restart.

See [docs/collaboration-adaptive-v2.md](docs/collaboration-adaptive-v2.md) for
the JSON format, privacy boundary, and recovery behavior.

## Agent conversation detail

Each OriginRouter CLI installation keeps one default presentation level for
new Claude and Codex sessions:

```bash
originrouter agent detail
originrouter agent detail set concise
originrouter agent detail set standard
originrouter agent detail set detailed
```

The built-in default is `concise`. `concise` keeps the conversation, blocking
requests, errors, and one folded work summary per turn. `standard` also
surfaces key plans, commands, file changes, and subagent milestones.
`detailed` shows every display-safe structured Agent event. Raw PTY animation
frames are never forwarded as Agent messages at any level.

Override the installed default for one new session with:

```bash
originrouter claude --originrouter-detail standard
originrouter codex --originrouter-detail=detailed
```

Resolution order is:

```text
--originrouter-detail > installed CLI default > built-in concise
```

Proxy Control in the App can change the selected CLI installation's default
through local direct control or the authenticated cloud bridge. The change
applies only to sessions started afterward. Existing sessions retain and show
the detail level resolved when they were launched.

## Security rules

- Never put Surety backend service keys (`or_sk_*`) in CLI config.
- Never send a token to a resource with a different audience.
- Never log raw Access Tokens, Refresh Tokens, Device Codes, or provider keys.
- An expired Refresh Token requires a new login.
- Logout/revoke removes local credentials and revokes the Surety session.

See [docs/originrouter-login-credential-architecture.md](docs/originrouter-login-credential-architecture.md)
for the credential contract and [docs/provider-route-resolution.md](docs/provider-route-resolution.md)
for route precedence.
