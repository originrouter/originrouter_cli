# OriginRouter CLI

Run Claude Code and Codex through one local control plane — with model routing,
remote sessions, approval policies, and signed protocol compatibility updates.

[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Status: Preview](https://img.shields.io/badge/status-preview-f59e0b)](#project-status)

> [!IMPORTANT]
> OriginRouter CLI is currently a preview release. The npm package is not yet
> published; install it from source using the steps below.

OriginRouter CLI is the device-side runtime for OriginRouter. It can wrap an
existing Claude Code or Codex installation without replacing its native
configuration, or route those agents through local LiteLLM providers,
OriginRouter Cloud, and authorized remote devices. The optional OriginRouter
App adds a visual control surface; the CLI remains the execution and policy
authority on the machine running the agent.

## Why OriginRouter

- **Keep the native terminal experience.** Launch the installed Claude Code or
  Codex TUI and preserve its arguments, resume flow, and project configuration.
- **Route models consistently.** Configure Claude Code's primary and fast
  routes, or Codex's model route, across local providers, cloud models, and
  remote devices.
- **Control agents from another device.** Follow conversations, send messages,
  stop work, answer supported prompts, and review approvals through an
  authenticated local or account bridge.
- **Put approval policy on the execution device.** Manual, guarded, AI review,
  unrestricted, and policy-as-code modes are evaluated by the CLI rather than
  by the relay.
- **Adapt model protocols safely.** A loopback compatibility gateway applies
  signed, sandboxed WASM transformations without exposing model traffic to the
  update service.
- **Retain a local audit trail.** Approval and external-change events are kept
  in an append-only, hash-linked local ledger.

## How it fits together

```text
OriginRouter App (optional)
        │ local API / encrypted account bridge
        ▼
OriginRouter CLI daemon ─── session control, policy evaluation, local audit
        │
        ├── Claude Code / Codex
        │
        └── Compatibility Gateway ── LiteLLM ── model provider
```

The App and relay coordinate control. They do not become the execution engine,
and the relay does not receive plaintext provider credentials or decrypted
remote agent payloads.

## Requirements

| Requirement          | When it is needed                                                |
| -------------------- | ---------------------------------------------------------------- |
| Node.js 22 or newer  | Always                                                           |
| Claude Code or Codex | To launch the corresponding native agent                         |
| Python 3.10 or newer | Only for the managed local LiteLLM proxy                         |
| OriginRouter account | Only for cloud models, account bridge, and cross-device features |

Service management is implemented for macOS (`launchd`), Linux (`systemd
--user`), and Windows (Task Scheduler).

## Install from source

```bash
git clone https://github.com/originrouter/originrouter_cli.git
cd originrouter_cli
npm install
npm link
originrouter --version
```

`npm link` points the global `originrouter` command at this checkout. Pulling
new source and running `npm install` updates the linked development install.

To work without a global link:

```bash
node ./bin/originrouter.js --help
```

## Five-minute start

### 1. Check the machine

```bash
originrouter doctor
```

### 2. Install and start the background service

```bash
originrouter service install
originrouter service start
originrouter status
```

The daemon exposes an authenticated Local API on loopback by default and keeps
the device available to the App. Use `originrouter service status` for native
service diagnostics.

### 3. Launch an agent

Use the machine's existing agent login, environment, model, and configuration:

```bash
originrouter claude --originrouter-native-config
originrouter codex --originrouter-native-config
```

Or launch with the model route configured in OriginRouter:

```bash
originrouter claude
originrouter codex
```

All non-OriginRouter arguments are passed to the installed agent. Native resume
syntax is preserved:

```bash
originrouter claude --resume <claude-session-uuid>
originrouter codex resume --last
```

## Sign in for cloud and remote control

Local use does not require an OriginRouter account. Sign in only when you want
cloud models, account-backed device discovery, or control from another signed-in
device:

```bash
originrouter login
originrouter auth status
```

The CLI uses the OAuth Device Authorization Grant, so the same flow works in a
desktop terminal, SSH session, container, or CI environment. For a headless
machine:

```bash
originrouter login --no-browser
```

The installation owns a random, persistent device ID. It is not derived from a
MAC address, serial number, hostname, or operating-system machine ID.

## Configure a local model provider

Install the managed LiteLLM runtime:

```bash
originrouter proxy install
```

Add a provider. Secret values may be stored as environment references instead
of literals:

```bash
originrouter provider add team-anthropic \
  --type proxy \
  --engine litellm \
  --litellm-provider anthropic \
  --api-key os.environ/ANTHROPIC_API_KEY \
  --model claude-sonnet-4-6
```

Assign routes and start the proxy:

```bash
originrouter route set claude.main \
  --provider team-anthropic \
  --model claude-sonnet-4-6

originrouter route set claude.small \
  --provider team-anthropic \
  --model claude-haiku-4-5

originrouter proxy start --port 4000
originrouter route show claude
```

Claude Code's two routes must resolve to the same source. Codex uses one model
route:

```bash
originrouter route set codex.main \
  --provider team-openai \
  --model gpt-5.4
```

The App's Provider Control surface manages the same device-local configuration.
Provider secrets are write-only and masked in CLI and API output.

## Choose a route source

OriginRouter keeps three source types distinct:

| Source                 | Configuration                                                               |
| ---------------------- | --------------------------------------------------------------------------- |
| Local LiteLLM provider | `originrouter provider ...` and `originrouter route set ...`                |
| OriginRouter Cloud     | `originrouter route cloud models` and `originrouter route cloud set ...`    |
| Authorized remote CLI  | `originrouter route remote devices` and `originrouter route remote set ...` |

A local provider entry never represents OriginRouter Cloud. Cloud and remote
sources require login and use audience-scoped credentials.

Account devices and remote model routes are deliberately separate:

```bash
originrouter devices
originrouter devices --json
```

`originrouter devices` lists every authorized CLI device and reports whether
it is online, trusted, the current device, and running Remote Share. It is the
device-discovery command for Agent control and collaboration diagnostics.

`originrouter route remote devices` lists only devices currently eligible to
serve remote LLM routes: the device must be online, Remote Share must be
running, and at least one Provider model must be shared. Remote Agent control
and cross-device collaboration do not require Remote Share.

Device commands use the running daemon's Relay/control endpoint so the CLI and
App do not drift between separate brand directories. With no running daemon,
they use the product default. `ORIGINROUTER_CONTROL_BASE_URL` remains the
explicit development override.

New or reinstalled devices intentionally start without trusted Agent
workspaces. In the App, select the target device, enter or browse to a folder,
and explicitly confirm that folder before launching an Agent or adding it to a
collaboration. Browsing starts at the target device's home directory, but the
home directory is never trusted automatically.

## Agent control and approval modes

Start a session with an explicit autonomy profile:

```bash
originrouter claude --originrouter-autonomy guarded
originrouter claude --originrouter-autonomy ai_review
originrouter claude --originrouter-autonomy custom \
  --originrouter-policy ~/.originrouter/policies/team-default.json
```

| Mode           | Behavior                                                        |
| -------------- | --------------------------------------------------------------- |
| `manual`       | Ask the user for supported approval decisions                   |
| `guarded`      | Automatically allow a conservative built-in scope               |
| `ai_review`    | Ask the configured review model within hard safety boundaries   |
| `unrestricted` | Allow supported decisions without interactive review            |
| `custom`       | Evaluate a versioned approval-policy document on the CLI device |

Unknown tools, ambiguous shell expansion, insufficient evidence, and unsafe
path resolution fail closed to user review. See
[Approval Policy v2](docs/approval-policy-v2.md) for the policy language and
security model.

Conversation presentation can be selected independently from execution policy:

```bash
originrouter agent detail set concise
originrouter agent detail set standard
originrouter agent detail set detailed
```

## Signed compatibility updates

Managed LiteLLM traffic passes through a loopback compatibility gateway. The
CLI ships with offline fallbacks and can install signed WASM patch snapshots:

```bash
originrouter compatibility status
originrouter compatibility list
originrouter compatibility check
originrouter compatibility update
originrouter compatibility rollback
```

Compatibility modules can transform bounded JSON protocol data. They cannot
access the filesystem, network, environment variables, processes, credentials,
approval capabilities, or E2EE keys. The CLI verifies signatures, hashes,
engine compatibility, capabilities, resource limits, and revision order before
activation.

See the [Model Compatibility Gateway](docs/model-compatibility-gateway.md) for
the execution and update model.

## Useful commands

| Goal                           | Command                                                  |
| ------------------------------ | -------------------------------------------------------- |
| Inspect installation health    | `originrouter doctor`                                    |
| Show runtime status            | `originrouter status`                                    |
| List providers and routes      | `originrouter provider list` / `originrouter route list` |
| Print agent environment        | `originrouter env print --agent claude`                  |
| Inspect local sessions         | `originrouter sessions`                                  |
| Search display-safe activity   | `originrouter agent history --search <text>`             |
| Show the Local API key         | `originrouter local key show`                            |
| Configure LAN/relay behavior   | `originrouter local config show` / `set`                 |
| Restart the daemon             | `originrouter service restart`                           |
| Run the full diagnostics suite | `originrouter doctor`                                    |

Run `originrouter --help` for the complete command surface.

## Security and privacy

- Provider keys, OAuth tokens, device grants, and raw request bodies are never
  written to display-safe cloud indexes.
- Full transcripts, tool output, source code, commands, and filesystem paths
  remain on the CLI device unless they are explicitly transported through an
  end-to-end encrypted device channel.
- Account activity sync contains redacted titles, summaries, previews, device
  and workspace labels, and timestamps only.
- Approval and external-change audit history is stored locally in an
  append-only, hash-linked ledger.
- The Local API requires a per-installation bearer key, including on loopback.
- Backend service keys must never be placed in CLI configuration.

Start with the [login and credential architecture](docs/originrouter-login-credential-architecture.md)
and [local management security model](docs/cli-local-management-security.md)
when integrating or reviewing the system.

## Documentation

- [OriginRouter CLI guide](https://originrouter.com/docs/originrouter-tools/cli)
- [Native Claude and Codex control](docs/native-agent-control.md)
- [Provider route resolution](docs/provider-route-resolution.md)
- [Agent autonomy](docs/agent-autonomy.md)
- [Approval Policy v2](docs/approval-policy-v2.md)
- [Agent collaboration](docs/collaboration-adaptive-v2.md)
- [Local audit ledger](docs/agent-local-audit.md)
- [Model Compatibility Gateway](docs/model-compatibility-gateway.md)

Repository documents are implementation specifications. End-user workflows
live in the public OriginRouter documentation so product guidance has one
canonical home.

## Development

```bash
npm install
npm test
node ./bin/originrouter.js --help
```

Focused suites are available for major subsystems:

```bash
npm run test:agent-control
npm run test:collaboration
npm run test:compatibility
```

When changing approval-policy actions or fields, regenerate and verify the
shared registry before submitting a change:

```bash
npm run generate:approval-policy-registry
npm run check:approval-policy-registry
```

## Project status

OriginRouter CLI is under active development. Command names and persisted
schemas are treated as compatibility-sensitive, but pre-1.0 releases may still
introduce documented migrations.

## License

MIT
