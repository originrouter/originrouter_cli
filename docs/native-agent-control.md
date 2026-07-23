# Native Claude and Codex remote control

This document is the canonical reference for starting the installed Claude
Code or Codex TUI through OriginRouter while keeping App remote control.

## Two launch modes

### OriginRouter-routed mode

The default wrapper behavior applies the configured OriginRouter model route
and still launches the native TUI:

```bash
originrouter claude
originrouter codex
```

### Native configuration mode

Use `--originrouter-native-config` when Claude/Codex should use the machine's
existing environment, authentication, selected model, and user/project config
instead of OriginRouter's model route:

```bash
originrouter claude --originrouter-native-config
originrouter codex --originrouter-native-config
```

`--originrouter-native` is an alias.

In native configuration mode OriginRouter does not:

- resolve or apply an OriginRouter Provider route;
- start the LiteLLM or Remote Coding proxy;
- acquire or inject an OriginRouter Coding token;
- override the agent's Base URL, API key, auth token, or model;
- inject `gpt-5.4` or `OPENAI_MODEL` into Codex.

OriginRouter still owns the wrapper PTY, session reporting, App message input,
conversation/history mirroring, interrupt/stop, and supported approval control.
Claude receives an additional temporary Hook settings file for remote event and
approval capture; Claude's normal user, project, and local settings continue to
load.

`--provider` cannot be combined with `--originrouter-native-config` because the
two options express conflicting provider ownership.

## Resume an existing session

### Claude Code

The installed Claude CLI declares the following option:

```text
-r, --resume [value]
```

Therefore both forms are supported through OriginRouter:

```bash
originrouter claude --resume da7a6062-aaef-4b1e-9bcf-c6a50a537e49
originrouter claude -r da7a6062-aaef-4b1e-9bcf-c6a50a537e49
```

With local Claude credentials and configuration:

```bash
originrouter claude \
  --originrouter-native-config \
  --resume da7a6062-aaef-4b1e-9bcf-c6a50a537e49
```

`-resume` is not a Claude option. Use `-r` or `--resume`.

### Codex

Codex uses a `resume` subcommand rather than a `--resume` option:

```bash
originrouter codex resume <session-id-or-name>
originrouter codex resume --last
```

With local Codex credentials and configuration:

```bash
originrouter codex --originrouter-native-config resume <session-id-or-name>
originrouter codex --originrouter-native-config resume --last
```

All native resume arguments are passed to the installed agent unchanged after
OriginRouter-specific flags are removed.

## Session identifier boundary

Claude's UUID, such as
`da7a6062-aaef-4b1e-9bcf-c6a50a537e49`, is the Claude conversation ID consumed
by `claude --resume`. It is not the OriginRouter wrapper `sessionId` used by
the App, relay, runtime heartbeat, and control commands. OriginRouter discovers
the resumed Claude UUID from Claude's SessionStart/transcript events and keeps
the two identifiers separate.

Codex likewise keeps its saved thread/session identifier separate from the
OriginRouter wrapper session ID.

## App control coverage

| Native command | Conversation/history | App message and interrupt | Structured approvals | Unattended execution |
| --- | --- | --- | --- | --- |
| `originrouter claude` | Yes | Yes | Yes, through Claude Hooks | Yes |
| `originrouter codex` | Yes | Yes | No, native Codex cannot attach its blocking approval channel | No |

Use `originrouter codex-terminal` when structured Codex approvals and
unattended approval handling are required. Managed sessions intentionally do
not support `--originrouter-native-config`; they require an explicit provider
environment.

Claude native configuration mode can be combined with the session-scoped
unattended policy:

```bash
originrouter claude \
  --originrouter-native-config \
  --originrouter-autonomy guarded \
  --resume da7a6062-aaef-4b1e-9bcf-c6a50a537e49
```

See [agent-autonomy.md](./agent-autonomy.md) for the guarded/full decision
boundary.

## Conversation detail profiles

The display profile controls how structured Claude/Codex activity is folded in
the App. It does not change what the Agent executes, what the CLI captures, or
the unattended execution policy.

| Profile | App presentation |
| --- | --- |
| `concise` | Conversation, blocking requests, errors, and one collapsed work summary per turn |
| `standard` | Concise view plus recent key plans, commands, file changes, and subagent milestones |
| `detailed` | All display-safe structured Agent events |

Raw PTY screen frames, spinners, cursor rewrites, and animation fragments are
not Agent protocol events and are excluded at every profile.

Set or inspect the installation default:

```bash
originrouter agent detail
originrouter agent detail set concise
originrouter agent detail set standard
originrouter agent detail set detailed
```

Override only the session being launched:

```bash
originrouter claude --originrouter-detail standard
originrouter codex --originrouter-detail=detailed
originrouter claude-terminal --originrouter-detail concise
originrouter codex-terminal --originrouter-detail standard
```

The effective value is resolved once at launch:

```text
--originrouter-detail > installed CLI default > built-in concise
```

The session reports both the effective profile and its source to the App.
Changing the installation default does not rewrite active or historical
sessions.

### App and API control

Proxy Control changes the selected device's installation default. For the
current machine the App prefers the daemon's direct local endpoint:

```http
PUT /agent/local/settings/detail
{"profile":"standard"}
```

For another signed-in device it uses the authenticated application bridge:

```http
PUT /app/v1/devices/{device_id}/local-control/agent-detail
{"profile":"standard"}
```

The server forwards `local_control.agent_detail.set` to that device. A daemon
heartbeat reports `agent_detail_profile`, allowing Proxy Control to show the
current default after reconnect. These paths update the installation default
only; they do not mutate already-running sessions.
