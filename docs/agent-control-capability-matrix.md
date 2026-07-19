# Agent control capability matrix

OriginRouter exposes one App protocol for Claude and Codex, but the native
terminal products do not expose the same integration surface as their managed
SDK/app-server runtimes. The CLI reports only capabilities it can actually
apply to the active process.

| CLI command | Conversation mirror | Tool/activity mirror | Blocking controls | Mode control | History source |
| --- | --- | --- | --- | --- | --- |
| `originrouter claude` | Yes | Yes | PermissionRequest, AskUserQuestion, ExitPlanMode, MCP form/URL | Display only | Claude transcript JSONL |
| `originrouter claude-terminal` | Yes | Yes | Tool permissions, questions, plan approval, MCP form/URL | Yes | Claude transcript JSONL |
| `originrouter codex` | Yes | Yes | Terminal input and interrupt only | Display only | Codex rollout JSONL |
| `originrouter codex-terminal` | Yes | Yes | Command/file/permission approval, user input, MCP form/URL | Yes | Live app-server events |

Unattended execution is supported by managed Claude, native Claude through
its Hook channel, and managed Codex. Native Codex reports the control as
unsupported because its running TUI cannot be attached to Codex app-server.
See [agent-autonomy.md](./agent-autonomy.md) for the guarded/full decision
boundary.

## Native provider configuration and resume

See [native-agent-control.md](./native-agent-control.md) for the canonical
contract covering OriginRouter-routed versus native configuration mode,
Claude/Codex resume syntax, session identifier boundaries, and App control
limitations.

## Native Codex limitation

`codex app-server` cannot attach to an already-running native Codex TUI
thread. Starting a second app-server process beside the TUI therefore does not
provide approvals for that TUI. OriginRouter uses the TUI's local rollout
JSONL for semantic mirroring and history, and reserves structured approval
control for the managed `codex-terminal` runtime.

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
