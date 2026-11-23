# Agent control capability matrix

OriginRouter exposes one App protocol for Claude and Codex, but the native
terminal products do not expose the same integration surface as their managed
SDK/app-server runtimes. The CLI reports only capabilities it can actually
apply to the active process.

| CLI command | Conversation mirror | Tool/activity mirror | Blocking controls | Mode control | History source |
| --- | --- | --- | --- | --- | --- |
| `originrouter claude` | Yes | Yes | PermissionRequest, AskUserQuestion, ExitPlanMode, MCP form/URL | Native confirmed control when observed | Claude transcript JSONL |
| `originrouter claude-terminal` | Yes | Yes | Tool permissions, questions, plan approval, MCP form/URL | Yes | Claude transcript JSONL |
| `originrouter codex` | Yes | Yes | Official TUI and App share command/file/permission approvals and questions on compatible launches | Display only | Codex rollout JSONL |
| `originrouter codex-terminal` | Yes | Yes | Command/file/permission approval, user input, MCP form/URL | Yes | Live app-server events |


Terminal `originrouter agy` and App-created agy share `agy-pty`: native TUI,
startup Hooks, transcript and a controlled PTY. Model/effort/mode changes restart
and resume the exact native conversation when fully idle. Questions, local/App
approvals, validated image-file references, text attachments and device MCP are
integrated. Generic native forms/URL panels and automatic interrupt-and-continue
are not advertised. Recorded ACP sessions retain their structured ACP runtime.
See [the current agy matrix](antigravity-feature-parity.md) and the three launch
comparisons in the READMEs. `--native-config` selects model configuration, not
TUI versus managed transport; Claude/Codex gateway model ownership is unchanged.

Unattended execution is supported by managed Claude, native Claude through
its Hook channel, and managed Codex. Native Codex uses Codex's own approval policy and supports manual answers from either device.
See [agent-autonomy.md](./agent-autonomy.md) for the guarded/full decision
boundary.

## Native provider configuration and resume

See [native-agent-control.md](./native-agent-control.md) for the canonical
contract covering OriginRouter-routed versus native configuration mode,
Claude/Codex resume syntax, session identifier boundaries, and App control
limitations.

## Native Codex terminal control

On compatible interactive launches, `originrouter codex` opens the official TUI
against a per-session, authenticated loopback bridge to one local Codex app-server.
The first answer from the terminal or App completes the original request.
The App can open a session while it is waiting and recover the pending card.
The rollout for the TUI's own thread supplies history and activity.

Run `node scripts/test-codex-native-live.mjs` to exercise the installed official
TUI with an isolated daemon and a scripted local model endpoint. Pass
`--native-config` to exercise a stable local provider and resume a saved thread.

Older Codex versions without authenticated `--remote`, explicit remote endpoints,
local-only launch options (including `--worktree`, `--add-dir`, `--profile`,
and `--no-daemon`), and noninteractive Codex subcommands use the existing native
launch path. These launches keep terminal input and interrupt; approvals stay in Codex.
Use `originrouter codex-terminal` for OriginRouter-managed unattended approval policies.

Both Codex runtimes still mirror non-blocking state. Native Codex reads the
rollout JSONL for messages, reasoning summaries, tools, web search, plan/goal
state, context compaction, settings changes, and rollback events. Managed
Codex additionally consumes the official app-server item/notification
protocol for plan progress, MCP/dynamic tools, collaboration subagents,
review mode, hooks, model reroutes, and thread status. Streaming deltas are
collapsed into their final item to avoid duplicate messages and event floods.

## Claude SDK boundary

The managed Claude runtime forwards the public SDK control surface:
`canUseTool`, `AskUserQuestion`, `ExitPlanMode`, MCP form/URL elicitation,
permission mode changes, interrupt, stop, hook lifecycle, background tasks,
compaction, retry, rate-limit, notification, memory-recall, and plugin/command
status events.

The SDK currently declares an internal `request_user_dialog` control frame
for product-specific dialogs such as computer-use setup, but exposes no public
callback that an SDK host can answer. OriginRouter does not claim remote
control for that private frame. It remains a local Claude Code interaction
until Anthropic exposes a supported responder API.

High-frequency partial assistant frames are not forwarded because the final
assistant message carries the same content and is used for stable deduplication.
Per-token thinking estimates are also omitted; `agent.thinking`, task progress,
and session state provide the user-visible progress signal without flooding the
App event stream.

## Transport and storage

- The App uses the local daemon first when the session is on the same device.
- Relay is the fallback for another logged-in device.
- Conversation and interaction payloads are transient; the application server
  stores display-safe session status and audit metadata only.
- History requests are served by the active CLI from its local transcript.
- Tool inputs are size-bounded and recursively redact credential-like fields
  before they enter either transport.

## Session lifecycle

`agent.task.complete` and `agent.task.aborted` end one turn, not the CLI
session. Only `session_completed`, `session_stopped`, and `session_failed`
close the session in the App.
