# Stage 8.0A — Agent Runtime Protocol Audit

- **Stage**: 8.0A + 8.1 in-tree fixes + 8.2 UI wiring + 8.3 E2E + 8.4 lifecycle + 8.5 forwarder.
- **Status**: AUDIT (8.0A) + 4 small in-tree fixes (8.0A) + 7 robustness fixes (8.1) + UI wiring (8.2) + E2E verification (8.3) + process lifecycle hardening (8.4) + hook forwarder reliability (8.5).
- **Date**: 2026-06-19 (last refreshed 2026-06-20)
- **Audience**: OriginRouter maintainers; downstream clients of `agent.event`, `agent.permission.*`, and the Codex `codex-app-server` protocol.
- **Out of scope**: relay/encryption layer (`tweetnacl`, `socket.io`), mobile clients, Codex sandbox/seatbelt paths, happy's deprecated `interactive.ts` PTY.

This document captures OriginRouter's current Codex + Claude Code runtime behavior, juxtaposes it against `happy`'s reference implementation at `/Users/chengaoyan/Desktop/happy`, and identifies the gaps that 8.0A fixes in-tree vs. defers to Stage 8.1 / 8.2. **File:line references are best-effort** — they reflect the working tree at the time of the audit. When in doubt, verify by function name and behavior.

## 1. Executive summary

OriginRouter 8.0 ships a working Codex v2 (`codex app-server`) adapter and a working Claude Code hook + JSONL path. Both are observable and stable. Compared against happy's reference, OriginRouter is **functionally correct on the hot path** (`initialize` → `thread/turn` → `item/*` → approval) but **lacks a layer of robustness** that happy treats as load-bearing: dedup, timeouts, process lifecycle, and replay protection.

### Biggest gaps

- Codex process is launched as `codex app-server` without `--listen stdio://` and without a semver gate. Works today; will break silently on protocol drift or pre-0.100 Codex CLIs. **Fixed in 8.0A.**
- No deduplication of duplicate `turn/completed` and no pending-approval timeout. OriginRouter trusts Codex to behave; happy does not. **Deferred to 8.1.**
- Claude hook forwarder is a one-shot `process.exit` with no retry/reconnect. **Deferred to 8.1.**
- No PTY/SDK event normalization — the two Claude paths emit diverging shapes (`session.started` only on PTY vs. `session.started` + `agent.sdk.metadata` on SDK). **Deferred to 8.2+.**
- `approved_for_session` collapsed to plain `{behavior:"allow"}`, silently failing to persist session-scoped rules. **Fixed in 8.0A.**

## 2. Methodology

All citations point to:

- **OriginRouter**: `/Users/chengaoyan/Desktop/originrouter-cli/` (working tree at audit time).
- **happy**: `/Users/chengaoyan/Desktop/happy/packages/happy-cli/` (reference).

### OriginRouter files audited

- `src/adapters/codex/appServerClient.js` — spawn, JSON-RPC loop, request/response dispatch, decision mapping, notification handling, approval routing, version probe.
- `src/adapters/codex/decisionMapping.js` — pure helper extracted from `appServerClient.js` in 8.0A.
- `src/adapters/codex/eventMapper.js` — Codex raw-event → OriginRouter `agent.*` mapping.
- `src/adapters/codexAdapter.js` — adapter lifecycle, `--model` detection, pending approvals, cleanup.
- `src/adapters/claude/hookServer.js` — HTTP server, `decisionToHookJson`, 55-second timeout.
- `src/adapters/claude/hookSettings.js` — Settings file generation.
- `src/adapters/claudeAdapter.js` — Claude adapter, hook wiring, `resolvePermission`, `scanStructuredEvents`.
- `src/adapters/claude/jsonlScanner.js` — JSONL scanner with replay guard.
- `src/adapters/terminalAdapter.js` — base adapter.
- `src/runtime/claudeSdkSession.js` — SDK path with `extractOriginrouterOptions`, `canUseTool` callback.
- `src/runtime/claudeSdkEvents.js` — SDK event mapping (emits `agent.sdk.metadata`).
- `src/local/localAgentSession.js` — PTY session loop, 1-second `scanStructuredEvents` poll.

### happy files audited

- `src/codex/codexAppServerClient.ts` — Codex JSON-RPC client, semver gate, `pendingTurnCompletion` dedup, `processEpoch`, `mapDecisionToWire`, MCP elicitation mapping.
- `src/codex/runCodex.ts` — Codex agent loop, `DEFAULT_CODEX_MODEL`, `HAPPY_RECONNECT_*` env contract, abort/kill handlers.
- `src/codex/utils/permissionHandler.ts` — approval decision routing.
- `src/codex/codexAppServerTypes.ts` — JSON-RPC types (Codex 0.107.0).
- `src/claude/runClaude.ts` — Claude loop, hook server, `recentAppPrompts` 5-min ring buffer, mode tracking, message queue.
- `src/claude/claudeLocalLauncher.ts` — Claude SDK path, session scanner integration.
- `src/claude/utils/startHookServer.ts` — hook server lifecycle.
- `src/claude/utils/sessionScanner.ts` — JSONL scanner with prompt dedupe.
- `src/utils/MessageQueue2.ts` — hashed dedupe of batched turns.

### Not audited

- happy's relay/encryption layer.
- happy's mobile clients.
- happy's `interactive.ts` PTY (annotated as deprecated in happy's own `CLAUDE.md`).
- Codex sandbox/seatbelt paths.

## 3. Codex process launch

| Concern | OriginRouter | happy | Risk | Must fix 8.0A? | Stage |
|---|---|---|---|---|---|
| Spawn command | `codex app-server` (after 8.0A: with `--listen stdio://`) | `codex app-server --listen stdio://` | low today / med on next protocol bump | yes | 8.0A ✅ |
| Spawner defaults helper | `node:child_process.spawn` directly per call site | shared `src/utils/spawn.js` (`shell:false`, `windowsHide:true`) for 2 production sites (`pipeExecutor`, `codexAppServerClient`) | low | shipped | 8.6 |
| `cross-spawn` migration | none | `cross-spawn` for Windows `.cmd`/`.ps1` shim safety | low on macOS/Linux; high on Windows | defer | platform hardening |
| Version probe | regex parse + gate `major > 0 \|\| minor >= 100` (8.0A); before: `--help` presence only | regex `/codex-cli\s+(\d+\.\d+\.\d+)/` + `major > 0 \|\| minor >= 100` | med (silent failure on pre-0.100) | yes | 8.0A ✅ |
| RPC timeout | 10s per request | 30s | low | no | 8.1 |
| `--model` injection | injects `--model originrouter-codex-model` unless user passed one (warn in that case) | `DEFAULT_CODEX_MODEL = 'gpt-5.5'` set at app level | low | no (move behind flag) | open question |
| Env hardening | `OPENAI_MODEL` defensive fallback | `RUST_LOG=codex_core::rollout::list=off` filter | low | defer | 8.1 |
| Sandbox env | not set | `CODEX_SANDBOX=seatbelt` conditional; env-contract regression test added | low | documented/probed (env contract test guards boundary; not shipped) | 8.6 |
| Initialize handshake | `clientInfo:{name:"originrouter",title:"OriginRouter",version:"0.1.0"}`, `capabilities:{experimentalApi:true}` | `name:"happy-codex"`, `version: packageJson.version` | low | no | 8.1 |
| `initialized` notification | not sent | sent | low | defer | 8.1 |

## 4. Codex message protocol

| Concern | OriginRouter | happy | Risk | Must fix 8.0A? | Stage |
|---|---|---|---|---|---|
| `codex/event` envelope passthrough | yes (`params.msg` is passed through to the event handler) | yes | none | no | — |
| `turn/started` | mapped to `task_started` with `turn_id` extracted from `params.turn.id \|\| turnId \|\| turn_id` | mapped to `task_started` | none | no | — |
| `turn/completed` status set | `cancelled`/`canceled`/`aborted` → `turn_aborted`; else `task_complete` | same + `interrupted`; plus `thread/status/changed` idle fallback | med | defer | 8.1 |
| `thread/status/changed` | not handled | handled (resolves idle turns) | low | defer | 8.1 |
| `thread/tokenUsage/updated` | passthrough | passthrough | none | no | — |
| Raw vs legacy protocol | not detected (matches on method names only) | `notificationProtocol: 'unknown' \| 'legacy' \| 'raw'` first-touch wins | low | defer | 8.1 |
| `item/started` + `commandExecution` | `exec_command_begin` (call_id, command, cwd) | same + `description` | low | no | — |
| `item/completed` + `commandExecution` | `exec_command_end` (call_id, command, cwd, output, exit_code, status) | same + `duration_ms` | low | no | — |
| `item/started` + `fileChange` | `patch_apply_begin` (call_id, changes) | same + `rawFileChangesByItemId` cache | low | no | — |
| `item/completed` + `fileChange` | `patch_apply_end` (call_id, status) | same + cleanup on `completed/failed/declined` | low | no | — |
| `item/completed` + `agentMessage` | mapped, `phase` preserved; **no turn-close hook** | mapped + `final_answer` resolves pending turn | med | defer | 8.1 |
| Unknown notifications | `codex.notification` passthrough | returns `true` for `item/*` prefix to claim | low | no | — |

## 5. Codex approval protocol

| Concern | OriginRouter | happy | Risk | Must fix 8.0A? | Stage |
|---|---|---|---|---|---|
| `item/commandExecution/requestApproval` | handled, dual-form mapping | handled via `handleApproval`, single wire form | low | no | — |
| `execCommandApproval` (legacy) | still recognized, dual-mapped to legacy wire | not in v2 protocol surface | low | open question | 8.0A vs 8.1 |
| `item/fileChange/requestApproval` | handled, dual-form | same shape as exec | low | no | — |
| `applyPatchApproval` (legacy) | dual-mapped | legacy surfaces not in v2 | low | open question | 8.0A vs 8.1 |
| `mcpServer/elicitation/request` | responds with `{action, content, _meta}` | same via `mapDecisionToMcpElicitationResponse` | low | no | — |
| Internal decision space | `approved / approved_for_session / denied / abort` | `ReviewDecision` same strings | none | no | — |
| Wire mapping (current protocol) | `approved→accept`, `approved_for_session→acceptForSession`, `denied→decline`, `abort→cancel` | identical | none | no (test it) | 8.0A ✅ |
| Wire mapping (legacy) | passthrough + reverse `accept→approved` etc. | legacy passthrough | low | no (test it) | 8.0A ✅ |
| `approved_execpolicy_amendment` (object) | not handled, falls through to `denied`/`decline` | pass-through | low | defer | 8.2 |
| Pending-approval cleanup on adapter exit | iterates map, resolves `"denied"`, clears, disconnects | relies on process exit + epoch rejection | low | no | — |
| Pending-approval timeout | none | none (happy has none either; relies on user reply) | med | defer | 8.1 |

## 6. Codex turn lifecycle

| Concern | OriginRouter | happy | Risk | Must fix 8.0A? | Stage |
|---|---|---|---|---|---|
| Turn-completion dedup | none — trusts server | `completedTurnIds: Set<string>` | med (dup → UI flicker) | defer | 8.1 |
| `pendingTurnCompletion` resolver | not implemented | full `markPendingTurnStarted` + `tryResolvePendingTurn` | low | defer | 8.1 |
| Stale-turn guard | none | `pending.turnId !== turnId` filter | low | defer | 8.1 |
| `ABORT_GRACE_MS` | not applicable (no `interruptTurn`) | 3000ms | low | defer | 8.2 |
| `reconnectAndResumeThread` | not implemented | full re-attach | med | defer | 8.2 |
| Process epoch | none | `processEpoch` rejects stale callbacks | low | shipped | 8.4 |
| Force-kill after SIGTERM | none (immediate SIGKILL on `disconnect`) | 2-second SIGKILL timer | low | shipped | 8.4 |

## 7. Claude contrast (PTY vs SDK vs happy)

| Concern | OriginRouter PTY (`claudeAdapter`) | OriginRouter SDK (`claudeSdkSession`) | happy | Risk | Must fix 8.0A? | Stage |
|---|---|---|---|---|---|---|
| Process model | PTY + `--settings <hookSettingsPath>` | `@anthropic-ai/claude-agent-sdk` `query()` | SDK unified | low | no | — |
| Hook server | HTTP on `127.0.0.1:0` | none — uses `canUseTool` callback | n/a (SDK only) | none | no | — |
| Hook forwarder | `scripts/claude-session-hook-forwarder.cjs` spawned per hook | n/a | n/a | shipped (retry + structured stderr) | shipped | 8.5 |
| SessionStart payload | `transcript_path` captured in `setTranscriptPath` | n/a | n/a | none | no | — |
| PermissionRequest resolution | HTTP held open 55s, written to on resolve | `canUseTool` Promise resolved from `agent.permission.resolve` | n/a | none | no | — |
| `decisionToHookJson` v1 | `approved_for_session` collapsed to `{behavior:"allow"}` (v1 stub) | n/a | n/a | med (rule not actually registered) | yes (echo) | 8.0A ✅ |
| `updatedPermissions` echo | not emitted | n/a | n/a | n/a | yes | 8.0A ✅ |
| JSONL scanner | `fileOffset` + `emittedSessionIds` dedupe | n/a | `createSessionScanner` ring buffer (5-min) | low | defer | 8.2 |
| Replay guard | `mapClaudeJsonLineSince` filters by `startedAt` timestamp | n/a | `recentAppPrompts` ring buffer | low | defer | 8.2 |
| `agent.sdk.metadata` | not emitted | emitted | n/a | low | defer | 8.2 |
| `--model` / `--fallback-model` | PTY passes through; no parsing | parsed in `extractOriginrouterOptions` | n/a | low | no | — |
| `--resume` | not parsed | parsed, both `--resume X` and `--resume=X` | n/a | low | no | — |
| `--permission-mode` | not parsed | parsed, default `"default"` | n/a | low | no | — |
| Non-interactive detection | `isNonInteractive` skips PermissionRequest hook | n/a | n/a | none | no | — |
| Scan loop | 1s `setInterval` in `localAgentSession.js` | n/a (SDK streams) | n/a | none | no | — |
| Pending-approval timeout | 55s hard, returns `denied` with `reason:"timeout"` | none | n/a | low | no | — |

## 8. Summary of fixes, deferrals, drops

- **Fixed in 8.0A** (4 small, audit-blessed):
  - `codex app-server --listen stdio://` flag on process launch.
  - Semver gate on `isCodexAppServerAvailable` (`major > 0 || minor >= 100`).
  - `mapDecisionToWire` extracted to a pure module + 17 unit tests.
  - `decisionToHookJson` emits `updatedPermissions` when `approved_for_session` is paired with non-empty `permissionSuggestions`. 2 unit tests added.
- **Deferred to Stage 8.1**: turn-completion dedup, pending-approval timeouts (Codex side), hook-forwarder reliability, raw/legacy protocol detection, `initialized` notification, `thread/status/changed` handling, `final_answer`-driven turn close, `RUST_LOG` env filter, RPC timeout bump to 30s.
- **Deferred to Stage 8.2+** (historical, as of end of 8.0A; current status in §11): `cross-spawn` migration, sandbox env, `approved_execpolicy_amendment` decision type, `ABORT_GRACE_MS`, `reconnectAndResumeThread`, process epoch, force-kill timer, replay ring buffer, `agent.sdk.metadata` parity in PTY, SDK/PTY event normalization layer. Process epoch and force-kill were subsequently shipped in Stage 8.4; spawn defaults helper landed in Stage 8.6.
- **Shipped Stage 8.6**: spawn defaults helper (`src/utils/spawn.js` → `spawnCommand` + `buildSpawnOptions` + `SPAWN_DEFAULTS`); Codex env-contract regression test (cases 31–34 in `tests/codexAppServerClient.test.js`); roadmap reshuffle. Stage 8.6 is a spawn defaults cleanup, not a `cross-spawn` migration.
- **Contracted Stage 8.7**: Claude SDK/PTY event normalization contract (`src/runtime/claudeEventContract.js` + `docs/agent-protocol.md` §10.13 + `tests/claudeEventContract.test.js` — 11 cases). Stage 8.7 is a design + contract-test stage; production wiring is a Stage 9+ architecture migration.
- **Contracted Stage 8.8, runtime-wired Stage 8.9**: generalized `agent.interaction.*` blocking-prompt envelope. Stage 8.8 shipped the pure helper (`src/runtime/agentInteractionContract.js` + `tests/agentInteractionContract.test.js` — 10 cases). Stage 8.9 wired the permission kind: dual-emit in `claudeAdapter.js` and `codexAdapter.js`; `handleRemoteEvent` accepts `agent.interaction.resolve`; `localApi.js` exposes `POST /sessions/:id/interaction`; `localAgentSession.js` emits one `agent.mode.status` per `session.started` (read-only); the temporary console renders the new envelope and shows a mode pill. `agent.permission.*` events remain emitted and consumed unchanged. New runtime test: `tests/agentInteractionRuntime.test.js` (8 cases). 8.9 does NOT ship raw terminal / confirm / select / text kinds, does NOT remove the legacy event, does NOT wire remote mode switching, does NOT change the relay protocol.
- **Dropped from this audit** (out of scope): relay/encryption, mobile clients, happy's PTY path (deprecated upstream).

## 9. In-tree fixes for 8.0A

### 9.1 `--listen stdio://` on Codex launch

**File**: `src/adapters/codex/appServerClient.js`, function `CodexAppServerClient#connect`.

**Before**: spawn args `["app-server"]`.
**After**: spawn args `["app-server", "--listen", "stdio://"]`.

**Why**: happy uses this arg (`codexAppServerClient.ts:394`); without it, protocol negotiation is implicit and may diverge on future Codex CLI versions.

**Risk if skipped**: low today; medium at next major protocol revision.

### 9.2 Codex semver gate

**File**: `src/adapters/codex/appServerClient.js`, function `isCodexAppServerAvailable`. Exports `parseCodexSemver` for direct unit testing.

**Behavior**: parses `codex --version` output (lenient about the `codex-cli ` prefix) into `{major, minor, patch}`. Returns `false` if missing or if `major === 0 && minor < 100`. Falls through to the `app-server --help` probe only after the gate passes.

**Why**: pre-0.100 Codex CLIs can return `app-server` in `--help` but the v2 protocol methods are not yet implemented. Without the gate, OriginRouter silently proceeds and fails downstream.

**Tests**: `tests/codexSemver.test.js` — 8 parser cases + 7 gate boundary cases.

### 9.3 `mapDecisionToWire` extracted + tested

**Files**: extracted to `src/adapters/codex/decisionMapping.js`. `appServerClient.js` keeps a thin class-method wrapper that delegates to the pure function so existing call sites (`this.mapDecisionToWire` from `handleServerRequest`) are unchanged.

**Tests**: `tests/codexDecisionMapping.test.js` — 23 cases (10 legacy + 13 non-legacy) covering both directions of the dual-form mapping, passthrough, default flag, and unknown inputs.

### 9.4 `updatedPermissions` echo in `decisionToHookJson`

**File**: `src/adapters/claude/hookServer.js`, function `decisionToHookJson`.

**Behavior**: signature changed from `(decision)` to `(decision, { permissionSuggestions } = {})`. When `decision === "approved_for_session"` AND `permissionSuggestions` is a non-empty array, emit `{behavior: "allow", updatedPermissions: permissionSuggestions}` so Claude Code persists a session-scoped rule. Otherwise keep the v1 plain `{behavior: "allow"}`.

**Wiring**: `buildPermissionRequestEvent(callId, payload)` extracts `permission_suggestions` from the hook payload into `event.permissionSuggestions`. The pending entry stored in `pendingPermissions` carries `permissionSuggestions: event.permissionSuggestions || []` so `resolvePermission` can pass them to `decisionToHookJson`. The four other call sites (adapter-throw, timeout, no-consumer) pass `{permissionSuggestions: []}` which triggers the v1 fallback.

**Tests**: `tests/permissionDecision.test.js` — 2 new cases: `approved_for_session + suggestions` echoes; `approved_for_session + empty suggestions` falls back to v1. `approved` (one-shot) never echoes even if suggestions are passed.

### 9.5 Turn-completion dedup + lightweight state machine

**File**: `src/adapters/codex/appServerClient.js`, class `CodexAppServerClient`.

**State**: `currentTurnId`, `turnOpen`, `completedTurnIds: Set<string>`, `completedTurnOrder: string[]` (FIFO for the bounded cap of 1000). `closeTurnIfOpen({ turnId, status, error, source })` is the single emit point for `task_complete` / `turn_aborted`. It allows close when either `turnOpen` is true OR a `turnId` is provided (so a missed `turn/started` does not silently drop the close), and dedups by `completedTurnIds`.

**Behavior**:
- `turn/started` → set `currentTurnId` + `turnOpen`, emit `task_started`.
- `turn/completed` → delegate to `closeTurnIfOpen` (status `interrupted`/`cancelled`/`canceled`/`aborted` → `turn_aborted`).
- Duplicate `turn/completed` for the same id → no-op.
- Bounded FIFO: once `completedTurnOrder.length > 1000`, the oldest turn id is evicted from both the order array and the dedup set.

### 9.6 Raw vs legacy protocol detection

**File**: `src/adapters/codex/appServerClient.js`, method `handleNotification`.

**State**: `notificationProtocol: "unknown" \| "legacy" \| "raw"`.

**Behavior**: the lock applies **only to lifecycle events** (`task_started`, `task_complete`, `turn_aborted` for legacy wrappers; `turn/started`, `turn/completed`, `thread/status/changed` for raw methods). Item/* notifications and unknown methods always pass through. First lifecycle touch wins; the opposite channel's lifecycle events are dropped to avoid double emission. Reasoning: tool calls (`item/started` / `item/completed` commandExecution / fileChange) may legitimately arrive on both channels and dedup-by-call-id would be a 8.2 concern; lifecycle dedup is a strict invariant.

### 9.7 `thread/status/changed` idle fallback

**File**: `src/adapters/codex/appServerClient.js`, method `handleNotification`.

**Behavior**: when `params.status?.type === "idle"` (or `params.status === "idle"`) AND `turnOpen` is true, close the turn as `task_complete`. Sources: `thread/status/changed idle` is recorded on the emitted event for diagnostics. This catches Codex flows that finish without an explicit `turn/completed`.

### 9.8 `agentMessage` final close

**File**: `src/adapters/codex/appServerClient.js`, `item/completed` branch with `item.type === "agentMessage"`.

**Behavior**: emit `agent_message`, then close the turn when **either** (a) `phase` is `"final"` or `"final_answer"` AND the item has non-empty text, **or** (b) `status === "completed"` AND `phase` is undefined (non-streaming CLI variant). Narrow predicate by design — intermediate items can carry `status: "completed"` during streaming.

### 9.9 Interrupted status mapping

**File**: `src/adapters/codex/appServerClient.js`, method `isAbortStatus`.

**Behavior**: status `interrupted` now joins `cancelled` / `canceled` / `aborted` as `turn_aborted`. Implemented once in `isAbortStatus` and reused by `closeTurnIfOpen`.

### 9.10 Per-server-request approval timeout

**File**: `src/adapters/codex/appServerClient.js`, method `withApprovalTimeout` + helper `denyPayloadFor`.

**Behavior**: each of the three server-request branches (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `mcpServer/elicitation/request` — plus their legacy siblings) is wrapped so the user-decision promise races against a 30s timer (`CODEX_APPROVAL_TIMEOUT_MS`). On expiry, the helper:
- Emits `codex.approval.timeout` with the **same callId the UI used to create the permission card** (not the JSON-RPC id) so the relay can match the pending card.
- Calls `this.respond(id, denyPayloadFor(approvalType, legacy))` exactly once.

A late user decision after timeout is dropped via a single `responded` flag; no double-response is possible. MCP denial payload: `{ action: "decline", content: null, _meta: null }`.

### 9.11 RPC timeout 30s + `codex.initialized` ready signal + `RUST_LOG` filter

**File**: `src/adapters/codex/appServerClient.js`.

**Behavior**:
- `request()` timeout raised from 10s to 30s (`CODEX_RPC_TIMEOUT_MS`). Timer handle is stored on the pending entry and cleared in `handleLine` on response arrival so it cannot fire after resolution.
- A writable guard rejects `request()` calls after `disconnect()` rather than letting them produce a synchronous write error.
- After the `initialize` handshake resolves, `connect()` emits `codex.initialized`. The eventMapper turns this into `agent.ready` so the relay can flip UI state from "connecting" to "ready".
- `connect()` builds `childEnv = { ...env, RUST_LOG: env.RUST_LOG \|\| "codex_core::rollout::list=off" }` and passes that to `spawn`. We never mutate `process.env`. The default suppresses noisy Codex rollout logs; user-set `RUST_LOG` wins.

`disconnect()` clears every pending RPC timer, every `_approvalTimers` entry, `completedTurnIds`, `completedTurnOrder`, `turnOpen`, and `currentTurnId` before issuing SIGTERM.

## 10. Deferred at end of 8.1 (still open)

Stage 8.1 closes the §10.1 / §10.2 items previously deferred from 8.0A. §10.3 (Claude hook forwarder reliability) was **not** in 8.1 scope — the Claude path was deliberately not touched. §10.3 was **shipped in Stage 8.5**; see §11 below for the current deferred list.

### 10.3 Hook forwarder reliability — **Shipped Stage 8.5**

The forwarder at `scripts/claude-session-hook-forwarder.cjs` now retries transient failures with bounded backoff (3 attempts, 50ms + 150ms delays). Per-attempt timeout is event-conditional: 5s for `SessionStart`, 58s for `PermissionRequest` (covers the local hook server's 55s hold-open). On retry exhaustion or fatal 4xx, the forwarder writes a structured JSON diagnostic to stderr and continues with the existing exit-0 stdout behavior. See `docs/agent-protocol.md` §10.11 for the full contract.

### 10.4 Happy-style `pendingTurnCompletion` resolver (still deferred)

Stage 8.1 covers dedup via `completedTurnIds`, but happy's full `markPendingTurnStarted` + `tryResolvePendingTurn` flow — which rejects stale callbacks by `pending.turnId !== turnId` and resolves a queued promise for the outer caller — is a Stage 8.2 concern. Out of scope for 8.1; the lightweight state in §9.5 is sufficient for the dedup invariant without the full resolver queue. Stage 8.4 shipped a different (process-level) `processEpoch` guard, but the turnId-level guard is still future.

### 10.5 `processEpoch` — **Shipped Stage 8.4**

`processEpoch` is now a counter on `CodexAppServerClient`, incremented at the top of `connect()` and checked in every async callback (stdout line, stderr data, child exit, request timeout, approval timeout). It is **not** touched by `disconnect()` — bumping it there would orphan the in-flight exit listener and the cleanup path would never run. See `src/adapters/codex/appServerClient.js` for the full contract.

## Stage 8.6 cleanup

Stage 8.6 is a **spawn defaults cleanup**, not a `cross-spawn`
migration. It does not change runtime semantics on macOS/Linux.

- Audits every process-spawning call site (11 total) and applies
  a small shared helper (`src/utils/spawn.js` →
  `spawnCommand` + `buildSpawnOptions` + `SPAWN_DEFAULTS`) where
  two production sites benefit (`pipeExecutor`,
  `codexAppServerClient`). The other 9 sites are intentionally
  left alone: 4 are test-only, 1 uses `node-pty`'s `pty.spawn`
  (different API), 2 use caller-specific `stdio`/`env` shapes
  (`src/index.js run`, `tmuxExecutor`), 1 is `detect.js`'s
  detection probe (`stdio:["ignore","pipe","pipe"]` with a clean
  stdin), 1 is the `proxyManager.test.js` mock factory.
- Locks the Codex app-server env contract with four focused
  regression tests (`tests/codexAppServerClient.test.js` cases
  31–34): `RUST_LOG` default applied, user-supplied `RUST_LOG`
  preserved, `CODEX_SANDBOX` **not** injected by default,
  user-supplied `CODEX_SANDBOX` preserved. This is the safety
  net for the still-deferred sandbox work.
- Refreshes the roadmap framing after Stage 8.5 (this section +
  §11 reshuffle).

`cross-spawn` migration remains explicitly deferred to platform
hardening — see §11.

## Stage 8.7 Claude SDK / PTY event normalization plan

Stage 8.7 is a **design + contract-test stage**. It does
**not** refactor the session runners.

**What it ships:**

- Event-shape audit table for Claude PTY vs SDK (below).
- Normalized target contract documented in
  `docs/agent-protocol.md` §10.13.
- Pure fixture helper in
  `src/runtime/claudeEventContract.js` —
  `CLAUDE_RUNTIMES`, `CLAUDE_PROVIDER`,
  `normalizeClaudeSessionStarted`, `withClaudeRuntime`,
  `normalizeClaudeEvent`. Not wired into production.
- `tests/claudeEventContract.test.js` — 11 cases.

**What remains deferred:**

- Wiring the mapper into `runLocalAgentSession`.
- SDK session runner output migration (e.g. renaming
  `agent.task.completed` → `agent.task.complete`).
- Daemon path SDK migration.
- UI / client adaptation.
- Migrating PTY `runtime: null` → `runtime: "claude-pty"`
  on `session.started`.
- `agent.text` → `agent.message` rename.

### Audit table (PTY vs SDK, today)

| Event | PTY path today | SDK path today | Target normalized shape |
|---|---|---|---|
| `session.started` | `runtime: null`, `startedBy: "local-wrapper"`, `metadata.adapter: "claude"` | `runtime: "claude-sdk"`, `startedBy: "local-sdk"`, `metadata.adapter: "claude-sdk"` | `runtime` top-level + `metadata.runtime` mirror |
| `terminal.output` | yes | n/a | unchanged, terminal-only |
| `agent.ready` | not emitted | `{ provider: "claude", message }` (no `runtime`) | `{ provider, runtime }` |
| `agent.task.*` (current SDK name: `agent.task.completed`; future target: `agent.task.complete`) | not emitted | `agent.task.completed` (current SDK emission) | contract documents `agent.task.complete` as future target; SDK continues to emit `agent.task.completed`; helper does NOT rename; wiring is a future stage |
| `agent.text` | yes (JSONL scanner omits `provider`) | yes (has `provider`) | unified `{ provider, runtime }`; future `agent.message` rename is acknowledged but **deferred** beyond Stage 8.7 |
| `agent.permission.request.detected` | yes + `permissionSuggestions`; no `runtime` | yes, no `permissionSuggestions`; no `runtime` | unified shape; add `runtime` |
| `agent.permission.resolved` | yes + `sessionRulePending`; no `runtime` | yes; no `runtime` | unified shape; `sessionRulePending` is PTY extension |
| `agent.usage` | not emitted | not emitted today | SDK-only when shipped |
| `agent.sdk.metadata` | not emitted | yes (no `runtime`) | SDK-only extension; add `runtime: "claude-sdk"` |

**Daemon path:** out of audit table for Stage 8.7.
Documented as "current behavior, not migrated" per the
user's framing.

### Evidence trail (file-level)

- `src/local/localAgentSession.js` — PTY `session.started`
  payload assembly; top-level `runtime` derivation
  (`metadata.runtime ?? null`).
- `src/runtime/claudeSdkSession.js` — SDK `session.started`,
  `agent.ready`, `agent.permission.request.detected`,
  `agent.permission.resolved` emissions.
- `src/runtime/claudeSdkEvents.js` — SDK-side event shaping:
  `agent.session_id`, `agent.sdk.metadata`, `agent.text`,
  `agent.thinking`, `agent.tool_call.*`, `agent.task.completed`.
- `src/adapters/claude/claudeAdapter.js` — `describe()` PTY
  metadata; `agent.session.start`; `agent.permission.resolved`
  with `sessionRulePending` and `reason: "timeout"`.
- `src/adapters/claude/jsonlScanner.js` — JSONL-scanner
  emissions that omit `provider`: `agent.session_id`,
  `agent.text`, `agent.thinking`, `user.text`.
- `src/adapters/claude/hookServer.js` — PTY
  `agent.permission.request.detected` with
  `permissionSuggestions` and the `resolution` envelope.

Line numbers are not pinned. The audit cites files only so
the trail stays stable across doc/test churn.

## Stage 8.8 interactive blocking prompt contract

Stage 8.8 introduces a generalized blocking-prompt envelope
(`agent.interaction.requested` and `agent.interaction.resolve`)
so 9.0+ can add `confirm`, `single_select`, `multi_select`,
`free_text`, and a labeled `raw_terminal` escape hatch without
another migration. This stage is **contract-test only** — no
production wiring, no UI work, no TUI parser, no provider/auth/
login (those are Stage 9.0).

**What it ships:**

- Pure helper in
  `src/runtime/agentInteractionContract.js` —
  `INTERACTION_KINDS`, `INTERACTION_SOURCES`,
  `permissionEventToInteraction`, `interactionToPermissionEvent`
  (permission-only), `buildInteractionResolved`,
  `isInteractionRequest`, `isInteractionResolve`. Not wired
  into production.
- `tests/agentInteractionContract.test.js` — 10 cases.
- `docs/agent-interaction-contract.md` — full contract doc.
- `docs/agent-protocol.md` §10.14 — wire-protocol entry.
- This section — audit table + file-level evidence trail.

**What remains deferred (Stage 9.0+):**

- Wiring into `runLocalAgentSession.handleRemoteEvent`,
  the Claude PTY hook server, the Codex app-server client, the
  relay, the daemon, and any UI.
- UI rendering for non-permission kinds
  (`confirm` / `single_select` / `multi_select` / `free_text` /
  `raw_terminal`).
- Payload schemas for `value` / `data` on non-permission kinds.
- Pending-state machine (caller's job; the helper is pure).
- `updatedPermissions` echo (already lives in
  `hookServer.js#decisionToHookJson`).
- A dedicated `agent.interaction.canceled` event, if the UI
  ever needs the distinction. In 8.8, cancellation is expressed
  as `{ type: "agent.interaction.resolve", decision: "abort" }`.

### Audit table (Claude PTY / Happy reference / Codex / Stage 8.8 target)

| Surface | Claude PTY today | Happy reference | Codex today | Stage 8.8 target |
|---|---|---|---|---|
| **Pending request map** | `pendingPermissions` Map keyed by callId (in-memory, 55s timeout) | `pendingRequests` Map keyed by `toolUseID` (in-memory, with `abortAll()` and `reset(reason)`) | `pendingApprovals` Map keyed by callId (in-memory, 30s per-request timeout) | **not invented** in 8.8 — adapter-owned today; contract-level pending-tracking is a Stage 9.0+ concern |
| **Detect event** | `agent.permission.request.detected` (provider=claude, callId, tool, input, permissionSuggestions, resolution.decisions) | `handlePermissionRequest` → `push.sendSessionNotification({ kind: 'permission' })` | `agent.permission.request.detected` (provider=codex, callId, tool, input, resolution.decisions) | `agent.interaction.requested` with `kind: "permission"`, `interactionId`, `source` (hook/app-server), provider, tool, input, permissionSuggestions, resolution |
| **Resolve event** | `agent.permission.resolve` (callId + decision) | `handlePermissionRequest` response (accept/acceptForSession/decline/cancel) | JSON-RPC response to app-server (`accept`/`acceptForSession`/`decline`/`cancel`) | `agent.interaction.resolve` with `interactionId`, `decision`, optional `value` and `data` |
| **Tool gating (ExitPlanMode/AskUserQuestion)** | not gated (PTY accepts Claude Code's own UI) | `handleToolCall` short-circuits `AskUserQuestion` → `handlePermissionRequest`; `ExitPlanMode` always requires user approval (`descriptor.exitPlan` check) | n/a (no tool gating in Codex today) | Reserved kinds `confirm` / `single_select` / `multi_select` / `free_text`; 8.8 documents, 9.0+ implements |
| **Raw fallback** | `terminal.input` via `/client/input` → PTY stdin | Raw terminal bytes via `terminal.input` (Happy retains the same escape hatch) | app-server always structured; no raw fallback | `data` field on `agent.interaction.resolve` (labeled escape hatch); `terminal.input` remains available |
| **Notification kind taxonomy** | n/a (single permission channel) | `done \| permission \| question` (coarse session notifications) | n/a | Reserved: `permission` (today); `question` (future confirm/select/text); deferred to 9.0+ |

### Evidence trail (file-level, no line numbers pinned)

- `src/adapters/claude/hookServer.js` — Claude PTY
  `pendingPermissions`, 55s timeout,
  `buildPermissionRequestEvent` shape, `decisionToHookJson`
  mapping for `updatedPermissions` echo.
- `src/adapters/codex/eventMapper.js#mapCodexApprovalRequest` —
  Codex app-server shape (callId synthesis from
  `request.callId || params.callId || params.call_id || ...`).
- `src/adapters/codex/decisionMapping.js#mapDecisionToWire` —
  Codex decision-to-wire vocabulary
  (`accept` / `acceptForSession` / `decline` / `cancel`).
- `src/local/localAgentSession.js` — current `handleRemoteEvent`
  switch handles only `terminal.input`, `terminal.resize`,
  `terminal.interrupt`, `agent.permission.resolve`,
  `session.stop`; no general interaction envelope.
- `src/runtime/agentInteractionContract.js` — new 8.8 helper
  (NOT wired into production).
- `tests/agentInteractionContract.test.js` — 10-case test.
- `docs/agent-interaction-contract.md` — full contract doc.
- `docs/agent-protocol.md` §10.14 — wire-protocol entry.
- `happy-cli/src/utils/BasePermissionHandler.ts` —
  `pendingRequests` Map, `abortAll()`, `reset(reason)` reference.
- `happy-cli/src/claude/utils/permissionHandler.ts` —
  `AskUserQuestion` short-circuit and `ExitPlanMode`
  always-gated reference.
- `happy-cli/src/codex/utils/permissionHandler.ts` — Codex
  subclass of `BasePermissionHandler` (auto-approve allowlist
  for `change_title`).
- `happy-cli/src/claude/utils/questionNotification.ts` —
  `AskUserQuestion` tool-call ID extraction reference.
- `happy-app/sources/sync/apiTypes.ts` — `done | permission |
  question` coarse kind taxonomy reference
  (`ApiEphemeralSessionEventUpdateSchema`).

## Stage 8.9 — runtime wiring

Stage 8.9 is the first runtime-wiring stage. The
`agent.interaction.*` envelope from Stage 8.8 is dual-emitted
from the adapter layer, accepted by the local session, and
exposed to the temporary console. A new local API route
handles the new envelope. A read-only mode/status surface
(`agent.mode.status`) is added.

**Scope (narrowly permission-kind):**

- Production imports the helper
  (`src/runtime/agentInteractionContract.js`).
- Claude PTY hook and Codex app-server approval push BOTH
  legacy `agent.permission.request.detected` AND new
  `agent.interaction.requested` for every permission request.
- The new envelope's resolve routes to the existing permission
  resolver. Unknown-id errors continue to use
  `agent.permission.resolve.error` (compatibility strategy for
  8.9).
- `localApi.js` exposes `POST /sessions/:id/interaction`.
- `localAgentSession.js` emits one `agent.mode.status` per
  session on `session.started`. **Read-only in 8.9** —
  `modeControl: "unsupported"`. Remote mode switching is
  Stage 9.0+.
- The temporary console renders the new envelope and shows a
  mode pill. The console does NOT add a per-card raw terminal
  input (no production emits `kind: "raw_terminal"` in 8.9;
  raw terminal control today uses the existing standalone
  `terminal.input` event).

**What 8.9 does NOT claim (to prevent 9.0 miscommunication):**

- 8.9 does NOT support `kind: "raw_terminal"` from production
  adapters. The console does NOT add a per-card raw input.
  The `data` field on the resolve envelope is a defensive
  guard only.
- 8.9 does NOT support `kind: "confirm"`, `single_select`,
  `multi_select`, or `free_text` resolve. The renderer skips
  these with a debug log if a non-permission envelope arrives.
- 8.9 does NOT support remote mode switching. The mode pill
  is read-only.
- 8.9 does NOT replace `terminal.input`. The legacy terminal
  control path stays exactly as today.

### Audit table delta (Stage 8.9)

| Surface | Stage 8.8 target | Stage 8.9 status |
|---|---|---|
| **Dual-emit (Claude PTY)** | documented; not wired | `claudeAdapter.js#onPermissionRequest` pushes both envelopes. `sessionId` enriched from `this.sessionId`. `runtime: null` matches current `session.started` (Stage 8.7 `claude-pty` not back-ported). |
| **Dual-emit (Codex)** | documented; not wired | `codexAdapter.js#onApproval` pushes both envelopes. `sessionId` enriched; `runtime: "codex-app-server"` when the structured path is active, `null` otherwise. `pendingApprovals` stays keyed by `callId` (which equals `interactionId`). |
| **Resolve routing** | reserved; resolve-error was silent per Happy pattern | `handleRemoteEvent` accepts `agent.interaction.resolve` and routes to `adapter.resolvePermission`. Codex adapter accepts `interactionId` as alias for `callId`. Unknown-id emits the existing `agent.permission.resolve.error` (re-used for compatibility). |
| **Mode/status display** | not in scope | `localAgentSession.js` emits `agent.mode.status` once per `session.started`. `provider` mapped from local `agent` command. `runtime` mirrors `session.started`. `availableModes` matches the planned 9.0+ vocabulary. `modeControl: "unsupported"`. |
| **Live mode switching** | not in scope | Not wired. 8.9 supports viewing only. Switching is Stage 9.0+. |
| **Raw terminal fallback** | documented as `data` field on resolve envelope | `data` is a defensive fallback only in `handleRemoteEvent`. The console does NOT add a per-card raw input. For raw terminal control today, callers use the existing `terminal.input` event. |
| **Local API route** | not in scope | `POST /sessions/:id/interaction` accepts `{ interactionId, decision, value?, data?, reason? }`. The legacy `/sessions/:id/permission` is unchanged. |
| **Console dedup** | not in scope | `renderInteractionRequest` checks `knownCallIds` for `event.interactionId || event.callId`; if a card exists, it updates state in place rather than creating a duplicate. |
| **Test console UI** | not in scope | `originrouter-test/local-console.html` (outside the CLI repo) adds `renderInteractionRequest`, `renderModeStatus`, `renderResolveError`, and a `Mode:` pill in the top bar. |

### Evidence trail (file-level, no line numbers pinned)

- `src/adapters/claudeAdapter.js` — dual-emit in
  `onPermissionRequest`; `hookServerFactory` test seam.
- `src/adapters/codexAdapter.js` — dual-emit in `onApproval`;
  `appServerClient` / `appServerAvailable` test seams;
  `resolvePermission` accepts `interactionId` alias.
- `src/local/localAgentSession.js` — `handleRemoteEvent` extracted
  to a named exported helper; new `agent.interaction.resolve` arm;
  `agent.mode.status` emission after `session.started`; new
  exported `buildModeStatusEvent` helper.
- `src/local/localApi.js` — new `interaction` branch in
  `handleSessionControl` and the session-action regex match.
- `originrouter-test/local-console.html` — `renderInteractionRequest`,
  `renderModeStatus`, `renderResolveError`; three new event-type
  arms; `interaction` entry in `localMap` and `relayMap`;
  `Mode:` pill in the top bar; top-of-file comment updated.
- `tests/agentInteractionRuntime.test.js` — 8 cases (new).
- `tests/permissionDecision.test.js` — 1 new round-trip
  assertion.
- `tests/codexAppServerClient.test.js` — 1 new round-trip
  assertion.
- `package.json` — test chain gains one new suite; suite count
  bumps to 22.

## 11. Post-8.6 deferred work

Open items that have not landed in any 8.x stage. Some of these are
small (sandbox env) and others are full architecture migrations
(reconnect / resume, SDK/PTY normalization).

### Architecture migrations (Stage 9+)

- **`reconnectAndResumeThread`** — full thread re-attach. (Stage
  8.4 hardens lifecycle; it does NOT reconnect or resume. This is
  a Stage 9+ architecture migration: turn/start queue,
  resume-thread-id reconciliation, replay ring buffer all need
  to be designed together.)
- **SDK/PTY event normalization layer** — single `agent.*`
  projection with adapter-specific feeds. **Contracted Stage
  8.7** (`src/runtime/claudeEventContract.js`,
  `docs/agent-protocol.md` §10.13). Implementation (wiring
  into `runLocalAgentSession` and the SDK runner) remains a
  Stage 9+ architecture migration.
- **`agent.interaction.*` blocking-prompt envelope** —
  generalized `agent.interaction.requested` /
  `agent.interaction.resolve` envelope that supersedes
  `agent.permission.*` for UI rendering. **Contracted Stage
  8.8, runtime-wired Stage 8.9** for the permission kind.
  `src/runtime/agentInteractionContract.js` is now imported
  by the production adapters (`claudeAdapter.js`,
  `codexAdapter.js`), the local session
  (`localAgentSession.js`), and the local API
  (`localApi.js`). The temporary console renders the new
  envelope. **Remaining work for Stage 9.0+:** payload
  schemas for non-permission kinds, a dedicated
  `agent.interaction.resolve.error` (if a UI needs the
  distinction from `agent.permission.resolve.error`), and
  removal of the legacy `agent.permission.*` events.
- **Live mode switching (Claude + Codex)** — Stage 8.9 ships
  `agent.mode.status` as **read-only** with
  `modeControl: "unsupported"`. Live switching requires
  `--permission-mode` flag parsing in the CLI and Codex
  `approvalPolicy` overrides in the app-server protocol
  (neither exists today). Stage 9.0+ concern.
- **`raw_terminal` interaction kind** — Stage 8.9 reserves
  the kind but does not emit it from any production adapter
  and does not render it in the console. The
  `data` field on the resolve envelope is a defensive
  fallback only; for raw terminal control today, callers
  use the existing `terminal.input` event. Stage 9.0+
  concern.
- **Non-permission kinds (`confirm`, `single_select`,
  `multi_select`, `free_text`)** — Stage 8.9 reserves the
  names but does not emit or render them. If Claude/Codex
  ever exposes them as structured tool/permission events
  in the current path, the renderer can light up; otherwise
  they remain documented targets.
- **Replay ring buffer** — `recentAppPrompts` 5-minute window
  for app-prompt dedupe.

### Platform hardening

- **`cross-spawn` migration** — needed for Windows `.cmd`/`.ps1`
  npm wrappers. Stage 8.6 only added `windowsHide: true` +
  `shell: false` defaults via `src/utils/spawn.js`; cross-spawn
  is not in scope.
- **Sandbox env** — `CODEX_SANDBOX=seatbelt` conditional. Not
  enabled by default in 8.6; the env-contract test now guards
  the boundary (cases 31–34 in
  `tests/codexAppServerClient.test.js`).
- **`approved_execpolicy_amendment`** decision type —
  pass-through for object-shaped approvals.
- **`ABORT_GRACE_MS`** — 3000ms before force-restart.
- **`agent.sdk.metadata` parity in PTY** — either fetch from a
  session manifest or document the divergence.

## 12. Open questions

1. **Legacy dual-form mapping**: `execCommandApproval` and `applyPatchApproval` are still recognized and mapped to legacy wire format. happy has dropped them from the v2 surface. **8.0A kept them** pending telemetry. As of 8.1, the legacy mapping is fully exercised by the focused test suite (`tests/codexAppServerClient.test.js` cases 13 and the `legacy=true` paths in `tests/codexDecisionMapping.test.js`), so the legacy fallback remains in tree. **Status: kept; revisit in 8.2.**

2. **`--model` injection behind a flag**: Today `codexAdapter.js#buildLaunch` injects `--model originrouter-codex-model` unless the user passed one. happy's equivalent is at the `runCodex.ts` level (`DEFAULT_CODEX_MODEL = 'gpt-5.5'`). Should we move the injection behind `routes.codex.autoInject` (config-driven) and treat explicit `--model` as the only non-config path? — **Open.**

3. **PTY vs SDK divergence**: `claudeAdapter.js` (PTY) and `claudeSdkSession.js` (SDK) emit different event shapes. PTY emits `session.started` only; SDK emits `session.started` plus `agent.sdk.metadata`. Happy's `CLAUDE.md` annotates its own PTY (`interactive.ts`) as "LIKELY DEPRECATED in favor of running through SDK." Should we treat SDK as Phase 1 primary and PTY as documented legacy, or remove PTY in 8.1? — **Open.**

## 13. Verification

### Automated

```bash
cd /Users/chengaoyan/Desktop/originrouter-cli
node ./tests/codexDecisionMapping.test.js      # 23 cases green
node ./tests/codexSemver.test.js               # 15 cases green
node ./tests/permissionDecision.test.js        # 13 cases green (12 baseline + 1 Stage 8.9 round-trip)
node ./tests/codexAppServerClient.test.js      # 35 cases green (34 baseline + 1 Stage 8.9 round-trip)
node ./tests/codexE2eOffline.test.js           # 12 cases green (Stage 8.3)
node ./tests/adapters.test.js                  # extended with 5 Stage 8.4 + 2 Stage 8.1 cases
node ./tests/hookForwarder.test.js             # 10 cases green (Stage 8.5)
node ./tests/spawnCommand.test.js              # 5 cases green (Stage 8.6)
node ./tests/claudeEventContract.test.js       # 11 cases green (Stage 8.7)
node ./tests/agentInteractionContract.test.js  # 10 cases green (Stage 8.8)
node ./tests/agentInteractionRuntime.test.js   # 8 cases green (Stage 8.9)
npm test                                       # full chain green (22 suites + 2 binary smokes)
```

### Manual (CLI)

**Turn dedup + idle fallback + interrupted mapping (9.5, 9.7, 9.9)**: `originrouter codex "say hi"`. Inspect relay stream — exactly one `agent.task.complete` per turn. Force a `thread/status/changed` (close Codex stdin mid-stream) and confirm `agent.task.complete` is still emitted exactly once. Trigger a `turn/completed` with `status:"interrupted"` (test harness) and confirm `agent.task.aborted`.

**Protocol lock (9.6)**: in a Codex CLI that emits both raw `turn/started` and legacy `codex/event { msg: { type: "task_started" } }`, only one `task_started` is observed. Non-lifecycle events (e.g. `agent_message`) still pass through on both channels.

**agentMessage final close (9.8)**: feed Codex a `item/completed agentMessage` with `phase: "final"` and non-empty text. Confirm one `agent_message` and one `agent.task.complete`.

**Approval timeout (9.10)**: trigger a Bash tool call, do not answer. Within 30s the relay must receive `agent.permission.resolved decision:"denied" reason:"timeout"` and Codex must receive `decision:"decline"`. Confirm the underlying Codex request is auto-declined (no follow-up response permitted).

**Ready event (9.11)**: `originrouter codex "say hi"`. First Codex lifecycle event must be `agent.ready` with `provider:"codex"`.

**`RUST_LOG` filter (9.11)**: `RUST_LOG=info originrouter codex "say hi"` — user override wins. Without the env var, only non-rollout logs appear. Confirm `process.env.RUST_LOG` is **not** mutated by reading it from a side channel after connect.

**RPC timeout (9.11)**: cover by `tests/codexAppServerClient.test.js` case 11 (5ms timeout, no response). Manual probe not required.

### Out-of-scope regressions to verify

- `npm test` still green (16 suites, including the new `codexAppServerClient.test.js`).
- `tests/codexDecisionMapping.test.js` and `tests/codexSemver.test.js` still green — the new `withApprovalTimeout` uses `mapDecisionToWire` and the legacy/new wire mapping must not regress.
