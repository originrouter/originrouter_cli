# Agent Interaction Contract (Stage 8.8 + Stage 8.9)

## Current managed-runtime contract

`originrouter claude-terminal` and `originrouter codex-terminal` use a newer
managed-runtime contract than the legacy Stage 8.8 adapter flow documented
below. The default `originrouter claude` and `originrouter codex` commands keep
the native PTY interfaces and add Relay-backed remote input, output,
interrupt/stop, lifecycle, and supported hook interactions.

- The CLI process owns the authoritative in-memory pending interaction map.
- Full prompts, form schemas, commands, paths, answers, and message bodies use
  authenticated Relay messages only; they are not written to MySQL.
- CLI to App messages are `agent.interaction.requested`,
  `agent.interaction.result`, `agent.interactions.snapshot`, and
  `agent.stream.event`.
- App to CLI messages are `agent.interactions.snapshot.request` and
  `agent.interaction.resolve` with a stable `responseId`.
- A response is first-writer-wins. The CLI reports `applying` while the native
  runtime consumes it, then `applied`, `expired`, `failed`, `canceled`, or
  `not_found`. Terminal results are retained as five-minute idempotency
  tombstones.
- After an App, Server, or WebSocket reconnect, the App requests a snapshot.
  Each active CLI session returns its pending/applying interactions and up to
  100 recent transient events.

The Stage 8.8/8.9 material below remains the compatibility contract for PTY
adapters and the local API. It is not the persistence model for the explicit
managed Claude SDK or Codex app-server sessions.

> **Stage 8.8 is a design + contract-test stage.** **Stage 8.9
> is the first runtime-wiring stage** that promotes the helper
> from "production does not import it" to "imported by
> production." This document locks the generalized blocking-prompt
> envelope (`agent.interaction.requested` and
> `agent.interaction.resolve`) that the App / provider / login
> credential architecture (Stage 9.0+) renders through one card
> model without another migration.
>
> **Stage 8.9 wiring scope (narrowly permission-kind):**
>
> - Production imports the helper
>   (`src/runtime/agentInteractionContract.js`).
> - `claudeAdapter.js` and `codexAdapter.js` dual-emit
>   `agent.permission.request.detected` and
>   `agent.interaction.requested` for every permission request.
> - `localAgentSession.js#handleRemoteEvent` accepts
>   `agent.interaction.resolve` and routes it to the existing
>   permission resolver. The `data` field is a defensive fallback
>   only; raw terminal control today uses `terminal.input`.
> - `localApi.js` exposes `POST /sessions/:id/interaction`.
> - `localAgentSession.js` emits one `agent.mode.status` per
>   session on `session.started`. **Read-only in 8.9** —
>   `modeControl: "unsupported"`. Remote mode switching is
>   Stage 9.0+.
> - `originrouter-test/local-console.html` renders the new
>   envelope, deduplicates against the legacy event, and shows a
>   mode pill.
>
> **Stage 8.8 (the previous contract-only stage) shipped the
> helper and the 10-case test. The contract is unchanged; the
> 8.9 production wiring is the first consumer.** The existing
> `agent.permission.*` events continue to be emitted and
> consumed exactly as before — no removal.

## 1. Purpose

OriginRouter today ships only **two structured blocking-prompt
events**:

- `agent.permission.request.detected` — produced by
  `src/adapters/claude/hookServer.js` (Claude PTY PermissionRequest)
  and `src/adapters/codex/eventMapper.js#mapCodexApprovalRequest`
  (Codex app-server approval).
- `agent.permission.resolve` (and the related
  `agent.permission.resolved` consumed by `handleRemoteEvent` in
  `src/local/localAgentSession.js`) — produced by the same sources.

Everything else a real Claude Code / Codex remote session will
block on — `ExitPlanMode`, `AskUserQuestion`, numeric TUI pickers,
free-text prompts — is left to the raw terminal fallback
(`terminal.input` → PTY stdin) with no structured envelope. If the
App/H5 UI card model were defined against today's
`agent.permission.*` only, the next kind of prompt would force a
second migration. Stage 8.8 prevents that by locking the new
envelope now.

## 2. Scope and non-goals

Stage 8.8 **defines the contract; it does not wire it.**

- **In scope:**
  - Pure helper module that maps the legacy permission event into
    the new envelope and back.
  - 10-case test suite that locks the forward map, reverse map,
    and resolve payload validation.
  - This document and the corresponding
    `docs/agent-protocol.md` §10.14 / `docs/agent-runtime-audit.md`
    Stage 8.8 section.
- **Out of scope (deferred to Stage 9.0+):**
  - Wiring into `runLocalAgentSession.handleRemoteEvent`,
    `src/adapters/claude/hookServer.js`,
    `src/adapters/codex/eventMapper.js`, the relay, the daemon,
    or any UI.
  - UI rendering for non-permission kinds (`confirm`,
    `single_select`, `multi_select`, `free_text`, `raw_terminal`).
  - Payload schemas for `value` / `data` on non-permission
    kinds.
  - A pending-state machine (caller's job; the helper is pure).
  - `updatedPermissions` echo (Claude-specific; lives in
    `hookServer.js#decisionToHookJson`).
  - Client-side safety timers (relay/UI responsibility).
  - TUI parsing of `terminal.output`.
  - Reconnect / resume.
  - `localPair` / device-pair sync.
  - Provider / login / credential architecture.

### 2.1 Why two events, not three

`agent.interaction.canceled` is intentionally **not** part of
Stage 8.8. Cancellation is expressed by sending
`{ type: "agent.interaction.resolve", decision: "abort" }`. A
future stage may introduce a dedicated canceled event if a UI
needs the distinction (e.g. to differentiate "user explicitly
denied" from "user aborted the whole flow"); that is a
Stage 9.0+ decision. Defining it now would create a third event
shape that nothing emits and that future readers would assume
exists.

## 3. Kinds

The `kind` field distinguishes blocking-prompt flavors.

| `kind`           | Wire status (8.8) | Notes |
|---|---|---|
| `permission`     | **implemented**    | Covers all existing `agent.permission.*` events. Maps `hook` / `app-server` sources. Round-trips through the reverse map. |
| `confirm`        | reserved           | y/N confirmation. Not emitted by any runtime in 8.8. |
| `single_select`  | reserved           | Enumerated single-choice picker. Not emitted in 8.8. |
| `multi_select`   | reserved           | Multi-choice picker. Documented target only; payload shape is a 9.0+ decision. |
| `free_text`      | reserved           | Free-form text answer. Documented target only; payload shape is a 9.0+ decision. |
| `raw_terminal`   | reserved           | Escape hatch (raw terminal bytes in `data`). 8.8 documents the envelope only. |

The forward map accepts any kind from the table; the reverse map
only round-trips `kind: "permission"` and throws `TypeError` on
others (per design decision: there is no legacy home for
non-permission kinds in 8.8).

## 4. Sources

The `source` field names the local producer.

| `source`      | Today                                       | Notes |
|---|---|---|
| `hook`        | Claude PTY PermissionRequest hook (existing) | Default source for backward-compat permission events. |
| `jsonl`       | reserved                                    | Future Claude JSONL scanner surface. |
| `app-server`  | Codex app-server approval (existing)         | `mapCodexApprovalRequest` target. |
| `pty`         | reserved                                    | Generic PTY fallback (no structured event today). |

`source` defaults to `"hook"` when the caller does not pass it.
Passing an unknown source value throws `TypeError`.

## 5. Wire shapes

### 5.1 `agent.interaction.requested` (new envelope)

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

Field rules:

- `type` is always `"agent.interaction.requested"`.
- `interactionId` is the canonical field; `callId` is preserved
  for back-compat consumers. Both are the same string in 8.8.
- `resolution.eventType` is **always** `"agent.interaction.resolve"`,
  even when the input was a legacy `agent.permission.*` event. The
  new envelope must never carry the legacy eventType.
- `permissionSuggestions` is present only when `kind === "permission"`
  AND the input event had it.
- `terminalReply` is non-null only when `kind === "raw_terminal"`.

### 5.2 `agent.interaction.resolve` (new envelope)

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

Field rules:

- `type` is always `"agent.interaction.resolve"`.
- `sessionId`, `interactionId`, `decision` are required and
  must be non-empty strings.
- `value` and `data` are optional. They are emitted **only when
  the caller passes them** — the helper does not synthesize
  either field. Use `value` for structured answers (free-text
  strings, selected indices); use `data` for raw terminal bytes.
- This envelope intentionally uses `resolve` (not `resolved`).
  It is **not** a rename of the legacy `agent.permission.resolved`
  emitted by Codex — the new contract uses `resolve` for both
  the wire type and the helper-built payload. UI consumers must
  match on `type === "agent.interaction.resolve"`, not
  `...resolved`.

### 5.4 Field-type clarifications (Stage 8.9)

- `createdAt`: `number` — epoch milliseconds (`Date.now()`).
  Optional. Stage 8.9 emits a number. App consumers should parse
  as `new Date(interaction.createdAt)`. Do NOT format as ISO
  string at the producer side; the field is intentionally
  numeric to match the relay's existing convention for
  `createdAt` / `timestamp` / `lastUsedAt`.
- `value`: opaque to the consumer unless the consumer knows the
  specific `kind` and the producer's payload schema. Stage 8.9
  producers do not set `value`; App consumers should treat
  `value` as `undefined` for `kind: "permission"`.
- `data`: opaque bytes; for raw terminal fallback only. Stage
  8.9 producers do not set `data`; treat as `undefined`. For
  raw terminal control today, callers should use the existing
  `terminal.input` event, NOT `agent.interaction.resolve { data }`.

### 5.3 `agent.permission.request.detected` (legacy, kept for reference)

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

Still emitted today by the Claude PTY hook server and the Codex
app-server client. Will be a thin alias under
`agent.interaction.*` in 9.0+.

## 6. Mapping rules

**Forward (`agent.permission.request.detected` →
`agent.interaction.requested`):**

- `interactionId` and `callId` both come from the legacy
  `event.callId`.
- `provider`, `tool`, `input` are preserved verbatim.
- `permissionSuggestions` is carried only when the input event
  had it AND `kind === "permission"`.
- `resolution.eventType` is always
  `"agent.interaction.resolve"` (the new envelope always carries
  the new eventType).
- `resolution.decisions` is preserved from the input event when
  present; otherwise the four-decision default is used.
- `source` defaults to `"hook"`; `kind` defaults to `"permission"`.
- `sessionId`, `runtime`, `title`, `prompt`, `options`,
  `defaultOptionId`, `createdAt`, `timeoutMs` come from
  `extras` (caller-supplied). They are `null` when the caller
  does not pass them.

**Reverse (`agent.interaction.requested` →
`agent.permission.request.detected`):**

- Permission-only: throws `TypeError` on `kind !== "permission"`.
- `callId` on the legacy envelope comes from
  `interaction.interactionId`.
- `sessionId` is **dropped** (the legacy wire shape did not
  carry it; the relay attaches `sessionId` at the
  `agent.event` wrapper level, not on the inner event).
- `resolution.eventType` is always
  `"agent.permission.resolve"` (symmetric to the forward map).
- `permissionSuggestions` is sliced defensively (never mutates
  the input).

## 7. Validation contract

`permissionEventToInteraction(event, extras)` throws `TypeError` on:

- `event` is not an object.
- `event.callId` is missing or not a non-empty string.
- `extras.source` is provided but not in `INTERACTION_SOURCES`.
- `extras.kind` is provided but not in `INTERACTION_KINDS`.

`interactionToPermissionEvent(interaction)` throws `TypeError` on:

- `interaction` is not an object.
- `interaction.type` is not `"agent.interaction.requested"`.
- `interaction.kind` is not `"permission"`.
- `interaction.interactionId` is missing or not a non-empty string.

`buildInteractionResolved({sessionId, interactionId, decision, value, data})`
throws `TypeError` on:

- `sessionId`, `interactionId`, or `decision` is missing or not
  a non-empty string.

`isInteractionRequest(event)` and `isInteractionResolve(event)`
return boolean; no throws.

## 8. Stable IDs

`interactionId` is the future `callId`. `callId` is preserved on
the envelope for back-compat consumers that match on the legacy
field, but the canonical field is `interactionId`. Both are the
same string in 8.8.

## 9. Cross-references

- `docs/agent-protocol.md` §10.14 — the wire-protocol entry
  (concise, shape-focused).
- `docs/agent-runtime-audit.md` — the Stage 8.8 section with
  the 4-column audit table (Claude PTY / Happy / Codex /
  Stage 8.8 target) and the file-level evidence trail.
- `src/runtime/claudeEventContract.js` — Stage 8.7 helper
  (unrelated, but same idiom).
- `src/runtime/agentInteractionContract.js` — Stage 8.8 helper.
- `tests/agentInteractionContract.test.js` — 10-case test.

### 9.1 Conceptual reference: Happy

The Happy CLI uses a similar structured blocking-prompt model
without parsing terminal menus:

- `happy-cli/src/utils/BasePermissionHandler.ts` keeps a
  `pendingRequests` Map keyed by `toolUseID`, with `abortAll()`
  resolving pending as `abort` and `reset(reason)` rejecting
  pending and moving them to `completed` as `canceled`.
- `happy-cli/src/claude/utils/permissionHandler.ts` short-circuits
  `AskUserQuestion` to `handlePermissionRequest` (never
  auto-approves) and treats `ExitPlanMode` as always-requiring
  user approval (`descriptor.exitPlan` check).
- `happy-app/sources/sync/apiTypes.ts` reduces notification
  kinds to `done | permission | question` (a coarse taxonomy
  suited to mobile push notifications).

OriginRouter adopts the **shape** (stable `interactionId`,
pending → resolved lifecycle, raw terminal as a labeled escape
hatch, coarse notification kinds) but **does not copy** the
session protocol — OriginRouter has its own relay event model.
The Stage 8.8 helper is a pure contract source; the pending-state
machine and notification logic are Stage 9.0+ work and live in
the adapter and the relay, not in this helper.

## 10. What is NOT in this contract

Explicit non-goals for Stage 8.8:

- **No state machine for pending requests in the helper.** The
  helper is pure; pending tracking is the caller's job.
- **No `reset()` / `abortAll()` semantics in the helper.** Those
  live in the adapter, not the contract.
- **No `updatedPermissions` echo.** Claude-specific; lives in
  `src/adapters/claude/hookServer.js#decisionToHookJson`.
- **No client-side safety timers.** The relay/UI is responsible
  for its own timeouts; `timeoutMs` on the envelope is advisory.
- **No reconnect / resume.**
- **No `localPair` / device-pair sync.**
- **No `value` / `data` schemas for `confirm` / `single_select` /
  `multi_select` / `free_text` / `raw_terminal`.** The forward
  map accepts these kinds with `null` `value` / `data`. Stage 9.0+
  will define the payload shapes when the kinds are wired.
- **No `agent.interaction.canceled`.** Cancellation is
  `decision: "abort"` on the resolve envelope.
- **No removal of `agent.permission.*`.** Legacy events continue
  to be emitted and consumed exactly as today.
- **No provider / login / credential architecture work.** That
  is Stage 9.0.
- **No TUI parser.** Stage 8.8 explicitly does not parse
  `terminal.output`.

## 11. Runtime wiring (Stage 8.9)

Stage 8.9 wires the helper into the live runtime for the
permission kind. The dual-emit pattern is documented here so the
App-side renderer can rely on it without re-reading the code.

### 11.1 Dual-emit

For every permission request:

- Claude PTY hook: `claudeAdapter.js#onPermissionRequest` pushes
  the legacy `agent.permission.request.detected` first, then
  calls `permissionEventToInteraction(event, { source: "hook",
  runtime: null, sessionId: this.sessionId, createdAt: Date.now() })`
  and pushes the new envelope. The legacy event is on the
  queue first so a downstream consumer that splices
  `pendingEvents` in arrival order still sees it.
- Codex app-server: `codexAdapter.js#onApproval` does the same,
  with `source: "app-server"` and `runtime: this.appServerAvailable
  ? "codex-app-server" : null`. `pendingApprovals` stays keyed
  by `callId` (which equals `interactionId`).

`sessionId` is captured at `beforeStart` time on each adapter
(`this.sessionId = sessionId ?? null`). It is **not** available
to the hook server or to `mapCodexApprovalRequest`; the adapter
is the boundary that knows the session context.

### 11.2 Runtime values on the new envelope

- Claude PTY: `runtime: null`. Matches the current
  `session.started` behavior. The Stage 8.7 `claude-pty` rename
  is contracted but not yet back-ported; a future stage that
  back-ports the rename will update both envelopes together.
- Codex: `runtime: "codex-app-server"` when the structured
  app-server path is active, `null` otherwise. Mirrors
  `codexAdapter.js#describe()`.

### 11.3 Resolve path

`localAgentSession.js#handleRemoteEvent` accepts
`agent.interaction.resolve` and routes it to
`adapter.resolvePermission({ callId, interactionId, decision,
reason, data, value })`. The Codex adapter accepts
`interactionId` as an alias for `callId`; the Claude adapter
already reads `payload.callId || payload.id`.

Unknown-id errors continue to use the legacy
`agent.permission.resolve.error` type. This is a compatibility
strategy for 8.9; a future stage may introduce a dedicated
`agent.interaction.resolve.error` if a UI needs the
distinction.

The `data` field on the resolve envelope is a defensive
fallback only: if a future kind arrives that has no
permission-resolver target, the bytes are forwarded to
`executor.write` rather than dropped silently. **8.9 production
adapters do not emit `kind: "raw_terminal"`; for raw terminal
control today, callers use the existing `terminal.input`
event, NOT `agent.interaction.resolve { data }`.**

### 11.4 Local API route

`POST /sessions/:id/interaction` accepts:

```json
{
  "interactionId": "claude-perm-1781663400000-a1b2c3d4e",
  "decision": "approved",
  "value": "optional-for-future-non-permission-kinds",
  "data": "optional-raw-terminal-bytes",
  "reason": "optional-explanatory-string",
  "callId": "optional-redundant-key-mostly-for-tests"
}
```

`interactionId` and `decision` are required. `value`, `data`,
`reason` are forwarded only when defined. The legacy
`/sessions/:id/permission` route is unchanged.

The console's relay-fallback path (no local daemon) re-uses
`/client/permission` with the `interactionId` carried as
`callId`. No new relay route is added in 8.9.

### 11.5 `agent.mode.status` and native Claude mode control

`localAgentSession.js` emits one `agent.mode.status` per session
on `session.started`:

```json
{
  "type": "agent.mode.status",
  "sessionId": "...",
  "provider": "claude | codex",
  "runtime": "...",
  "availableModes": ["default", "acceptEdits", "plan", "auto"],
  "mode": "default",
  "modeControl": "supported"
}
```

- `provider` is mapped from the local `agent` command
  (`agent === "codex" ? "codex" : "claude"`); it is **not** the
  local `agent` value verbatim. Future adapters will need to
  extend this mapping.
- `runtime` is the same value `session.started` already carries.
- Native Claude advertises the modes reachable through its interactive
  Shift+Tab control: `default`, `acceptEdits`, `plan`, and `auto`.
  `bypassPermissions` is added only when the process was launched with the
  corresponding dangerous-permissions flag.
  Codex: `["default", "read-only", "safe-yolo", "yolo"]`.
- Native Claude processes `agent.mode.set` one Shift+Tab step at a time. Each
  step must be confirmed by a Claude Hook `permission_mode` update or by the
  rendered Claude mode footer before another key is sent.
- Mode changes are rejected while Claude is handling a turn or a structured
  interaction. Failure emits `agent.mode.status` with `accepted: false`, the
  confirmed current mode, and a display-safe reason code.
- Terminal runtimes without a structured controller keep
  `modeControl: "unsupported"`.
- The console renders this in the top-bar `Mode:` pill.

### 11.6 Test surface

`tests/agentInteractionRuntime.test.js` (8 cases) covers the
dual-emit, resolve routing, unknown-id error, raw fallback,
and `agent.mode.status` emission. `tests/permissionDecision.test.js`
and `tests/codexAppServerClient.test.js` each gain a structural
round-trip assertion.

The console lives at
`/Users/chengaoyan/Desktop/originrouter-test/local-console.html`
(outside the CLI repo). It is validated by the manual steps in
`docs/agent-runtime-audit.md` Stage 8.9 section, not by the
`npm test` chain.

## 12. Semantic session mirror

Agent Control mirrors the semantic Claude session, not terminal pixels.

- `user.text` and `agent.text` form the App conversation timeline.
- Thinking, tools, permissions, questions, and lifecycle events remain typed
  activity or interaction events.
- Claude JSONL is the history source of truth. The application server never
  stores message bodies.
- `agent.history.request` asks the active CLI session for one page. The opaque
  cursor is meaningful only to that session.
- `agent.history.page` returns at most 100 messages and 96 KiB. The App can
  request older pages while the session remains reachable.
- `agent.message.result` confirms that the target session, rather than merely
  a device socket, consumed an App message.

Transport selection is local-first. Native sessions register with the local
daemon and expose the same protocol through the authenticated loopback API.
The App uses Relay only when the requested session is not available locally.
Local registration, events, commands, and history cursors are memory-only and
disappear when the session or daemon exits.
