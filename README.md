<p align="center">
  <img src="assets/readme-hero-en.webp" alt="OriginRouter CLI — Claude Code and Codex from one local control plane." width="100%" />
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  Run Claude Code and Codex from one local control plane.<br />
  Coordinate work, route models, apply approvals, and follow sessions from another device.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@originrouter/cli"><img alt="npm" src="https://img.shields.io/npm/v/@originrouter/cli?style=flat-square&color=ff4b16" /></a>
  <a href="https://github.com/originrouter/originrouter_cli/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/originrouter/originrouter_cli/ci.yml?branch=main&style=flat-square&label=CI" /></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white" />
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-ff4b16?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  · <a href="#choose-your-entry-point">Choose an entry point</a>
  · <a href="https://originrouter.com/docs/originrouter-cli/overview">CLI docs</a>
  · <a href="https://originrouter.com/docs/originrouter-app/overview">App docs</a>
  · <a href="https://github.com/originrouter/originrouter_cli/issues">Issues</a>
</p>

> [!IMPORTANT]
> OriginRouter CLI is pre-1.0. Read the release notes before upgrading; preview
> releases may include documented migrations.

## What is OriginRouter CLI?

OriginRouter CLI is the local execution and control layer around the coding
Agents you already use. Claude Code and Codex remain the execution engines;
OriginRouter gives them one workspace for routing, collaboration, approvals,
session control, and remote follow-up.

- Start with an objective instead of assembling several Agent commands by hand.
- Use Claude Code or Codex directly, or let the Agent Workspace coordinate a team.
- Route requests through OriginRouter Cloud, local model services, or trusted remote clusters, with policy-based load balancing across regions.
- Keep commands, tools, workspace access, and approval decisions on the executing device.
- Connect the optional OriginRouter App to inspect state, handle approvals, and follow work remotely.

<p align="center">
  <img src="assets/readme-architecture-en.svg" alt="OriginRouter collaboration flows through the App and local CLI, which runs agents and routes requests through cloud, local, or remote model services, including data-region inference." width="980" />
</p>

## Choose your entry point

| Entry point | Use it when |
| --- | --- |
| `originrouter` | You need a persistent workspace, planning, delegation, or review. |
| `originrouter claude` | You want the native Claude Code terminal experience with OriginRouter control. |
| `originrouter codex` | You want the native Codex terminal experience with OriginRouter control. |
| OriginRouter App | You want visual status, approvals, or remote follow-up from another device. |

The App is optional. Local commands, tools, and workspace access always run on
the CLI device.

## Launch methods and App controls

Following a terminal session from the App keeps control of its original process. Creating a
session from the App starts a process on the selected device. Features in an official local
UI are not automatically remote App controls. The online session reports its actual capabilities;
unsupported controls remain disabled. This is the integration matrix for this source version.

`--native-config` selects native login/model configuration, not TUI versus SDK transport.
Claude/Codex gateway sessions retain their routing model while the gateway selects the actual
model. Only native configuration uses official model catalogs and native setters. agy always
uses the user's official Google login and quota, without OriginRouter model-provider injection.

### Claude Code

| Capability | Terminal `originrouter claude`, followed from App | App-created Claude |
| --- | --- | --- |
| Runtime and local UI | Official TUI + PTY + startup Hooks | Claude SDK; no native TUI |
| Messages, history, tools and activity | PTY input and native transcript | SDK input and events |
| Tool approvals, questions and plans | PermissionRequest, AskUserQuestion and ExitPlanMode Hooks | SDK approvals, questions and plan confirmation |
| MCP forms / URL interactions | Public Elicitation Hooks | Public SDK elicitation callbacks; private product dialogs remain local |
| App model selection with native config | No native TUI setter; disabled | Official catalog and acknowledged changes |
| App reasoning effort | Session-only control when the native slider is recognized | Runtime-reported levels |
| App permission mode | Recognized native mode controls with confirmation | SDK controls for runtime-reported modes |
| In-flight input / side conversations | Subject to native input/modal state; no structured side channel | Integrated SDK messaging and `/btw` side conversations |
| App `/` commands | Curated injection; native panels do not become structured App controls | Integrated SDK / app-server commands and results |
| App image/file content blocks | Not exposed by this integration | Not exposed by this integration |
| OriginRouter device tools / automatic recovery | Full managed capabilities not exposed | Session-bound device tools and runtime supervision |
| Interrupt, stop and conversation resume | Supported through the native process | Supported through the SDK/session lifecycle |

### Codex

| Capability | Terminal `originrouter codex`, followed from App | App-created Codex |
| --- | --- | --- |
| Runtime and local UI | Official TUI + PTY | Official app-server; no native TUI |
| Messages, history, tools and activity | PTY input and rollout logs | Structured requests and events |
| Structured App approvals / questions / MCP forms | No blocking control channel for this TUI; answer locally | Public app-server approval, input and elicitation interfaces |
| App native model / reasoning selection | No native TUI setters; disabled | Official model catalog, configuration and confirmation |
| App execution mode / autonomy | Structured native TUI controls unavailable | Runtime-reported modes and policy controls |
| Plans, compaction and usage mirroring | Events exposed in native logs | Official app-server events and results |
| Side conversations / background terminals | Native local features; structured App controls unavailable | Integrated fork side conversations and background terminal commands |
| App `/` commands | Curated injection; native panels do not become structured App controls | Integrated SDK / app-server commands and results |
| App image/file content blocks | Not exposed by this integration | Not exposed by this integration |
| OriginRouter device tools / automatic recovery | Full managed capabilities not exposed | Session-bound device tools and runtime supervision |
| Interrupt, stop and conversation resume | Supported through the native process | Supported through app-server/session lifecycle |

To select a managed runtime explicitly from a terminal, use `originrouter claude-terminal` or
`originrouter codex-terminal`; these do not provide the official native TUI either. Following
an existing native session from the App never changes its runtime.

### Antigravity CLI (agy)

Terminal `originrouter agy` and App-created agy now use the **same official native TUI + PTY +
Hooks runtime**. A terminal launch attaches local input/output; an App launch uses a background
virtual terminal. This changes the visible window, not the agent's control capabilities.
Following an existing session never starts another ACP process for it.

| Capability | Both native launch methods |
| --- | --- |
| Messages, history, queue, interrupt, stop and exact resume | Supported; modal state and local drafts are protected |
| Tool approvals | Shared local OriginRouter prompt and App interaction; native deny rules remain effective |
| Native questions | Structured single/multiple choice and single-choice write-in answers, confirmed by native results |
| Model / reasoning / execution mode | Supported native catalogs and observed settings; changes wait for idle, restart the child and resume the exact conversation. Reasoning choices require account-advertised model variants |
| App text/image attachments | UTF-8 text context; validated PNG/JPEG uploaded as private session files and read by native agy. Subject to model support |
| OriginRouter device-tools MCP | Session-bound MCP and device approval; native and device approval may be separate steps |
| Commands and usage | Curated prompt skills and `/compact`; actual transcript token counts, without a fabricated quota balance |
| Generic MCP forms / URL authorization | No general native responder exposed; unsupported panels remain local |
| Automatic interrupt-and-continue recovery | Not advertised on native TUI; no formal ACP cancellation acknowledgment is assumed |
| Background-task management / fork | No general structured App control is advertised |

Menu drivers are enabled for the tested official **agy 1.5.13**. Other versions retain the native
process and basic control; unverified structured controls stay disabled. Existing recorded
`agy-acp` conversations retain ACP when resumed; explicit `originrouter agy-acp` is available
for integration use. That mode has structured forms, direct content blocks and ACP cancellation,
and has no native TUI. It is not selected automatically by App startup.

agy integration registers independent, environment-gated entries in the official global Hook
and MCP files while preserving user entries. Bare agy does not contact the OriginRouter broker
and the inactive MCP entry exposes no tools. Remove only these entries with:

```sh
originrouter agy-integration uninstall
```

Starting another controlled agy session reinstalls the integration. Optional official installation
uses `originrouter setup --with-agy`; agy is not an npm dependency. Proxy variables take precedence,
then static system proxy settings are used for this process and its children; shell profiles are
not modified. PAC/TUN and network availability remain environment-specific.

Version, platform, login and account permissions can limit features. Multi-agent/scheduled agy
launches remain outside this integration. See the [integration notes](docs/antigravity-integration.md)
and [validation matrix](docs/antigravity-feature-parity.md) for evidence and limits.

## Install

### Recommended: official installer

macOS, Linux, and WSL:

```bash
curl -fsSL https://originrouter.com/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://originrouter.com/install.ps1 | iex
```

The installer installs the CLI and starts the guided setup. Setup checks and,
after confirmation, installs missing Claude Code and Codex runtimes, the
OriginRouter background service, managed Python, and the Local Proxy runtime.

### Install from npm

Use npm when you need to manage the CLI version yourself:

```bash
npm install --global @originrouter/cli
originrouter setup
```

Requirements:

- Node.js 22 or later.
- Network access to npm and the official Claude Code and Codex installers.
- A Cloud account or model-service credentials are only needed for the route you choose later.

Local Proxy is included in the complete setup because it supports local,
third-party, enterprise, and self-hosted model services. If you only use
OriginRouter Cloud or already-authorized remote devices and do not need those
model-service routes, skip it explicitly:

```bash
originrouter setup --no-proxy
```

For automation, use `originrouter setup --yes`; preview the plan with
`originrouter setup --dry-run`. See the [CLI installation guide](https://originrouter.com/docs/originrouter-cli/overview)
for platform-specific details.

## Quick start

After installation, open a project and start the Agent Workspace:

```bash
cd your-project
originrouter
```

Submit an objective directly:

```bash
originrouter "Fix the login timeout and add regression tests"
```

Or keep the native Agent terminal:

```bash
originrouter claude
originrouter codex
```

To use OriginRouter Cloud routes, sign in and initialize them once:

```bash
originrouter login
originrouter agent setup --cloud
originrouter doctor
```

Use the native Agent configuration instead when you want to keep the official
Claude Code or Codex subscription, login state, environment, and project
configuration:

```bash
originrouter claude --native-config
originrouter codex --native-config
```

Read [CLI quickstart](https://originrouter.com/docs/originrouter-cli/quickstart)
for the complete first-run flow.

## What you can do next

### Coordinate larger tasks

The Agent Workspace keeps a long-lived conversation around a project. Use it
for planning, implementation, independent review, verification, and supported
cross-device work. Choose a mode with `--mode`, or switch inside the Workspace.

```bash
originrouter --mode plan-build-verify "Prepare and verify the migration"
```

See [Agent Workspace](https://originrouter.com/docs/originrouter-cli/agent-workspace)
and [multi-agent collaboration](https://originrouter.com/docs/originrouter-cli/collaboration).

### Connect a model service

Use Cloud routes for the simplest start. Use a local model service, enterprise
gateway, or self-hosted model when its credentials and network should remain on
your device. Configure it with `provider` and `route` commands; the Local Proxy
guide explains the available integrations.

See [models and routing](https://originrouter.com/docs/originrouter-cli/routing)
and the [model-service reference](https://originrouter.com/docs/originrouter-cli/providers-reference).

### Follow work from the App or another device

Install OriginRouter App, sign in, and connect a CLI device that is online and
trusted. The App can display sessions, deliver supported input, and handle
approvals. Remote model sharing and workspace access are separate permissions
that you enable only when needed.

See [remote access](https://originrouter.com/docs/originrouter-cli/remote),
[App overview](https://originrouter.com/docs/originrouter-app/overview), and
[devices and security](https://originrouter.com/docs/originrouter-app/devices-security).

## Common commands

| Goal | Command |
| --- | --- |
| Open the current project | `originrouter` |
| Run Claude Code | `originrouter claude` |
| Run Codex | `originrouter codex` |
| Check installation and connectivity | `originrouter doctor` |
| Initialize or repair the local runtime | `originrouter setup` |
| Sign in or sign out | `originrouter login` / `originrouter logout` |
| Manage model services | `originrouter provider` |
| Inspect routes | `originrouter route list` |
| Inspect devices and sessions | `originrouter devices` / `originrouter sessions` |
| Show every command and option | `originrouter help all` |

Run `originrouter --help` for the task-oriented overview.

## Security and data boundaries

- Workspace files, shell commands, tools, and Agent execution stay on the CLI device.
- The Local API requires a device key, including when it listens only on `127.0.0.1`.
- Remote control does not expose model-service credentials or grant workspace access by itself.
- Requests sent to Cloud or another model service follow that service's terms and data policy.

Read [data and execution boundaries](https://originrouter.com/docs/originrouter-concepts/data-boundaries)
and [SECURITY.md](SECURITY.md) for the full model.

## Documentation

- [CLI overview and installation](https://originrouter.com/docs/originrouter-cli/overview)
- [CLI quickstart](https://originrouter.com/docs/originrouter-cli/quickstart)
- [Agent Workspace](https://originrouter.com/docs/originrouter-cli/agent-workspace)
- [Models and routing](https://originrouter.com/docs/originrouter-cli/routing)
- [Command reference](https://originrouter.com/docs/originrouter-cli/commands)
- [CLI troubleshooting](https://originrouter.com/docs/originrouter-cli/troubleshooting)
- [OriginRouter App documentation](https://originrouter.com/docs/originrouter-app/overview)

For development setup and contribution rules, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Third-party products and license

OriginRouter is an independent open-source project. It is not affiliated with,
endorsed by, or sponsored by Anthropic or OpenAI. Claude Code and Codex remain
subject to their own accounts, licenses, terms, and policies.

AI-generated output and actions can be inaccurate or unsafe. Review them before
relying on or executing them.

OriginRouter is licensed under the [Apache License 2.0](LICENSE). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency and runtime notices.
