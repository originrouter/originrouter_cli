# OriginRouter Agent Protocol

This document is the **single source of truth** for the wire protocol that the local CLI, the relay, and any remote client (browser test page, mobile H5, native app) speak. Every event, endpoint, and field is defined here. If a producer or consumer diverges from this document, the document wins; update the code to match.

The protocol is in-memory only in v1. The relay does no authentication, no encryption, and no persistence beyond process lifetime. This is documented and called out in §6.

---

## 1. Session model

A "session" is a single conversation between a user and an agent (Claude Code, Codex, or a generic terminal). The relay tracks sessions in-memory; the CLI runs the agent process; the remote client attaches to a session by `sessionId`.

### Fields

| Field | Type | Source | Notes |
|---|---|---|---|
| `sessionId` | string | CLI-generated | OriginRouter-side identifier. Format depends on the launch path (see below). |
| `deviceId` | string | `~/.originrouter/device.json` | Defaults to `"local-dev"`. Identifies the local machine the CLI runs on. The relay uses this to know where to send `/client/permission`, `/client/input`, etc. |
| `agent` | string | `claude` / `codex` / `terminal` | Which agent runtime the CLI spawned. |
| `command` | string | CLI launch | The shell command, e.g. `"claude"` or `"bash"`. |
| `args` | string[] | CLI launch | Arguments passed to the agent (e.g. `["--settings", "/path/to/settings.json"]`). |
| `cwd` | string | `process.cwd()` at launch | The directory the agent runs in. The relay forwards this so the remote client can show "where" the session is. |
| `runtime` | string \| null | CLI launch | `null` for PTY route, `"claude-sdk"` for the Claude Agent SDK path, `"codex-app-server"` for Codex's app-server protocol. `null` is the v1 default for both `claude` and `codex` commands. |
| `executor` | string | CLI launch | The local executor: `pty` (default), `tmux`, or `pipe`. |
| `pid` | number | CLI launch | The OS process ID of the spawned agent. |
| `startedBy` | string | CLI launch | `"local-wrapper"` for the local path, `"local-sdk"` for the Claude Agent SDK path, `"remote"` for sessions started by the daemon path. |
| `startedAt` | ISO 8601 string | relay | When the session was registered. |
| `status` | `"running"` \| `"exited"` | relay | Set to `"exited"` when the agent process ends. |
| `exitedAt` | ISO 8601 string \| undefined | relay | When the session exited. |
| `code` | number \| null | relay | Process exit code (0 = clean, non-zero = error). |
| `signal` | string \| null | relay | Signal name if the agent was killed by a signal (e.g. `"SIGTERM"`). |

### `sessionId` formats

| Launch path | Format | Example |
|---|---|---|
| `originrouter claude` (local-wrapper) | `claude-<unix-ms>` | `claude-1781663360854` |
| `originrouter codex` (local-wrapper) | `codex-<unix-ms>` | `codex-1781663360123` |
| `originrouter claude-sdk` (SDK path) | `claude-sdk-<unix-ms>` | `claude-sdk-1781663370123` |
| Daemon-launched via `SessionManager.startSession` | `session-<unix-ms>` | `session-1781663380456` |
| Test page "Start Bash" button | `test-<unix-ms>` | `test-1781663390789` |
| User-supplied via `--originrouter-session=<id>` | As supplied | (any string) |

### `deviceId`

The CLI stores its `deviceId` at `~/.originrouter/device.json` on first run. If the file is missing, it is created with the default `"local-dev"`. The remote client hard-codes `deviceId = "local-dev"` in v1 because the relay accepts any string in `/client/permission`, `/client/input`, etc. — there is no auth.

### Claude sessionId (separate from OriginRouter's)

Claude Code has its own internal session id (a UUID), exposed via the `agent.session_id` event. The remote client can use this to show "Claude session: `aada10c6-9299-4c45-abc4-91db9c0f935d`" but should not confuse it with the OriginRouter `sessionId`. The Claude sessionId is what `--resume=<id>` takes; the OriginRouter sessionId is what the relay and remote client use.

---

## 2. Event stream

All events flow from CLI → relay (`POST /device/message`) → remote client (`GET /client/events`, optionally with `?sessionId=...&afterSeq=N` for replay).

### 2.1 Control-plane events (relay → all clients)

These are **not session-scoped** and are not buffered in `sessionEvents`. They are only sent to clients connected to the global stream (`/client/events` without `sessionId`).

#### `relay.ready`

Sent once when a client opens the global `/client/events` stream.

```json
{
  "type": "relay.ready",
  "devices": ["local-dev"],
  "sessions": [
    {
      "sessionId": "claude-1781663360854",
      "deviceId": "local-dev",
      "command": "claude",
      "args": ["--settings", "..."],
      "cwd": "/Users/.../originrouter-cli",
      "agent": "claude",
      "runtime": null,
      "executor": "pty",
      "pid": 69231,
      "startedBy": "local-wrapper",
      "status": "running",
      "startedAt": "2026-06-17T02:29:20.887Z"
    }
  ]
}
```

`devices` is `string[]` of currently-online device IDs. `sessions` is `Session[]` (see §1).

#### `device.online`

Broadcast when a CLI opens its `/device/events` SSE stream (i.e. when `originrouter claude` / `codex` / `daemon` connects).

```json
{ "type": "device.online", "deviceId": "local-dev" }
```

#### `device.offline`

Broadcast when the last SSE connection for a device closes.

```json
{ "type": "device.offline", "deviceId": "local-dev" }
```

#### `replay.done`

Sent at the end of a replay burst (only on the per-session stream).

```json
{ "type": "replay.done", "sessionId": "claude-1781663360854", "count": 5 }
```

`count` is the number of buffered events that were replayed. A count of 0 is normal for a session that has just started and has no buffered events yet.

### 2.2 Session-scoped events (relay → attached clients, buffered in `sessionEvents`)

Every payload sent on `/device/message` that has a `sessionId` is buffered per-session (cap 500, FIFO eviction) and given a monotonic `seq` field. The remote client sees these events with `seq` attached. See §5 for the replay protocol.

#### `session.started`

Emitted by the CLI when the agent process is spawned.

```json
{
  "type": "session.started",
  "sessionId": "claude-1781663360854",
  "command": "claude",
  "args": ["--settings", "/Users/.../session-hook-69230.json"],
  "cwd": "/Users/.../originrouter-cli",
  "agent": "claude",
  "runtime": null,
  "executor": "pty",
  "pid": 69231,
  "startedBy": "local-wrapper",
  "metadata": {
    "adapter": "claude",
    "projectPath": "/Users/.../.claude/projects/-Users-...-originrouter-cli",
    "structuredSources": ["claude-jsonl", "claude-hook"]
  }
}
```

For the Claude SDK path, `runtime` is `"claude-sdk"`, `executor` is `"sdk"`, `command` is `"claude-sdk"`, `startedBy` is `"local-sdk"`, and `metadata.adapter` is `"claude-sdk"`. The local client auto-attaches to the session when it sees this event with `startedBy: "local-wrapper"` or `startedBy: "local-sdk"`.

#### `session.exited`

Emitted by the CLI when the agent process ends.

```json
{ "type": "session.exited", "sessionId": "claude-1781663360854", "code": 0, "signal": null }
```

The session stays in `activeSessions` with `status: "exited"` so that the remote client can still browse historical sessions until the relay restarts.

#### `session.error`

Emitted by the CLI when the session fails to start (e.g. `claude` binary not found, hook setup failed).

```json
{ "type": "session.error", "sessionId": "claude-1781663360854", "message": "..." }
```

#### `terminal.output`

Raw bytes from the agent's PTY, forwarded verbatim including ANSI escapes. Not produced by the SDK path (SDK sessions have no PTY).

```json
{ "type": "terminal.output", "sessionId": "claude-1781663360854", "data": "..." }
```

#### `terminal.resize.local`

A local resize event (e.g. user resized the local terminal). For the remote client to know the new dimensions.

```json
{ "type": "terminal.resize.local", "sessionId": "claude-1781663360854", "cols": 120, "rows": 40 }
```

### 2.3 Agent events (nested in `agent.event`)

All structured agent events are wrapped in an `agent.event` envelope with the inner event under `.event`:

```json
{ "type": "agent.event", "sessionId": "...", "event": { /* one of the shapes below */ } }
```

This wrapping is because the relay treats `agent.event` as a single channel; consumers dispatch on the inner `event.type`.

#### `agent.session.start`

Emitted by the Claude PTY adapter when the SessionStart hook fires (i.e. when Claude Code itself starts). The `transcript_path` is the absolute path to Claude Code's JSONL transcript — the JSONL scanner reads this file going forward.

```json
{
  "type": "agent.session.start",
  "provider": "claude",
  "sessionId": "<claude-session-uuid>",
  "cwd": "/Users/.../project",
  "transcriptPath": "/Users/.../.claude/projects/.../<uuid>.jsonl",
  "raw": { /* full SessionStart hook payload */ }
}
```

#### `agent.session_id`

Emitted by the Claude Agent SDK adapter (and parsed from the JSONL transcript by the PTY scanner) when Claude Code reports its internal session id. Distinct from `agent.session.start` because the SDK reports it after init rather than via a SessionStart hook.

```json
{ "type": "agent.session_id", "provider": "claude", "sessionId": "<claude-session-uuid>" }
```

#### `agent.ready`

Emitted by the Claude Agent SDK adapter when the SDK has loaded and the session is ready to receive messages. Useful for the remote client to know it can start sending.

```json
{ "type": "agent.ready", "provider": "claude", "message": "Claude SDK session is ready. Send a message from the remote client." }
```

#### `user.text`

A user message, either typed into the local TUI (PTY path, parsed from the JSONL transcript) or sent from the remote client via `/client/message` (SDK path).

```json
{ "type": "user.text", "provider": "claude", "text": "list files in this directory" }
```

For the PTY path, the text is the actual `message.content` from a `type: "user"` JSONL entry. For the SDK path, the text is the `message` from `/client/message`.

#### `agent.text`

A text reply from Claude. The text is from `block.text` in the JSONL `type: "assistant"` content blocks, or the SDK's `assistant` message content.

```json
{ "type": "agent.text", "provider": "claude", "text": "I'll list the files..." }
```

#### `agent.thinking`

Claude's thinking content. The remote client can render this as a collapsible section or as a small "thinking…" status line.

```json
{ "type": "agent.thinking", "provider": "claude", "text": "<thinking>...</thinking>" }
```

#### `agent.tool_call.start`

A tool call. The `callId` is the tool-use id from the JSONL (or the SDK's `toolUseID`).

```json
{
  "type": "agent.tool_call.start",
  "provider": "claude",
  "callId": "toolu_1",
  "tool": "Bash",
  "input": { "command": "npm test", "cwd": "/Users/.../project" }
}
```

For the PTY path, the input is the `tool_use` block's `input` from the JSONL. For the SDK path, the input is the same shape.

#### `agent.tool_call.end`

A tool call's result. Pairs with `agent.tool_call.start` by `callId`. The remote client can match these to render "ok" / "error" pill status on the corresponding tool card.

```json
{
  "type": "agent.tool_call.end",
  "provider": "claude",
  "callId": "toolu_1",
  "content": "...",      // string or structured object
  "isError": false
}
```

#### `agent.permission.request.detected`

The user-facing signal that a permission prompt is waiting. The remote client renders this as a permission card with the four buttons (Approve / Approve Session / Deny / Abort). The `resolution` field tells the client how to send the decision.

```json
{
  "type": "agent.permission.request.detected",
  "provider": "claude",
  "callId": "claude-perm-1781663400000-a1b2c3d4e",
  "tool": "Bash",
  "input": { "command": "npm test", "cwd": "/Users/.../project" },
  "permissionSuggestions": [
    {
      "type": "addRules",
      "behavior": "allow",
      "rules": [{ "toolName": "Bash", "ruleContent": "npm test" }]
    }
  ],
  "resolution": {
    "eventType": "agent.permission.resolve",
    "decisions": ["approved", "approved_for_session", "denied", "abort"]
  }
}
```

The CLI emits this from two places:
- The Claude Agent SDK adapter: when `canUseTool` is called by the SDK, the CLI pushes this event and awaits a decision.
- The Claude PTY adapter: when the SessionStart hook configures a `PermissionRequest` hook, the CLI starts a small hook server, the hook fires, and the CLI pushes this event.

In both cases, the `callId` is unique per request and is what the client must send back.

#### `agent.permission.resolved`

The terminal state of a permission request. The remote client listens for this to update the card from `approving` to one of `approved` / `denied` / `aborted` / `timeout`.

```json
{
  "type": "agent.permission.resolved",
  "provider": "claude",
  "callId": "claude-perm-1781663400000-a1b2c3d4e",
  "decision": "approved" | "approved_for_session" | "denied" | "abort",
  "sessionRulePending": true | false,    // optional
  "reason": "timeout" | "error"          // optional
}
```

`sessionRulePending: true` means the decision was `approved_for_session` but the CLI did not actually register a session-level rule with Claude Code (v1 limitation — see §6). The remote client should show "Allow granted. Session rule not yet enforced (v1)."

`reason: "timeout"` means the CLI's 55s hook server timeout fired without a remote decision. `reason: "error"` is reserved for future use.

#### `agent.permission.resolve.error`

A failed attempt to resolve a pending permission — the callId was not in the pending map. The remote client can ignore this or show a "no matching request" notice.

```json
{
  "type": "agent.permission.resolve.error",
  "provider": "claude",
  "callId": "...",
  "message": "No pending Claude hook permission for this callId."
}
```

For the SDK path, the equivalent is `agent.permission.resolve.error` with `provider: "claude"` and `message: "No pending Claude SDK permission found for this callId."`

#### `agent.task.completed`

The Claude Agent SDK's terminal event for a turn. The PTY path doesn't have an exact equivalent — it can be inferred from the JSONL's `type: "result"` entries.

```json
{
  "type": "agent.task.completed",
  "provider": "claude",
  "subtype": "success" | "error_max_turns" | "...",
  "result": "...",
  "isError": false
}
```

---

## 3. Client actions

The remote client speaks to the relay via POST. The relay forwards structured events to the CLI via SSE on `/device/events`. The CLI translates these into local actions (PTY bytes, SDK message, hook decision).

### `POST /client/input`

Send raw terminal bytes to the PTY. Ignored for SDK sessions.

Request:
```json
{ "deviceId": "local-dev", "sessionId": "claude-...", "data": "ls\n" }
```

Response: `{ "ok": true }` if the device is connected, `{ "ok": false }` otherwise.

The relay forwards `{ "type": "terminal.input", "sessionId": "...", "data": "..." }` to the CLI's `/device/events` SSE. The CLI's PTY executor writes the bytes to the agent's stdin.

### `POST /client/message`

Send a user message to the SDK session. Used by the SDK path; also forwarded to the PTY path as a terminal input (with `\r` appended).

Request:
```json
{ "deviceId": "local-dev", "sessionId": "claude-sdk-...", "message": "list files" }
```

Response: `{ "ok": true }` or `{ "ok": false }`.

The relay forwards `{ "type": "agent.message", "sessionId": "...", "message": "..." }` to the CLI. The SDK adapter pushes the message onto its `AsyncMessageQueue`; the PTY adapter writes `${message}\r` to the agent's stdin.

### `POST /client/permission`

Resolve a pending permission request. The relay decides whether to translate the decision into terminal bytes (legacy PTY fallback) or pass it through structured (the new PermissionRequest hook path and the SDK path).

Request:
```json
{
  "deviceId": "local-dev",
  "sessionId": "claude-...",
  "callId": "claude-perm-...",  // present in the structured path
  "decision": "approved" | "approved_for_session" | "denied" | "abort",
  "data": "..."                 // optional raw bytes for the PTY fallback path
}
```

Behavior:
- If `callId` is present: relay forwards `{ "type": "agent.permission.resolve", "sessionId": "...", "callId": "...", "decision": "..." }` verbatim. The CLI's adapter (hook server or SDK `canUseTool`) resolves the pending promise.
- If `callId` is absent AND the session is PTY-Claude: relay translates `decision` → `1\r` / `2\r` / `3\r` / `\x1b` and forwards `{ "type": "agent.permission.resolve", "data": "<bytes>", "decision": "..." }`. The CLI's PTY executor writes the bytes to the agent's stdin.
- If `callId` is absent AND the session is not PTY-Claude: the relay forwards `decision` without translation. The CLI's adapter (Codex or SDK) handles it.

Response: `{ "ok": true }`.

### `POST /client/interrupt`

Send `SIGINT` to the PTY agent. For SDK sessions, calls the SDK's `abortController.abort()`.

Request: `{ "deviceId": "local-dev", "sessionId": "claude-..." }`. Response: `{ "ok": true }`.

### `POST /client/resize`

Forward a remote terminal resize to the PTY. The CLI's PTY executor calls `pty.resize(cols, rows)`. Ignored for SDK sessions.

Request: `{ "deviceId": "local-dev", "sessionId": "claude-...", "cols": 120, "rows": 40 }`. Response: `{ "ok": true }`.

### `POST /client/stop`

Force-kill the agent. The CLI's executor calls `executor.stop()`. Used when the user wants to abandon a session without exiting normally.

Request: `{ "deviceId": "local-dev", "sessionId": "claude-..." }`. Response: `{ "ok": true }`.

### `GET /client/sessions`

List all known sessions (running and exited, since relay startup).

Response:
```json
{
  "ok": true,
  "sessions": [ /* Session[] */ ]
}
```

The remote client uses this on page load to populate the session chip row.

### `GET /client/events`

Open an SSE stream. The query params control replay behavior (see §5).

Without query params: sends `relay.ready` once, then live-streams every broadcast event as it happens.

With `?sessionId=X&afterSeq=N`: sends `relay.ready` once, then replays buffered events for `X` with `seq > N`, then sends `replay.done { count }`, then live-streams.

### `POST /client/start`

Start a session on a device. **The relay rejects `command === "claude" || "codex"`** with a 400 — those must be started locally with `originrouter claude` / `originrouter codex`. This endpoint exists for generic terminal sessions (e.g. `bash`).

Request: `{ "deviceId": "local-dev", "sessionId": "test-...", "command": "bash", "args": [], "cwd": "...", "cols": 100, "rows": 30 }`. Response: `{ "ok": true, "sessionId": "..." }` or 400 if the command is rejected.

### `GET /health` and `GET /debug/events`

Unauthenticated diagnostics. `GET /health` returns `{ ok, devices, clients, sessions }`. `GET /debug/events` returns `{ ok, events: [...], sessions: [...] }` where `events` is the global `recentEvents` ring (cap 200, no replay). These are not for production use.

---

## 4. Permission lifecycle

The permission card on the remote client transitions through these states. Each transition is triggered by an event or a timeout.

```
                  user clicks button
   pending ───────────────────────────────► approving
                                              │
                                              │ /client/permission POST succeeds
                                              │ (state doesn't change yet — awaiting resolved)
                                              ▼
                          ┌──────────── agent.permission.resolved lands ────────────┐
                          ▼               ▼               ▼               ▼               ▼
                      approved         denied         aborted         timeout          error
```

### State meanings

| State | Pill color | Notes |
|---|---|---|
| `pending` | yellow (`pill` default) | Initial state when `agent.permission.request.detected` arrives. All four buttons enabled. |
| `approving` | yellow-orange (`pill.approving`) | Set by the client when the user clicks any button. Buttons disabled. A 60s client-side safety timer starts. |
| `approved` | green (`pill.ok`) | `agent.permission.resolved { decision: "approved" }` lands. Replaces actions with "Allow granted." note. |
| `denied` | red (`pill.err`) | `agent.permission.resolved { decision: "denied" }`. Note: "Denied." |
| `aborted` | dark red (`pill.err`) | `agent.permission.resolved { decision: "abort" }`. Note: "Aborted the current turn." |
| `timeout` | red (`pill.err`) | `agent.permission.resolved { reason: "timeout" }`. The CLI's 55s hook server timer fired. Note: "Remote approval timed out. Claude Code will surface the default deny." |
| `error` | red (`pill.err`) | Client-side 60s safety timer fired (no `agent.permission.resolved` ever landed) OR `/client/permission` POST failed. Note: "No agent.permission.resolved within 60s..." or "Failed to send decision: ..." |

### Triggers

| Trigger | Effect |
|---|---|
| `agent.permission.request.detected` | Card created with state `pending`. |
| User clicks a button | Card state → `approving`. Client starts 60s safety timer. POST `/client/permission`. |
| POST succeeds, awaiting `agent.permission.resolved` | State stays `approving`. |
| POST fails | State → `error`. Note: "Failed to send decision: ..." |
| `agent.permission.resolved` lands | State → `approved` / `denied` / `aborted` / `timeout`. Safety timer cleared. Note text depends on `decision` and `sessionRulePending`. |
| 60s safety timer fires (no resolved event) | State → `error`. Note: "No agent.permission.resolved within 60s. The decision may still reach Claude Code through the local Claude Code TUI." |

### Why two timers?

- **Hook server's 55s timer** (server side): Claude Code's matcher default is 60s; we use 55s so we always respond before Claude Code times us out. On fire: the hook server returns `{ behavior: "deny", message: "OriginRouter remote approval timed out..." }` to Claude Code AND pushes `agent.permission.resolved { reason: "timeout" }` to the remote client.
- **Client's 60s timer** (browser side): catches the case where the CLI sends the resolved event but the network drops it, or where the CLI is unreachable (e.g. the user closed their laptop lid mid-decision). The card flips to `error` so the user isn't stuck waiting.

### Approve Session v1

`decision: "approved_for_session"` is treated identically to `approved` on the wire. The CLI does NOT echo `permission_suggestions` back as `updatedPermissions` because the exact format is not yet confirmed against a live Claude Code session. The remote client receives `agent.permission.resolved { decision: "approved_for_session", sessionRulePending: true }` and shows "Allow granted. Session rule not yet enforced (v1)." When the format is confirmed, the helper that converts `permission_suggestions` to `updatedPermissions` can be enabled behind the same decision without changing the wire shape.

---

## 5. Replay mechanism

When a remote client (browser, mobile) opens or refreshes, it needs the conversation state from before the refresh. The relay's replay mechanism makes this possible without persisting anything to disk.

### The `seq` field

Every session-scoped event that passes through the relay gets a monotonic `seq` integer assigned in `remember()`. The seq is global (one counter across all sessions, not per-session). The seq is sent to the remote client in every event payload.

```json
{ "type": "user.text", "seq": 42, "at": "2026-06-17T02:30:01.123Z", "sessionId": "...", "text": "..." }
```

### The `sessionEvents` buffer

Per-session FIFO ring buffer in the relay. Cap: 500 events per session. Eviction: oldest first. The buffer is populated on every `broadcastToClients(...)` call. Control-plane events (`relay.ready`, `device.online`, `device.offline`) are NOT buffered.

### The `recentEvents` global buffer

Global FIFO ring. Cap: 200 events. Exposed via `GET /debug/events`. Used for debugging, not for replay.

### The replay endpoint

`GET /client/events?sessionId=X&afterSeq=N`

1. The relay sends `relay.ready { devices, sessions }` once.
2. The relay replays every buffered event for `X` with `seq > N`, in order.
3. The relay sends `replay.done { sessionId, count }`.
4. The relay continues to live-stream new events as they arrive.

The remote client can reattach to the same session and:
- Pass `afterSeq=0` to replay everything in the buffer.
- Pass `afterSeq=N` to replay only events it hasn't seen (the `N` it stored as `highestSeq` on its last connection).
- Pass no `sessionId` to get the global stream (no replay, just live events).

### Why no `afterSeq=0` race?

The replay and the live stream share the same SSE connection on the same response object. The relay writes replay events to the response, then continues holding the connection open for live events. There is no window where a new event can be broadcast between the replay read and the live subscription because JavaScript is single-threaded: the `broadcastToClients` loop iterates `clients` synchronously, and the replay path writes to the response before returning control to the event loop.

That said, a defense-in-depth measure: a remote client that connects with `afterSeq=0` and immediately receives a `replay.done { count: 0 }` knows the buffer was empty (or the session was just started) and that any events arriving after the `replay.done` SSE frame are live. A client that receives a `replay.done { count: 5 }` and then sees new events knows the new events have `seq > 5` and have not been seen.

### What gets lost on relay restart?

Everything. The relay process is the source of truth for the `sessionEvents` buffer. A relay restart wipes all session history. The CLI's `local-wrapper` mode still continues to work (the agent is running in the user's shell, not in the relay), but the remote client will see no replay after a relay restart until the CLI pushes new events.

This is documented as a v1 limit in §6. The fix is server-side persistence (SQLite or a JSON file at `~/.originrouter/relay-state.json`) and is on the backlog.

---

## 6. Current limits

These are known limits of the v1 protocol. They are documented so consumers don't rely on behavior that isn't there.

### 6.1 No authentication

The relay accepts any `deviceId` in the request body. `GET /client/events`, `GET /client/sessions`, `GET /health`, `GET /debug/events` are all unauthenticated. CORS is `Access-Control-Allow-Origin: *`. The relay is suitable for localhost-only use. Do not expose it to a public network.

**Mitigation in production**: add a bearer token check on every endpoint. The CLI reads the token from `~/.originrouter/auth-token` and sends it as `Authorization: Bearer <token>`. The remote client prompts the user to paste the token (or scans a QR code containing it). This is on the Stage 6 backlog.

### 6.2 No persistence

The relay's `sessionEvents`, `recentEvents`, `activeSessions`, and `devices` are all in-memory. A restart wipes:
- All session history (so a remote client connecting after a restart gets no replay).
- All device / session tracking (so the remote client sees no sessions until the CLI pushes a new `session.started`).

The CLI's `~/.originrouter/sessions.jsonl` does persist a record of past sessions, but the relay doesn't read it.

**Mitigation in production**: SQLite or a JSON-on-disk store. The CLI also has `--resume` support but it goes to Claude Code directly, not through the relay.

### 6.3 Approve Session does not actually persist rules

`approved_for_session` is treated as `approved` in v1. The CLI does not write `updatedPermissions` back to Claude Code's session config. If the user clicks "Approve Session" and then triggers the same tool again, they will be prompted again.

**Mitigation in production**: enable the helper that converts `permission_suggestions` to `updatedPermissions` once the exact wire format is confirmed. This is a 5-line code change behind a feature flag; the wire shape between the remote client and the CLI does not change.

### 6.4 Codex is not structured

`originrouter codex` runs the Codex CLI in a PTY and emits `agent.possible_permission` events based on keyword sniffing of the terminal output ("approval" / "permission"). The actual permission flow is a terminal prompt the user answers with arrow keys + Enter inside the embedded xterm. The four-button permission card does not appear for Codex.

**Mitigation in production**: build the Codex `app-server` adapter. The `CodexAppServerClient` already exists and has a `pendingApprovals` Map; what is missing is the wiring from `appServerClient.onApproval` to a structured `agent.permission.request.detected` event. The Codex app-server approval message format is unverified against a live Codex install; do not ship until verified.

### 6.5 Daemon path is not the primary path

`originrouter daemon` is implemented and works (it accepts `session.start` events from the relay and dispatches them to the appropriate agent), but the product direction is "user runs `originrouter claude` locally, remote client attaches by sessionId." The daemon path is a PoC for "what if the user wants to start sessions from the browser" and is not part of the primary flow.

If the daemon path is used, `SessionManager.startSession` still routes `command === "claude"` through `runLocalAgentSession` (PTY path) — not the SDK. Bringing the daemon path to the SDK is on the backlog.

### 6.6 Mobile clients (H5, native) not built

The protocol is designed mobile-friendly (no terminal bytes in any of the structured events, no large blobs, no binary protocols), but the only consumer today is the test page (`originrouter-test/index.html`). The H5 landing point is `/app/session/:sessionId` and is on the next-batch backlog.

### 6.7 Event names are not yet stable

The event names in §2.3 are stable in v1. Renames (e.g. `agent.permission.request.detected` → `agent.permission.request`) are intentionally deferred until the H5/native clients start consuming the protocol, so we only rename once across all consumers.

---

## 7. Daemon local API (Stage 3)

`originrouter daemon` runs an HTTP API bound to **127.0.0.1 only**. This is the same-process control surface for the local OriginRouter daemon — what Flutter App / browser test pages consume when running on the same machine as the daemon.

The API binds 127.0.0.1 (no LAN exposure). CORS is permissive (`Access-Control-Allow-Origin: *`). All of this is acceptable for the local-only deployment; production-grade security is Stage 6.

> **apiKey rule (Stage 5).** `PUT /providers/:name` accepts an empty `apiKey` to mean "keep the current key". There is no way to clear a key in v1 other than delete + re-add. The server never returns the raw key — only the masked form from `summarizeProvider()`.

### 7.1 Local API authentication (Stage 6)

All write endpoints require a bearer token. Read endpoints (`GET /local/status`, `GET /health/liveliness`, `GET /local/auth/challenge`) are public. **`GET /proxy/logs` is also authenticated** because the log file may contain user PII / API keys.

**Token file**: `~/.originrouter/local-api.token` (mode 0o600). Contains a single 64-hex-char string. Auto-generated on first daemon start. Rotate with `originrouter token rotate`.

**Header**: `Authorization: Bearer <64-hex>`

**Discovery**:
- `GET /local/auth/challenge` (public) returns `{ ok, authRequired, tokenFile }`. Used by the browser to detect "no-daemon" vs "token-mismatch" without leaking the token.
- `originrouter daemon print-url` prints the full URL with the token inlined.
- `originrouter token rotate` mints a new token and prints the new full URL.

**Error responses**:
| Status | Body | When |
|---|---|---|
| 401 | `{ ok: false, error: "unauthorized", reason: "missing" }` | No Authorization header on a write request. |
| 401 | `{ ok: false, error: "unauthorized", reason: "malformed" }` | Header doesn't match `^Bearer\s+[a-f0-9]{64}$`. |
| 401 | `{ ok: false, error: "unauthorized", reason: "invalid" }` | Token doesn't match. |
| 503 | `{ ok: false, error: "auth-not-initialized" }` | Token file is missing — usually means a developer booted the local API in isolation (not via `startDaemon`). The 503 hints the user to start the daemon. |

All 401/403 responses include `WWW-Authenticate: Bearer realm="originrouter-local"`.

**Dev escape hatch** (DANGER: dev-only): set `ORIGINROUTER_DEV_INSECURE=1` to skip auth entirely. Used by isolated unit tests. Never set this in production.

**CORS**: `Access-Control-Allow-Headers: Content-Type, Authorization` (was just `Content-Type` before Stage 6).

### 7.2 Flutter client discovery contract

A Flutter client running on the same machine as the daemon discovers the local API via this exact sequence:

1. Read `~/.originrouter/daemon.state.json` to get `localApiPort`.
2. Read `~/.originrouter/local-api.token` (mode 0o600) to get the token.
3. Read `~/.originrouter/device.json` to get `deviceId`.
4. Read `~/.originrouter/daemon.state.json.relayUrl` for the relay URL.
5. Construct the API base: `http://127.0.0.1:<localApiPort>`.
6. Send `Authorization: Bearer <token>` on every write.

The `deviceId` and `relayUrl` are also reported in `GET /local/status` (`daemon.deviceId`, `relay.url`), so a client that already has a working token can refresh them from the API.

### 7.3 Proxy lifecycle reconciliation (Stage 6)

The proxy state file (`proxy.state.json`) and the running process are reconciled on every `status()` call:

- **`status()` self-heals** stale state — if the recorded pid is dead, it clears the file and returns `state: "stopped"`.
- **`start()` runs `status()` first** so it never refuses to start over a dead-but-recorded process.
- **`child.on("exit")` persists `lastExitReason*`** to the state file before clearing it, so the next `status()` call can surface whether the previous run crashed or stopped gracefully.
- **`stop()` synthesizes `lastExitReason: "stopped"`** before clearing.

The `lastExitReason` field on `GET /proxy/status` is one of `"crashed"` / `"stopped"` / `null`. `crashed` is set when the child exited with a non-zero code OR was killed by a signal in `{SIGKILL, SIGSEGV, SIGABRT, SIGBUS, SIGILL}`. SIGTERM (a graceful stop) is not a crash.

### Endpoints

| Method | Path | Returns | Notes |
|---|---|---|---|
| GET | `/local/status` | `{ ok, daemon: { pid, version, deviceId, startedAt, uptimeSeconds, port }, relay: { url, connected }, proxy: { state, port, version, pid, currentProvider, startedAt, configPath, logPath, lastExitReason, lastExitCode, lastExitSignal, lastExitAt, note? } } | Public. The nested `proxy` field is the real `ctx.getProxyStatus()` shape (Stage 4+). |
| GET | `/local/auth/challenge` | `{ ok: true, authRequired: true, tokenFile: string }` | **Stage 6.** Public probe. Returns 200 with the token file path so a client can detect "no-daemon" vs "token-mismatch" without leaking secrets. |
| GET | `/catalog/litellm-providers` | `{ ok, providers: LiteLLMProfile[] }` | **Stage 7.** Public. Returns the static 34-entry catalog (id, label, prefix, modelPlaceholder, litellmParams, fields[], flags?, help?). Documented exception to Stage 6 deny-by-default; see §9.5. |
| GET | `/proxy/logs?tail=200` | `{ ok, path, lines, content }` | **Stage 6.** Returns the last N lines of the proxy log. `tail` defaults to 200, max 2000. 1 MiB read cap (last 1 MiB if the file is larger). 404 if no `logPath` in `proxy.state.json`. 400 if `tail` is not a positive integer. **Requires bearer token** (logs may contain PII). |
| GET | `/providers` | `{ ok, providers: ProviderSummary[] }` | List all providers with masked apiKey. Each entry has a `current: { claude, codex }` map. |
| GET | `/providers/:name` | `{ ok, provider: ProviderSummary }` | Single provider. 404 if not found. |
| POST | `/providers` | `{ ok, provider: ProviderSummary, warnings?: Warning[] }` | **Stage 5.** Body: `{ name, type, baseUrl, apiKey, model, smallFastModel?, litellmProvider?, apiVersion?, awsRegion?, awsAccessKeyId?, awsSecretAccessKey?, awsSessionToken?, awsProfileName?, vertexProject?, vertexLocation?, googleApplicationCredentials?, hfToken? }`. `type` must be `anthropic` or `litellm`. **Stage 7:** `type=openai-compatible` returns 400 with migration message. 400 on validation, 409 on duplicate name, 500 on read/write failure. **Stage 6: requires bearer token.** |
| PUT | `/providers/:name` | `{ ok, provider: ProviderSummary, warnings?: Warning[] }` | **Stage 5.** Same body shape as POST, all fields optional. `apiKey: ""` keeps current. **Stage 7:** legacy `openai-compatible` records auto-migrate to `litellm/custom_openai` unless the patch carries `type=openai-compatible` explicitly. `smallFastModel` on a litellm record is dropped and emitted as a `warnings[]` entry. **Stage 6: requires bearer token.** |
| DELETE | `/providers/:name` | `{ ok, removed: string }` | **Stage 5.** 404 if name missing. **Stage 6: requires bearer token.** |
| POST | `/providers/use` | `{ ok, current, setProvider, setAgent, forced }` | Body: `{ name, agent, force? }`. 409 if openai-compatible + claude without force. **Stage 6: requires bearer token.** |
| GET | `/proxy/status` | `{ state, port, version, pid, currentProvider, startedAt, configPath, logPath, lastExitReason, lastExitCode, lastExitSignal, lastExitAt, note? }` | **Stage 4 + Stage 6.** Public. `lastExitReason` is `"crashed"` / `"stopped"` / `null`. |
| POST | `/proxy/start` | `{ ok, state: "running", port, pid, provider, version, configPath, logPath }` | **Stage 4.** Body: `{ provider, port }`. 400 on bad input, 409 if already running, 409 if not installed. **Stage 6: requires bearer token.** |
| POST | `/proxy/stop` | `{ ok, state: "stopped", pid }` | **Stage 4.** Idempotent. **Stage 6: requires bearer token.** |
| POST | `/proxy/restart` | `{ ok, state: "running", ... }` | **Stage 4.** **Stage 6: requires bearer token.** |
| GET | `/sessions` | `{ ok, sessions: SessionView[] }` | Public. Live sessions from `SessionManager.sessions`. |
| POST | `/sessions/:id/input` | `{ ok, sessionId, action: "input" }` | Body: `{ data: string }`. **Stage 6: requires bearer token.** |
| POST | `/sessions/:id/interrupt` | `{ ok, sessionId, action: "interrupt" }` | **Stage 6: requires bearer token.** |
| POST | `/sessions/:id/permission` | `{ ok, sessionId, action: "permission" }` | Body: `{ callId, decision, data? }`. **Stage 6: requires bearer token.** |

All write endpoints (`/sessions/:id/{input,interrupt,permission}`) call **`sessionManager.handleEvent(payload)` directly** — the same entry point the daemon uses when handling events from the relay. They do NOT route through `relayClient.send()`. The local API runs in the same process as the session manager; routing through the relay would loop back through `connectEvents` SSE and cost a round trip for nothing.

### Discovery

`originrouter daemon` writes `localApiPort` to `~/.originrouter/daemon.state.json`. The CLI command `originrouter daemon-port` reads the file and prints `http://127.0.0.1:<port>`. Browser clients accept the URL as `?daemon=127.0.0.1:<port>` query param. The local API port is OS-assigned by default; pin it with `--local-port <p>` on the daemon command line.

### Bind safety

`startLocalApi()` rejects any `bindAddress` not in `{127.0.0.1, ::1, localhost}` BEFORE attempting to listen. This guard exists so a future internal caller cannot accidentally open the daemon to the LAN. Tests assert that `0.0.0.0`, `192.168.x.x`, etc. all throw.

### CORS

Single set of headers on every response (including OPTIONS preflight):

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
```

OPTIONS preflight returns 204 with `Access-Control-Max-Age: 600`.

### Producer-consumer mapping

| API endpoint | Code path | Existing module reused |
|---|---|---|
| `GET /local/status` | `handleLocalStatus` (async) | reads `liveCtx` + **`ctx.getProxyStatus()`** (real probe since Stage 5; placeholder in test ctx) |
| `GET /providers` | `handleProvidersList` | `listProviders()` from `src/config/providers.js`, augmented with `current` |
| `GET /providers/:name` | `handleProviderShow` | `showProvider()` |
| `POST /providers` | `handleProviderAdd` | `addProvider()` + `writeConfig()` from `src/persistence/state.js` |
| `PUT /providers/:name` | `handleProviderUpdate` | `applyProviderUpdate()` from `src/config/providers.js` (enforces the empty-apiKey-keeps-current rule) |
| `DELETE /providers/:name` | `handleProviderRemove` | `removeProvider()` + `writeConfig()` |
| `POST /providers/use` | `handleProvidersUse` | `setCurrentProvider()` + `writeConfig()` |
| `GET /proxy/status` | inline `await ctx.getProxyStatus()` | real probe (`ProxyManager.status()`); `placeholderProxyStatus()` is the test fallback |
| `GET /sessions` | `handleSessionsList` | `projectSession()` helper |
| `POST /sessions/:id/input` | `handleSessionControl("input")` | `sessionManager.handleEvent({ type: "terminal.input", ... })` |
| `POST /sessions/:id/interrupt` | `handleSessionControl("interrupt")` | `sessionManager.handleEvent({ type: "terminal.interrupt", ... })` |
| `POST /sessions/:id/permission` | `handleSessionControl("permission")` | `sessionManager.handleEvent({ type: "agent.permission.resolve", ... })` |

---

## 8. LiteLLM proxy wire (Stage 4)

When the user runs `originrouter proxy start --provider deepseek`, the daemon's `ProxyManager` writes a `config-<provider>.yaml` like:

```yaml
model_list:
  - model_name: deepseek
    litellm_params:
      model: openai/deepseek-chat
      api_key: "sk-ds-..."
      api_base: "https://api.deepseek.com/v1"
litellm_settings:
  drop_params: true
```

Then it spawns `python -m litellm --config <path> --host 127.0.0.1 --port <port>`, polls `GET http://127.0.0.1:<port>/health/liveliness` until 200 OK or 15s timeout, and on success writes `~/.originrouter/proxy.state.json` with the bound port + pid + provider.

When the user runs `originrouter claude --provider deepseek` (or `provider use deepseek --agent claude` + `originrouter claude`), the launchers call `buildAgentProviderEnv("claude", config, { provider: "deepseek", proxyStatus })`. If `proxyStatus.state === "running"` and `proxyStatus.currentProvider === "deepseek"`, the function returns:

```js
{
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:<port>",
    ANTHROPIC_API_KEY: "sk-noop-litellm-passthrough",  // placeholder; LiteLLM does not validate this
    ANTHROPIC_MODEL: "<provider.model>",
    ANTHROPIC_SMALL_FAST_MODEL: "<provider.smallFastModel>" // if set
  },
  provider,
  source,
  proxy: proxyStatus,
}
```

The PTY inherits this env alongside `process.env`. Claude Code sends requests to `ANTHROPIC_BASE_URL` (the LiteLLM proxy); LiteLLM translates Anthropic format to OpenAI format and forwards to `provider.baseUrl` with `provider.apiKey`. The `ANTHROPIC_API_KEY` placeholder is never validated by LiteLLM, so the user's real DeepSeek key stays in `config-<provider>.yaml` and never enters Claude Code's process environment.

**No silent fallback**: when the proxy is `not-installed` / `stopped` / `running for a different provider`, `buildAgentProviderEnv` throws `PROVIDER_UNSUPPORTED` with a clear hint to run `originrouter proxy install` and `originrouter proxy start --provider <name>`. The user always knows why their session didn't launch.

**Bind safety**: the proxy always binds 127.0.0.1. `startLocalApi` and `ProxyManager.start` both refuse non-loopback bind addresses before listening.

---

## Appendix A: Quick reference

### Event types by producer

| Producer | Events |
|---|---|
| `localAgentSession` (PTY) | `session.started`, `session.exited`, `session.error`, `terminal.output`, `terminal.resize.local`, `agent.event` wrapping the JSONL scanner's output |
| `claude/jsonlScanner.js` | `agent.event` wrapping `user.text`, `agent.text`, `agent.thinking`, `agent.tool_call.start`, `agent.tool_call.end` |
| `ClaudeAdapter` (hook) | `agent.event` wrapping `agent.session.start` (from SessionStart hook), `agent.permission.request.detected` (from PermissionRequest hook), `agent.permission.resolved` (on local resolve or 55s timeout) |
| `claudeSdkSession` (SDK) | `session.started`, `session.exited`, `agent.event` wrapping `agent.ready`, `agent.text`, `agent.thinking`, `agent.tool_call.start`, `agent.tool_call.end`, `agent.permission.request.detected`, `agent.permission.resolved`, `agent.task.completed`, `user.text` |
| `CodexAdapter` | `agent.event` wrapping `agent.possible_permission` (keyword-sniffed) and `agent.adapter.status` (app-server availability) |
| Relay | `relay.ready`, `device.online`, `device.offline`, `replay.done` |

### Endpoint summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Diagnostics. No auth. |
| GET | `/debug/events` | Global recent-events ring. No auth. |
| GET | `/client/sessions` | List all sessions. |
| GET | `/client/events` | Open SSE. Optional `?sessionId=X&afterSeq=N` for replay. |
| POST | `/client/start` | Start a session on a device. Rejects `claude` / `codex`. |
| POST | `/client/input` | Send raw terminal bytes. |
| POST | `/client/message` | Send a user message. |
| POST | `/client/permission` | Resolve a permission request. |
| POST | `/client/resize` | Forward a remote PTY resize. |
| POST | `/client/interrupt` | Send SIGINT / abort. |
| POST | `/client/stop` | Force-kill the agent. |
| GET | `/device/events?deviceId=X` | CLI's persistent SSE for receiving remote actions. |
| POST | `/device/message` | CLI's channel for broadcasting events. |

## 9. Provider catalog (Stage 7 + 7.7)

### 9.1 Core routing rule (Stage 7.6: single path)

OriginRouter has one canonical provider shape, post-Stage 7.6:

- `type=litellm` — **the only writable type.** The provider record carries `litellmProvider` (one of the 34 catalog ids). The proxy YAML is rendered from the catalog profile.
- `type=anthropic` and `type=openai-compatible` are **legacy read-projection only**. They are auto-migrated to `type=litellm, litellmProvider=anthropic|custom_openai` on the next `PUT /providers/:name` or `provider update` save. Direct paths were removed in Stage 7.6 — Claude Code always goes through the local LiteLLM proxy.

### 9.2 Field metadata (Stage 7.7)

Each catalog field carries a richer schema than before. The renderer / validator / UI / CLI all consult this single source.

| Metadata key | Effect |
|---|---|
| `key` | camelCase key on the provider record (`apiKey`, `awsRegion`, …). |
| `litellmParam` | snake_case YAML key in `litellm_params`. |
| `label` | UI label / `provider show` row label. |
| `type` | input type (`text` or `password`). |
| `required` | save-time check: throw when blank. **Reserved for the rare field with NO env fallback** (e.g. `custom_openai.baseUrl`, `azure.baseUrl`, `azure_ai.baseUrl`, `litellm_proxy.baseUrl`). |
| `runtimeRequired` | runtime check: doctor warns + proxy-start surfaces provider + field hint when blank AND `envVar` unset in `process.env`. Save still succeeds. |
| `secret` | masked in summarize / list / API responses. Drives input type = `password`. |
| `envVar` | UI hint chip text. Multi-env strings (`AWS_REGION_NAME / AWS_REGION`) are UI hints only; env-refs in values accept exactly one var. |
| `omitIfBlank` | field omitted from YAML when blank (default for every optional field). |
| `advanced` | rendered under "Advanced" section in the UI; still saved/updated. |
| `showOnlyIf: "inlineCreds"` | only rendered when the form's local `inlineCreds` checkbox is true (Bedrock / SageMaker inline creds). |
| `placeholder` | input placeholder; defaults to `os.environ/<first env var>` when only `envVar` is set. |
| `help` | long-form hint rendered under the input. |

### 9.3 Env-reference syntax

Any string value may be an env reference. The shape is:

```
os.environ/VAR_NAME
```

- `VAR_NAME` must match `/^[A-Za-z_][A-Za-z0-9_]*$/` (a single env-var name).
- Anything that starts with `os.environ/` but doesn't match the regex is **rejected** (e.g. `os.environ/`, `os.environ/A B`, `os.environ/1foo`, `os.environ/A/B`).
- The shell variable name is stored **verbatim** — OriginRouter does not perform substitution; LiteLLM reads the env itself at startup.
- The multi-env strings in `envVar` (e.g. `AWS_REGION_NAME / AWS_REGION / AWS_DEFAULT_REGION`) are UI hints only — the env-ref syntax accepts exactly one var per field.

Example:

```bash
originrouter provider add bedrock-irsa --litellm-provider bedrock \
  --aws-region os.environ/AWS_REGION_NAME \
  --aws-role-name arn:aws:iam::123456789012:role/MyBedrockRole \
  --aws-web-identity-token os.environ/AWS_WEB_IDENTITY_TOKEN_FILE \
  --model anthropic.claude-3-5-sonnet-20241022-v2:0
```

The rendered YAML contains `aws_region_name: "os.environ/AWS_REGION_NAME"`, etc.

### 9.4 Provider record schema

The full stored record (Stage 7.7) carries:

| Field | Notes |
|---|---|
| `name` | URL-safe identifier; `/^[a-z0-9][a-z0-9_-]{0,31}$/` |
| `type` | `litellm` only (legacy `anthropic` / `openai-compatible` are read-projected and auto-migrate on save) |
| `litellmProvider` | catalog id (34 options) |
| `model` | provider-specific model name (always required) |
| `smallFastModel` | **[legacy]** optional. Kept on disk for backward compatibility. No longer seeds `routes.claude.small`; use `POST /routes/claude/small` or `originrouter route set claude.small --provider <name>` instead. The new provider form does not surface the field; `provider show` annotates it `(legacy; routes.claude.small is source of truth)`. |
| `baseUrl` | `api_base` for providers that read it |
| `apiKey` | masked in all outputs; runtimeRequired for most providers |
| `authToken` | Anthropic Bearer-auth path; runtimeRequired never (apiKey suffices) |
| `organization` | OpenAI `organization` |
| `apiVersion` | `api_version` for Azure / Azure AI |
| `azureAdToken` | Azure AD token; advanced; masked |
| `awsRegion` | bedrock / sagemaker; runtimeRequired (env chain satisfies) |
| `awsAccessKeyId` / `awsSecretAccessKey` / `awsSessionToken` | inline AWS creds; masked |
| `awsProfileName` | takes precedence over inline keys when set |
| `awsBedrockRuntimeEndpoint` | override Bedrock runtime URL (private VPC endpoint, FIPS) |
| `awsRoleName` / `awsSessionName` / `awsStsEndpoint` | IRSA-style; advanced |
| `awsWebIdentityToken` | masked; advanced |
| `sagemakerBaseUrl` | override SageMaker runtime URL; advanced |
| `vertexProject` / `vertexLocation` | runtimeRequired |
| `vertexCredentials` | inline service-account JSON; masked |
| `googleApplicationCredentials` | file path; masked |
| `hfToken` | legacy alias; HF now uses `apiKey` directly |

Every entry above is the camelCase form of a catalog field key; the catalog defines the `litellmParam` mapping. Stage 7.7's strict unknown-field rejection means any key not in this table (for the chosen `litellmProvider`) is rejected at save time.

### 9.5 Catalog ids (34)

Grouped by family:

- **OpenAI-family** — anthropic, openai, custom_openai, azure, azure_ai
- **Cloud managed** — bedrock, sagemaker, vertex_ai, gemini
- **Single-key APIs** — deepseek, openrouter, groq, together_ai, fireworks_ai, xai, mistral, cohere, perplexity, huggingface
- **Local servers** — ollama, ollama_chat, lm_studio, vllm, hosted_vllm, litellm_proxy
- **Chinese vendors** — minimax, dashscope, moonshot, volcengine, modelscope, zai
- **GitHub** — github, github_copilot
- **Aliases** — qwen-via-dashscope (label-only alias of dashscope)

`github_copilot` carries `flags: ["advanced", "schema-only"]`. **The real OAuth / device-flow handshake is not implemented in Stage 7**; the schema is real, but the proxy will fail at runtime if the api key isn't a valid GitHub Copilot token.

`qwen-via-dashscope` renders as `dashscope/<model>` (the source profile owns the prefix). It does not have its own `litellm_params` shape.

`amazon_nova` is intentionally **not** in the catalog — it's a model preset of `bedrock`. Users add `bedrock` and set `model: amazon.nova-lite-v1:0`.

### 9.6 Migration rule

Read path: `GET /providers` and `GET /providers/:name` project legacy `openai-compatible` records to `{ type: "litellm", litellmProvider: "custom_openai", _legacy: true }` for display. Disk is untouched.

Write path: `POST /providers` rejects `type=openai-compatible` with `400 type 'openai-compatible' is no longer supported`. `PUT /providers/:name` on a legacy record with no explicit legacy `type` in the patch auto-migrates the disk record to the new shape; with explicit `type=openai-compatible` it rejects.

### 9.7 Why `GET /catalog/litellm-providers` is public

Stage 6 made the local API deny-by-default with a bearer token. `GET /catalog/litellm-providers` is an explicit, documented exception: it returns a static catalog array with no user state and no secrets, and the browser console depends on loading it on cold start before the user has typed a token. This is the only public endpoint besides `GET /local/auth/challenge`. Future security audits may flag it as inconsistent with the deny-by-default model; the rationale is recorded here.

### 9.8 Worked example: Bedrock with IRSA env refs

Plain keys:
```bash
originrouter provider add bedrock-anthropic \
  --type litellm --litellm-provider bedrock \
  --aws-region us-east-1 \
  --model anthropic.claude-3-5-sonnet-20241022-v2:0
```

Rendered YAML:
```yaml
model_list:
  - model_name: bedrock-anthropic
    litellm_params:
      model: bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0
      aws_region_name: "us-east-1"
litellm_settings:
  drop_params: true
```

IRSA-style with env refs (Stage 7.7):
```bash
originrouter provider add bedrock-irsa \
  --type litellm --litellm-provider bedrock \
  --aws-region os.environ/AWS_REGION_NAME \
  --aws-role-name arn:aws:iam::123456789012:role/MyBedrockRole \
  --aws-web-identity-token os.environ/AWS_WEB_IDENTITY_TOKEN_FILE \
  --aws-bedrock-runtime-endpoint https://vpce-xxx.bedrock-runtime.us-east-1.vpce.amazonaws.com \
  --model anthropic.claude-3-5-sonnet-20241022-v2:0
```

The advanced fields are rendered only when set; LiteLLM/boto3 reads the env at startup. The shell variable name is stored verbatim — nothing is substituted by OriginRouter.

Add inline AWS credentials with `--aws-access-key-id` / `--aws-secret-access-key`; without them LiteLLM/boto3 falls back to env / profile / SSO / instance role.

### 9.9 Security note

AWS secret keys / GCP service-account JSON paths are persisted to `~/.originrouter/config.json` (mode `0o600`) only when the user explicitly provides them. For shared or root-access hosts, leave the fields empty and let LiteLLM/boto3 use instance/container role credentials. All secret fields are masked via `maskSecret()` in CLI / HTTP API output.

## 10. Model routes (Stage 7.5 + 7.6 + 7.8 + 7.9 + 8.0: routes owned by the routes layer for both Claude and Codex; Codex only has main)

Stage 7.5 introduced a **Route** layer. Stage 7.6 collapses the entire provider system to a single path: every Claude Code session goes through the local LiteLLM proxy and two fixed alias names that never change. There is no direct path for Claude.

Stage 8.0 extends this contract to **Codex** with a third alias `originrouter-codex-model`. Codex 8.0 has only one slot (`main`); `codex.small` is a hard error. Codex and Claude routes do not share, do not fallback into each other, and do not inherit each other's slots. The proxy YAML renders whichever aliases are configured — if only Codex routes exist, only the Codex alias appears.

```
Claude Code  →  ANTHROPIC_MODEL=originrouter-claude-model
               ANTHROPIC_SMALL_FAST_MODEL=originrouter-claude-fast-model
               ANTHROPIC_BASE_URL=http://127.0.0.1:<proxy-port>
               ANTHROPIC_API_KEY=sk-noop-litellm-passthrough
                          │
                          ▼
                OriginRouter daemon
                reads routes.claude.{main, small}
                → renders LiteLLM YAML → spawns/refreshes proxy
                          │
                          ▼
                LiteLLM proxy on 127.0.0.1
                originrouter-claude-model      → deepseek/deepseek-chat
                originrouter-claude-fast-model  → moonshot/moonshot-v1-8k
```

### 10.1 Concepts

- **Provider** = inventory (a configured upstream). All providers are `type=litellm`; the catalog profile (`litellmProvider`) selects the LiteLLM adapter. 34 catalog entries in §9.3.
- **Route** = current choice (which provider/model each alias points at).
- **Proxy** = executor (LiteLLM on 127.0.0.1; YAML rendered from routes).
- **Daemon** = control plane (HTTP API + proxy lifecycle owner).

### 10.2 Storage shape

```json
{
  "routes": {
    "claude": {
      "main":  { "provider": "deepseek", "model": "deepseek-chat" },
      "small": { "provider": "moonshot", "model": "moonshot-v1-8k" }
    }
  }
}
```

- `routes.claude.main` is required for `proxy start` in routes mode.
- `routes.claude.small` is optional; when absent, the renderer **falls back to main** (the proxy serves the same upstream under both alias names). Claude Code always sees both alias names.
- Alias names are **hardcoded**: `originrouter-claude-model` (main) and `originrouter-claude-fast-model` (small). Not stored in config; not user-editable. The CLI storage slot is `claude.small`; the UI display label is "Claude Fast Model".
- **Stage 7.8:** `provider use` writes ONLY `routes.claude.main`. The fast route is owned by the routes layer. To set it, use `POST /routes/claude/small` (or the UI's "Set as Claude Fast route" button on the provider detail). `provider use` no longer seeds `small` from the provider's `smallFastModel`; that field is [legacy] and the form no longer surfaces it.
- **Stage 7.9:** the browser console exposes `/routes/claude/main` and `/routes/claude/small` as form selects on the new Routes tab — full-screen editor for both slots. Codex remained a UI placeholder (disabled `<select>` + "Codex routing is not wired yet." banner) at this point; Stage 8.2 wired it. The left Routes sidebar showed the compact `main` / `small` summary.
- **Stage 8.2:** the browser console's Routes tab now exposes a real Codex routing block — `routes.codex.main` as a `<select>` populated from `GET /providers` filtered to `type=litellm && model && model !== "(unset)"`, an `alias:` line (`originrouter-codex-model`), a `current:` indicator showing `(unset; Codex will not start until set)` when no route is set, and `Save Codex Model` / `Clear Codex Model` buttons that POST/DELETE `/routes/codex/main`. A banner note (`Codex has one route in Stage 8.x. It does not use Claude Model or Fast Model.`) makes the isolation explicit. The Provider-detail view adds a `Set as Codex Model route` button next to the Claude buttons. The Routes sidebar groups rows under `Claude` / `Codex` section labels, with `clear-codex-route` mirroring `clear-fast-route`. Codex never falls back to Claude.
- **Stage 8.0:** Codex rides the same routes contract with a third fixed alias `originrouter-codex-model` (`routes.codex.main`). Codex 8.0 has **only `main`** — `codex.small` is a hard error from `setRoute` / `clearRoute` and the API returns 400 on `POST /routes/codex/small`. **Codex never falls back to Claude**, even when Claude routes are configured. There is no `currentProvider.codex` fallback in Stage 8.0: `originrouter codex` errors with `Codex requires routes.codex.main. Run originrouter route set codex.main --provider <name> --model <model>.` if the route is unset. `provider use --agent codex` writes `routes.codex.main` (it no longer writes `currentProvider.codex`). The `CodexAdapter` injects `--model originrouter-codex-model` (plus `OPENAI_MODEL` env as a defensive fallback) unless the user passed `--model` / `-m` in any form (`--model X`, `--model=X`, `-m X`, `-m=X`), in which case it warns and passes args through. Codex env at launch: `OPENAI_BASE_URL=http://127.0.0.1:<proxy-port>/v1`, `OPENAI_API_KEY=sk-noop-litellm-passthrough`, `OPENAI_MODEL=originrouter-codex-model`.

### 10.3 Provider type collapse (Stage 7.6)

The legacy `type=anthropic` and `type=openai-compatible` are no longer accepted on add. They are read-projected and write-migrated to the new shape on the next save.

| Legacy type | Migrated to |
|-------------|-------------|
| `type=anthropic` | `type=litellm, litellmProvider=anthropic` (set `baseUrl` for Anthropic-compatible endpoints) |
| `type=openai-compatible` | `type=litellm, litellmProvider=custom_openai` |

Save-time validation:
- `addProvider` rejects `type=anthropic` and `type=openai-compatible` outright.
- `applyProviderUpdate` on a legacy record auto-migrates; the on-disk record never carries `_legacyType` after migration. The API response may include a `migratedFrom: "anthropic"` field for UI hints.

### 10.4 `claudeConfig.js` env injection (single path)

| Routes | Proxy | `ANTHROPIC_MODEL` | `ANTHROPIC_SMALL_FAST_MODEL` |
|--------|-------|-------------------|-----------------------------|
| main + small | running in route mode, hash matches | `originrouter-claude-model` | `originrouter-claude-fast-model` |
| main only    | running in route mode, hash matches | `originrouter-claude-model` | `originrouter-claude-fast-model` (small falls back to main) |
| any          | stopped / not-installed / mode≠route / hash mismatch | throws `PROVIDER_UNSUPPORTED` |

`buildAgentProviderEnv()` does NOT call `resolveProvider()` for claude. `currentProvider.claude` and `--provider` are **ignored** for the claude env. They are still useful for codex.

### 10.5 Auto-restart contract

A `PUT /routes/claude` (or `route set ...` on the CLI) auto-restarts the proxy **only when**:

- the proxy is currently running (`state: "running"`), AND
- the proxy's stored mode is `route`, AND
- the route hash actually changed.

If the proxy is stopped / not-installed, the route is persisted but the proxy is **not** auto-started. The user must run `proxy start --port <p>` explicitly.

Restart failure: response carries `proxy.needsRestart: true`, `proxy.state: "stopped"`, `proxy.logPath: <path>`. The UI shows the log path so the user can diagnose.

The same `saveRoutesAndMaybeRestartProxy()` helper backs:
- `POST /providers/use` (claude: writes `routes.claude.main` from the provider; Stage 8.0: codex writes `routes.codex.main` instead of `currentProvider.codex`)
- `PUT /routes/claude` / `PUT /routes/codex`
- `POST /routes/claude/main` / `POST /routes/claude/small` / `POST /routes/codex/main` (Stage 8.0; `POST /routes/codex/small` returns 400)
- `DELETE /routes/claude/small` / `DELETE /routes/codex/main`
- `DELETE /providers/:name` (Stage 7.8: clears Claude routes that point at the removed provider; Stage 8.0: also clears `routes.codex.main`)

All seven endpoints share the same restart contract. The hash used for the restart decision is `hashRoutes(getAllRoutes(config))` so a Codex-only change also triggers the restart.

### 10.5.1 Cleanup on provider remove (Stage 7.8)

`DELETE /providers/:name` and `originrouter provider remove <name>` clear any `routes.claude.{main,small}` entries that reference the removed provider. The cleanup runs **before** the proxy-restart check, so a route-mode proxy whose target was just removed is restarted on the new (possibly empty) routes hash. If both slots end up cleared, the `routes` object is removed from the config entirely.

- **Local API path** (`DELETE /providers/:name`): goes through `saveRoutesAndMaybeRestartProxy`. Response is `{ ok, removed, routes: { claude: { main, small } }, proxy: <snapshot> }`.
- **CLI path** (`provider remove <name>`): writes config and prints which slots were cleared (`cleared routes.claude.main` / `cleared routes.claude.small`). Does NOT auto-restart the proxy — the CLI does not own the proxy lifecycle. The user runs `originrouter proxy restart` (or the daemon does it on the next API write).

Routes that point at *unrelated* providers are not touched.

### 10.6 Local API routes endpoints

All require the bearer token (Stage 6 deny-by-default; routes are user state, not a static catalog).

| Method | Path                                | Body                              | Effect |
|--------|-------------------------------------|-----------------------------------|--------|
| GET    | `/routes`                           | —                                 | Stage 8.0: returns `{ routes: { claude: { main, small }, codex: { main } }, aliases: { main, small, claude: {...}, codex: { main } } }`. The flat `aliases.main` / `aliases.small` are kept for backward compat with `local-console.html`. |
| GET    | `/routes/<agent>`                   | —                                 | Same shape for one agent. `<agent>` ∈ `{claude, codex}`. |
| PUT    | `/routes/<agent>`                   | `{ main?: { provider, model? }, small?: ... }` (use `null` to clear) | Replace full route set, auto-restart if running. `small` is rejected for `codex`. |
| POST   | `/routes/<agent>/<slot>`            | `{ provider, model? }`            | Set a single slot. `<slot>=small` returns 400 for `codex`. |
| DELETE | `/routes/<agent>/<slot>`            | —                                 | Clear a single slot |
| POST   | `/providers/use` (claude)            | `{ name, agent: "claude" }`        | Write `routes.claude.main` from the named provider (auto-restart if running) |

`<agent>` is currently `claude`; `<slot>` is `main` or `small`. The PUT response includes `proxy: { state, mode, currentRouteHash, aliases, logPath, needsRestart }`.

`POST /routes/<agent>/<slot>` with `slot=small` is the canonical way to point the fast alias at a provider (Stage 7.8). The UI's "Set as Claude Fast route" button on the provider detail view hits this endpoint with `{ provider, model }`. The CLI equivalent is `originrouter route set claude.small --provider <name> --model <model>`. When `routes.claude.small` is unset, the renderer falls back to main (see §10.2), so omitting it is safe — the proxy still gets a fast alias pointing at the same upstream as main.

**Stage 7.9 GUI entry point:** the local console's **Routes** tab is the full-screen editor for both slots. Two routing blocks (Model, Fast Model), each with a `<select>` populated from `GET /providers` filtered to `type=litellm && model && model !== "(unset)"`, an `alias:` line (`originrouter-claude-model` / `originrouter-claude-fast-model`), a `current:` indicator, and a Save button that POSTs to the matching route endpoint. Save-button gating compares the full `{provider, model}` pair against the saved route so editing a provider's model on the Provider tab is surfaced as a saveable diff. The left Routes sidebar shows compact `claude main / claude small / codex main` rows grouped under section labels, with one clear button per set slot.

**Stage 8.2 Codex block:** the Codex section renders the same shape as Claude's small slot — `<select>`, `alias:` line, `current:` indicator (showing `(unset; Codex will not start until set)` when no route is set), and Save / Clear buttons that POST/DELETE `/routes/codex/main`. Codex has no fast/small slot — see §10 above. A banner note (`Codex has one route in Stage 8.x. It does not use Claude Model or Fast Model.`) makes the isolation explicit. `renderRoutingBlock` is generalized over `(agentKey, slotKey)` so future agents can plug in the same shape; Claude's existing IDs (`routes-main-select`, `routes-small-select`, …) are preserved.

**Stage 8.0:** the new endpoints `POST /routes/codex/main` and `DELETE /routes/codex/main` are first-class siblings of the Claude endpoints. `POST /routes/codex/small` returns 400 (Codex 8.0 has no small slot). The Codex section on the Routes tab was wired in Stage 8.2 to `/routes/codex/main` (see the Stage 7.9 / Stage 8.2 entry-point bullet above). `GET /routes` returns both agents and keeps the flat `aliases.main` / `aliases.small` fields (for backward compat with `local-console.html`'s `normalizeRoutesPayload`) alongside the new nested `aliases.claude` / `aliases.codex` aliases.

### 10.7 Security

- All routes endpoints require the bearer token. The deny-by-default Stage 6 model wins.
- Only `/catalog/litellm-providers` and `/local/auth/challenge` remain public.
- Provider model names can leak upstream metadata (e.g. `anthropic.claude-3-5-sonnet-...`); this is the same information the user already typed into the provider record, so no new exposure.

### 10.8 Codex app-server runtime semantics (Stage 8.1)

The Codex app-server path (`runtime === "codex-app-server"`) introduces three observable protocol behaviors. **Stage 8.2 (UI wiring)** is the browser-console counterpart: the Routes tab now exposes `/routes/codex/main` as a real routing block (not the Stage 7.9 disabled placeholder), the Routes sidebar has a grouped `Codex` section with `clear-codex-route`, and the Provider-detail view has a `Set as Codex Model route` button. Codex never falls back to Claude.

#### `agent.ready` for Codex

`{ type: "agent.ready", provider: "codex", message: "Codex app-server session is ready." }` is emitted **after the `initialize` handshake succeeds**. The Codex `app-server` requires this handshake before it accepts `turn/*` requests; the relay can flip UI state from "connecting" to "ready" on this event. If the handshake fails, `codex.initialize.error` is emitted instead and the app-server falls back to the terminal adapter.

#### `agent.permission.resolved` with `reason: "timeout"`

Codex app-server approval requests time out after 30 seconds (`CODEX_APPROVAL_TIMEOUT_MS`). On expiry:

1. The CLI emits `{ type: "codex.approval.timeout", method, callId, approvalType }` internally.
2. The event mapper turns this into `{ type: "agent.permission.resolved", provider: "codex", callId, decision: "denied", reason: "timeout" }`.
3. The underlying Codex request is auto-declined: `decision: "decline"` (non-legacy) or `decision: "denied"` (legacy `execCommandApproval` / `applyPatchApproval`), or `{ action: "decline", content: null, _meta: null }` for MCP elicitation.

**Critical**: the `callId` on the timeout event is the **same callId the UI used to create the permission card** (not the JSON-RPC id), so the relay can match the pending card exactly. Late user decisions after timeout are dropped — a single `responded` flag inside the app-server client guarantees one response per request.

#### `agent.task.complete` dedup

Duplicate `turn/completed` notifications for the same turn id are deduplicated. The dedup is scoped to the in-memory `completedTurnIds` set (bounded FIFO at 1000 unique turns). A duplicate produces no second `agent.task.complete` / `agent.task.aborted` event. This matters for Codex CLIs that occasionally emit `turn/completed` more than once for a single turn, or that interleave raw and legacy `codex/event` wrappers — the lifecycle protocol lock in `handleNotification` drops the opposite-channel lifecycle event once one channel has won.

#### Interrupted status

`turn/completed` with `status: "interrupted"` (not just `cancelled` / `canceled` / `aborted`) maps to `agent.task.aborted` with the original `status` field preserved. The status-set used by `isAbortStatus` is `interrupted | cancelled | canceled | aborted`.

### 10.9 Codex env injection vs `--model` argv injection (Stage 8.3)

Two distinct things go into the Codex child process. They are not
the same thing, and neither proves the other.

**1. Environment injection** is the responsibility of
`buildAgentProviderEnv("codex", config, ...)` in
`src/config/claudeConfig.js:152-190`. When the proxy is running in
route mode and the snapshot's `routesHash` matches
`hashRoutes(getAllRoutes(config))`, the resolver returns three env
vars:

- `OPENAI_BASE_URL=http://127.0.0.1:<port>/v1`
- `OPENAI_API_KEY=sk-noop-litellm-passthrough`
- `OPENAI_MODEL=originrouter-codex-model`

`originrouter env print --agent codex` renders these for human
inspection. **Verifying env print proves env injection only.** It
does not prove the `--model` CLI argument is injected.

**2. `--model` CLI arg injection** is the responsibility of
`CodexAdapter.buildLaunch()` in `src/adapters/codexAdapter.js:38-58`.
Unless the user passed `--model` / `-m` in any of the four accepted
forms (`--model X`, `--model=X`, `-m X`, `-m=X`), the adapter
prepends `["--model", "originrouter-codex-model"]` to the child argv.
When the user did pass a model flag, the adapter leaves argv
unchanged and writes a stderr warning pointing at
`route set codex.main`.

The unit-level proof for argv injection is the `CodexAdapter` block
of `tests/codexE2eOffline.test.js`. The end-to-end proof is to
invoke `originrouter codex` inside a wrapper that prints argv (or
`originrouter codex --help` against an argv shim) and confirm the
flag is present, absent when the user passed one.

**LiteLLM log is truth.** Automated offline tests cover the route →
config → proxy-snapshot → env-print chain shape. They do not
exercise the network path. The single source of truth for "did
Codex Code actually use the configured route" is the LiteLLM proxy
log file (path stored in `proxy.state.json.logPath`, default
`~/.originrouter/logs/litellm.log`). Look for an inbound request to
the OpenAI-compatible endpoint with
`"model": "originrouter-codex-model"` and a successful upstream
dispatch.

The model name that Codex Code self-reports in its UI is **not** a
verification source. It reflects what Codex Code reads from its
own argv / state, not necessarily what OriginRouter wrote into the
proxy YAML. Verification = log read, not log inference.

Full manual recipe: [`docs/codex-e2e-verification.md`](codex-e2e-verification.md).

### 10.10 Codex app-server process lifecycle (Stage 8.4)

The Codex app-server is a long-lived child process spawned by
`CodexAppServerClient.connect()` and torn down by `disconnect()`.
Stage 8.4 hardens the lifecycle so a stale or hung child cannot leak
state into a new session, and so a mid-session crash produces a
clean, structured end-of-session signal.

**`processEpoch` and where it lives.** `processEpoch` is a counter
on `CodexAppServerClient`, incremented at the top of `connect()`.
Every async callback that captures the epoch at registration time
(stdout line, stderr data, child exit, request timeout, approval
timeout) checks `epoch === this.processEpoch` before doing
anything. **It is not touched by `disconnect()`.** Bumping the
epoch there would orphan the in-flight exit listener, and the
cleanup path would never run — the force-kill timer would never
clear, and `codex.app_server.exit` would never fire. Epoch exists
to ignore events from a *previous* child after a *new* `connect()`,
not to invalidate the *current* child.

**Crash path: `_handleChildExit({ code, signal, epoch })`.** On
real child exit, this single method:
- sets `childExited = true` so the SIGKILL escalation can short-circuit;
- clears `forceKillTimer` (if any);
- rejects all pending RPC with a uniform
  `codex app-server exited (code=…, signal=…)` error;
- clears all approval timers (`_clearApprovalTimers` accepts both
  the Stage 8.4 `{ timer, epoch }` shape and the legacy raw-handle
  shape so the helper is testable in isolation);
- resets turn state (`completedTurnIds`, `completedTurnOrder`,
  `turnOpen`, `currentTurnId`);
- emits a structured `codex.app_server.exit` event with
  `{ type, code, signal, epoch }`.

The eventMapper (`src/adapters/codex/eventMapper.js`) renders this
as `agent.adapter.status { provider: "codex", appServerAvailable:
false, state: "exited", code, signal }`. The same mapper renders
`codex.app_server.force_kill` as
`state: "force_killed"`.

**Adapter-level approval cleanup.** When the app-server process
exits, the JSON-RPC response timers are cleared on the client side,
but the outer promise returned to the UI lives in
`CodexAdapter.pendingApprovals`. `CodexAdapter.beforeStart` registers
an `onEvent` handler that, on `codex.app_server.exit` or
`codex.app_server.force_kill`, walks `pendingApprovals`, resolves
each as `"denied"`, and pushes an `agent.permission.resolved` event
with `reason: "app_server_exit"` — before the mapper runs. So the
relay sees the per-card denials first, then the
`agent.adapter.status` event. The two responsibilities (JSON-RPC
response timers vs UI permission cards) are intentionally separate
across the client and adapter layers.

**`disconnect()` is idempotent and escalates.** First call sets
`disconnecting = true` and proceeds. The function sends `SIGTERM`
and starts a `CODEX_FORCE_KILL_MS` (2000ms) timer; if the child has
not exited by then, the timer fires `SIGKILL` and emits
`codex.app_server.force_kill`. The SIGKILL is gated on
`this.childExited` (set by `_handleChildExit`), **not** on Node's
`ChildProcess.killed` (which is "signal sent", not "process
exited" — after the SIGTERM above it stays `true` permanently and
would short-circuit the SIGKILL). The `try/catch` around both
`kill()` calls swallows `ESRCH` if the process is already gone.

**Runtime metadata.** `CodexAdapter.describe()` now adds
`runtime: this.appServerAvailable ? "codex-app-server" : null` and
gates `structuredSources` on the same flag. `localAgentSession.js`
lifts the value to a top-level `session.started.runtime` field and
writes the same value to `appendSessionStart` (replacing the
hardcoded `undefined`).

**Stage 8.4 does not reconnect or resume threads.** A crash ends
the session. Full reconnect/resume is a later stage (see
`docs/agent-runtime-audit.md` §11).

Implementation: `src/adapters/codex/appServerClient.js`,
`src/adapters/codex/eventMapper.js`, `src/adapters/codexAdapter.js`,
`src/local/localAgentSession.js`. Tests:
`tests/codexAppServerClient.test.js` (cases 18–28) and the
adapter-level approval cleanup in `tests/adapters.test.js`.

### 10.11 Claude hook forwarder reliability (Stage 8.5)

The hook forwarder at `scripts/claude-session-hook-forwarder.cjs`
is the per-hook command Claude Code spawns. Stage 8.5 makes it
resilient to transient local-hook-server failures without
changing the CLI invocation shape.

**Retry policy:** 3 attempts with exponential backoff (50ms
after attempt 1, 150ms after attempt 2 — two delays for three
attempts). Total worst-case ~600ms before the retry budget is
exhausted, before any per-attempt timeout is in effect. The
backoff is intentionally short: a transient local-hook-server
blip should clear within hundreds of milliseconds, and we want
to fail fast enough that the user's session is not noticeably
delayed.

**Per-attempt timeout, event-conditional:**

- `SessionStart`: 5s hard socket timeout. The local hook server
  responds "ok" within milliseconds when the relay isn't
  involved, so 5s is well above actual latency and short enough
  to fail fast on a hung server.
- `PermissionRequest`: 58s hard socket timeout, to safely cover
  the hook server's 55-second hold-open
  (`src/adapters/claude/hookServer.js`). A 5s timeout here would
  actively break the normal remote-approval flow.

**Retryable errors:** network-layer failures during the connect
/ write phase (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT` only
when the per-attempt timeout fired, `EAI_AGAIN`, `ENOTFOUND`,
`EHOSTUNREACH`, `EPIPE`); HTTP 5xx (500, 502, 503, 504); HTTP
429.

**Fatal errors (no retry):** HTTP 4xx other than 429 (400, 401,
403, 404, 405, 422, etc.) — these are programming bugs in the
hook body, not transient.

**Retry exhaustion / fatal:** the forwarder writes a structured
JSON diagnostic to stderr
(`{ source: "hook_forwarder", error, attempts, lastError, port,
event, ... }`). The exit code and stdout behavior are
**unchanged**: the forwarder still exits 0 with the server's
response body on stdout (when appropriate). The user-visible
outcome on a retry-exhausted hook is the same as before Stage
8.5 — what changes is that the failure is now debuggable via
the daemon's logs.

**What this stage does not claim:** we do not promise a
"user-visible fail-open" outcome. The original `process.exit(0)`
with no stdout already maps to Claude Code's default behavior
for `PermissionRequest` (treat as deny). Stage 8.5 does not
change that mapping; it only retries transient failures and
writes a stderr diagnostic so the failure is observable. The
user's request was "不要立刻让 Claude 误判成 permission denied"
— what we deliver is **transient-failure retry** (so a brief
blip doesn't trigger the false-deny path) plus a stderr log. A
post-exhaustion failure still falls through to Claude Code's
default; we just make the failure visible in the daemon log.

**No new dependencies.** Pure `node:http`. The script is still
CommonJS and uses no external packages.

**No UI changes.** The relay sees no new events. The hook
server's 55-second hold-open timeout is independent and stays.
The 4-second `setTimeout` in the original forwarder is replaced
by the event-conditional per-attempt socket timeout above.

Implementation:
`scripts/claude-session-hook-forwarder-impl.cjs` (pure logic),
`scripts/claude-session-hook-forwarder.cjs` (thin CJS wrapper).
Tests: `tests/hookForwarder.test.js` (10 cases).

### 10.12 Runtime cleanup contracts (Stage 8.6)

Stage 8.6 is a spawn defaults cleanup. It does **not** add a new
user-visible runtime, and it is **not** a `cross-spawn`
migration.

**Spawn helper.** `src/utils/spawn.js` exports:

- `SPAWN_DEFAULTS` — frozen `{ shell: false, windowsHide: true }`.
- `buildSpawnOptions(options)` — pure: spreads
  `SPAWN_DEFAULTS` then caller-supplied options, so caller
  options win on conflict. Tests cover this directly without
  monkey-patching `node:child_process.spawn`.
- `spawnCommand(command, args, options)` — thin wrapper that
  calls `node:child_process.spawn(command, args, buildSpawnOptions(options))`.

Two production call sites use the helper:

- `src/adapters/codex/appServerClient.js` — its default
  `options.spawnFn` is now `spawnCommand` (was `spawn`
  directly). The `spawnFn` test seam from Stage 8.4 is
  preserved; all existing tests inject their own `spawnFn`
  and see no behavior delta.
- `src/executors/pipeExecutor.js` — replaces its `spawn(...)`
  call with `spawnCommand(...)`.

On macOS/Linux the helper is a **behavior no-op** —
`windowsHide: true` only affects Windows, and `shell: false`
is what both sites already passed. The value is centralizing
the defaults so future sites inherit them. Cross-platform
Windows `.cmd` / `.ps1` shim safety remains deferred to
platform hardening (would require `cross-spawn`).

**Codex sandbox env.** OriginRouter does **not** set
`CODEX_SANDBOX` by default. User-provided `CODEX_SANDBOX` is
preserved. The `RUST_LOG` default filter
(`codex_core::rollout::list=off`) is unchanged: user-supplied
`RUST_LOG` wins; otherwise the default suppresses noisy
`codex_core::rollout::list` logs.

Four regression tests in `tests/codexAppServerClient.test.js`
(cases 31–34) lock this contract. Each test awaits
`connect()` completion via an initialize-response handshake
so no pending RPC timer leaks between cases. The tests use
a local `captureSpawnEnv(env)` helper that drives the
handshake and returns `spawnFn`'s captured `options.env`.

**Future work remains deferred.** Reconnect / resume of an
existing Codex thread (Stage 9+ architecture migration);
SDK/PTY event normalization; replay ring buffer; device
pairing (`localPair`, multi-device auth); `cross-spawn`
Windows hardening; sandbox env (`CODEX_SANDBOX=seatbelt`).
See `docs/agent-runtime-audit.md` §11 for the full deferred
work list.

### 10.13 Claude runtime event normalization plan (Stage 8.7)

Stage 8.7 is a **design + contract-test stage**. It does
**not** refactor the session runners. The contract helper
(`src/runtime/claudeEventContract.js`) is a contract source,
not a production mapper. Production code paths do **not**
import it. The test file (`tests/claudeEventContract.test.js`)
is the only consumer in Stage 8.7. A future wiring stage may
replace this module with the production mapper or promote it;
either way, **no production code imports it in Stage 8.7**.

Stage 8.7 contracts the **current** event names (`agent.text`,
`agent.task.completed`) and locks the future target shapes
(`agent.message`, `agent.task.complete` are documented as
future rename targets but are **not** in Stage 8.7 scope).
The helper does not rename events. The test suite does not
test rename. Relay/UI/mobile coordination for the rename is
a future stage.

#### Normalized runtime tag

Two Claude runtimes are defined:

- `claude-pty` — `originrouter claude` (PTY-backed Claude CLI).
- `claude-sdk` — `originrouter claude-sdk` (Claude Agent SDK).

Today the PTY path emits `runtime: null` and the SDK path
emits `runtime: "claude-sdk"`. The contract requires both
paths to emit the explicit runtime tag (no `null`). The
migration from `null` to `"claude-pty"` is a future wiring
stage.

#### Normalized event categories

**1. Session start** — `session.started`

```json
{
  "type": "session.started",
  "sessionId": "...",
  "agent": "claude",
  "runtime": "claude-pty | claude-sdk",
  "metadata": {
    "adapter": "claude | claude-sdk",
    "runtime": "claude-pty | claude-sdk",
    "structuredSources": ["..."]
  }
}
```

Rules:

- `runtime` is top-level.
- `metadata.runtime` mirrors the top-level value.
- PTY target runtime: `"claude-pty"`.
- SDK target runtime: `"claude-sdk"`.
- `metadata.adapter` preserves the runtime-specific adapter
  value (e.g. `"claude-sdk"` for the SDK path, `"claude"`
  for the PTY path). The agent-level `agent` field is
  normalized to `"claude"`; `metadata.adapter` is intentionally
  kept runtime-specific so the relay can distinguish source.
  Runtime-specific metadata is allowed but must not replace
  normalized fields.

**2. Agent status** — `agent.ready`, `agent.adapter.status`

```json
{ "type": "agent.ready", "provider": "claude", "runtime": "claude-pty | claude-sdk" }
```

```json
{ "type": "agent.adapter.status", "provider": "claude", "runtime": "claude-pty | claude-sdk", "state": "ready | degraded | exited | error" }
```

Rules:

- SDK emits `agent.ready` natively. PTY may **not** emit
  `agent.ready` until it has a real readiness signal; the
  contract requires it on SDK, and accepts its absence on PTY
  in Stage 8.7.
- `agent.adapter.status` is an optional extension point for
  per-runtime state. Daemon and Codex already emit it.
- Runtime-specific fields may extend, but normalized fields
  stay stable.

**3. Task lifecycle** — current SDK name
`agent.task.completed`, future target name
`agent.task.complete`

```json
{ "type": "agent.task.started", "provider": "claude", "runtime": "...", "turnId": "optional" }
```

```json
{ "type": "agent.task.complete", "provider": "claude", "runtime": "...", "turnId": "optional", "status": "complete | aborted | error" }
```

Rules:

- The SDK today emits **`agent.task.completed`** (past
  tense). The contract documents **`agent.task.complete`** as
  the future target name. **Stage 8.7 does not rename.** The
  helper passes events through unchanged in this category;
  the test suite does not test rename; the SDK runner is not
  modified. Migration of the SDK's emitted name is a future
  wiring stage.
- PTY may not always produce task lifecycle; absence is
  acceptable in Stage 8.7.
- Future normalization should avoid double-emitting lifecycle
  events (one path or the other, not both).

**4. Agent messages** — `agent.text` (current contract)

Stage 8.7 contracts the **current** event name (`agent.text`).
A future `agent.text` → `agent.message` rename is
acknowledged as a desirable cleanup but is **not** in Stage
8.7 scope. The helper does not rename events. The test suite
does not test rename. Relay/UI/mobile coordination for the
rename is a future stage.

Contract requirement: every `agent.text` event must carry
`provider: "claude"` and `runtime: "claude-pty" |
"claude-sdk"`. Today the JSONL scanner omits `provider` on
`agent.text`; the contract requires that gap to close during
the future wiring stage.

**5. Permission events** —
`agent.permission.request.detected`,
`agent.permission.resolved`

```json
{
  "type": "agent.permission.request.detected",
  "provider": "claude",
  "runtime": "claude-pty | claude-sdk",
  "callId": "...",
  "tool": "...",
  "input": {},
  "permissionSuggestions": [],
  "resolution": {
    "eventType": "agent.permission.resolve",
    "decisions": ["approved", "approved_for_session", "denied", "abort"]
  }
}
```

Rules:

- Both paths already emit
  `agent.permission.request.detected` with
  `provider: "claude"`. Add `runtime`.
- PTY may include `permissionSuggestions`; SDK may omit
  (empty array is acceptable).
- `agent.permission.resolved` may include a runtime-specific
  `sessionRulePending` (PTY-only today).

**6. Usage / token counts** — `agent.usage`

SDK-only when shipped. PTY may omit. Not invented for PTY.

**7. Runtime extensions** — `agent.sdk.metadata`, etc.

```json
{ "type": "agent.sdk.metadata", "provider": "claude", "runtime": "claude-sdk", "tools": [...], "slashCommands": [...], "mcpServers": [...], "skills": [...] }
```

Rules:

- Extension events must include `provider` and `runtime`.
- Clients treat them as optional.
- PTY is not required to emit `agent.sdk.metadata`; if it
  does, `runtime: "claude-pty"` is the value.

#### Daemon path

Out of scope for Stage 8.7. Documented as "current behavior,
not migrated". The daemon path will be revisited in a later
stage; the audit table in
`docs/agent-runtime-audit.md` covers PTY and SDK only.

### 10.14 Blocking-prompt interaction contract (Stage 8.8)

Stage 8.8 is a **design + contract-test stage**. It does **not**
refactor the session runners. The contract helper
(`src/runtime/agentInteractionContract.js`) is a contract source,
not a production mapper. Production code paths do **not** import
it. A future wiring stage (9.0+) may replace this module with
the production mapper or promote it; either way, no production
code imports it in Stage 8.8.

Stage 8.8 defines **two** events:
`agent.interaction.requested` and `agent.interaction.resolve`.
There is no `agent.interaction.canceled` in 8.8 — cancellation
is expressed by sending
`{ type: "agent.interaction.resolve", decision: "abort" }`. A
dedicated canceled event is a future-stage concern if the UI
ever needs the distinction.

#### 10.14.1 Kinds and sources

The `kind` field distinguishes blocking-prompt flavors:

| `kind`           | Wire status (8.8) | Notes |
|---|---|---|
| `permission`     | **implemented**    | Covers all existing `agent.permission.*` events. Maps `hook` / `app-server` sources. Round-trips through the reverse map. |
| `confirm`        | reserved           | y/N confirmation. Not emitted by any runtime in 8.8. |
| `single_select`  | reserved           | Enumerated single-choice picker. Not emitted in 8.8. |
| `multi_select`   | reserved           | Multi-choice picker. Documented target only; payload shape is a 9.0+ decision. |
| `free_text`      | reserved           | Free-form text answer. Documented target only; payload shape is a 9.0+ decision. |
| `raw_terminal`   | reserved           | Escape hatch (raw terminal bytes in `data`). 8.8 documents the envelope only. |

The `source` field names the local producer:

| `source`      | Today                                       | Notes |
|---|---|---|
| `hook`        | Claude PTY PermissionRequest hook (existing) | Default source for backward-compat permission events. |
| `jsonl`       | reserved                                    | Future Claude JSONL scanner surface. |
| `app-server`  | Codex app-server approval (existing)         | `mapCodexApprovalRequest` target. |
| `pty`         | reserved                                    | Generic PTY fallback (no structured event today). |

Full versions of these tables live in
[`docs/agent-interaction-contract.md`](agent-interaction-contract.md).

#### 10.14.2 Wire shapes

**`agent.interaction.requested`** (new envelope):

```json
{
  "type": "agent.interaction.requested",
  "provider": "claude | codex | ...",
  "runtime": "claude-pty | claude-sdk | codex-app-server | null",
  "sessionId": "...",
  "interactionId": "...",
  "callId": "...",
  "source": "hook | jsonl | app-server | pty",
  "kind": "permission | confirm | single_select | multi_select | free_text | raw_terminal",
  "title": "...",
  "prompt": "...",
  "tool": "...",
  "input": { },
  "options": [ { "id": "approved", "label": "Allow", "value": "approved", "shortcut": "a" } ],
  "defaultOptionId": "approved",
  "resolution": {
    "eventType": "agent.interaction.resolve",
    "decisions": ["approved", "approved_for_session", "denied", "abort"]
  },
  "permissionSuggestions": [ ],
  "terminalReply": null,
  "createdAt": 1234567890,
  "timeoutMs": 55000
}
```

**`agent.interaction.resolve`** (new envelope):

```json
{
  "type": "agent.interaction.resolve",
  "sessionId": "...",
  "interactionId": "...",
  "decision": "approved | approved_for_session | denied | abort",
  "value": "...",
  "data": "..."
}
```

**Legacy `agent.permission.request.detected`** (still emitted
today by the Claude PTY hook server and the Codex app-server
client; will be a thin alias under `agent.interaction.*` in
9.0+):

```json
{
  "type": "agent.permission.request.detected",
  "provider": "claude | codex",
  "callId": "...",
  "tool": "...",
  "input": { },
  "permissionSuggestions": [ ],
  "resolution": {
    "eventType": "agent.permission.resolve",
    "decisions": ["approved", "approved_for_session", "denied", "abort"]
  }
}
```

Envelope rules:

- The new envelope's `resolution.eventType` is **always**
  `"agent.interaction.resolve"`, even when the input was a
  legacy `agent.permission.*` event. A 9.0 consumer that
  matches on the wire type to render the card must never see
  the legacy eventType on the new envelope.
- The new resolve envelope uses `resolve` (not `resolved`).
  It is **not** a rename of the legacy
  `agent.permission.resolved` emitted by Codex; the new
  contract uses `resolve` for both the wire type and the
  helper-built payload.
- `sessionId`, `interactionId`, and `decision` are required
  and must be non-empty strings on the resolve envelope.
- `value` and `data` are emitted only when the caller passes
  them — the helper does not synthesize either field. Use
  `value` for structured answers (free-text strings, selected
  indices); use `data` for raw terminal bytes.

#### 10.14.3 Wire-in rules (forward-looking, not 8.8 scope)

- A structured `agent.interaction.resolve` is only accepted
  when the local session has a matching pending `interactionId`.
  Unknown IDs are rejected.
- The raw terminal fallback (`terminal.input` → PTY stdin)
  remains a labeled escape hatch. It is always available,
  regardless of whether a structured interaction is pending.
- `multi_select` and `free_text` kinds are documented targets
  only, not solved in 8.8. UI rendering and payload shapes are
  a 9.0+ concern.
- A dedicated `agent.interaction.canceled` event is **not**
  part of 8.8. Cancellation is expressed by sending
  `agent.interaction.resolve` with `decision: "abort"`. A
  future stage may introduce a dedicated canceled event if the
  UI needs the distinction.

See
[`docs/agent-interaction-contract.md`](agent-interaction-contract.md)
for the full contract, validation rules, and audit table.

#### 10.14.4 Stage 8.9 wiring notes

Stage 8.9 promotes §10.14 from "contract-only" to
"production-wired" for the permission kind:

- **Dual-emit.** `claudeAdapter.js` and `codexAdapter.js`
  push both `agent.permission.request.detected` (legacy,
  unchanged) and `agent.interaction.requested` (new, wrapped
  via `permissionEventToInteraction`) for every permission
  request. Legacy is pushed first.
- **Resolve path.** `handleRemoteEvent` accepts
  `agent.interaction.resolve` and routes it to
  `adapter.resolvePermission`. The Codex adapter accepts
  `interactionId` as an alias for `callId`; the Claude adapter
  already reads `payload.callId || payload.id`.
- **Local API.** `POST /sessions/:id/interaction` (new) accepts
  `{ interactionId, decision, value?, data?, reason?, callId? }`
  and forwards `agent.interaction.resolve` to the local session.
  The legacy `POST /sessions/:id/permission` is unchanged.
- **Mode/status display (read-only).** `localAgentSession.js`
  emits one `agent.mode.status` per session on `session.started`:
  ```json
  {
    "type": "agent.mode.status",
    "sessionId": "...",
    "provider": "claude | codex",
    "runtime": "codex-app-server | null",
    "availableModes": ["default", "acceptEdits", "bypassPermissions", "plan"],
    "mode": "default",
    "modeControl": "unsupported",
    "reason": "Live mode switching is not wired in Stage 8.9. Display only."
  }
  ```
  - `provider` is mapped from the local `agent` command
    (`agent === "codex" ? "codex" : "claude"`).
  - `runtime` is the same value `session.started` already carries.
  - `modeControl: "unsupported"` — 8.9 is display-only.
  - Codex availableModes: `["default", "read-only", "safe-yolo", "yolo"]`.
  - **Remote mode switching is Stage 9.0+; 8.9 does not wire it.**

- **Error reuse.** Unknown-id errors continue to use
  `agent.permission.resolve.error` (the existing type). A
  future stage may introduce `agent.interaction.resolve.error`
  if a UI needs the distinction.

- **Field-type contract** (see
  [`docs/agent-interaction-contract.md` §5.4](agent-interaction-contract.md)
  for the full table):
  - `createdAt`: `number` — epoch milliseconds (`Date.now()`).
  - `value`: opaque; treat as `undefined` for `kind: "permission"`.
  - `data`: opaque bytes; raw terminal fallback only. Stage 8.9
    producers do not set it.

See [`docs/agent-interaction-contract.md` §11](agent-interaction-contract.md)
for the runtime-wiring details.
