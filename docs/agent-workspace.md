# Agent Workspace

Agent Workspace is the prompt-first terminal entry for managed Codex, Claude
Code, and multi-Agent collaboration. It keeps the user in OriginRouter while
the daemon owns the underlying managed Agent sessions and durable Run.

## Workspace Session and Runs

A Workspace Session is the durable conversation and team boundary. Each user
objective creates a separate, finite Run inside that Session, so its plan,
approvals, task graph, audit history, and final result stay independently
inspectable. Completing a Run therefore does not end the workspace: enter the
next objective to continue the Session. Use `/new` when you intentionally want
a new Session with no inherited team or Agent context.

The first objective after opening a new Workspace Session performs Team
selection and plan review. OriginRouter persists that Session Team as revision
1, including each member's runtime, trusted device, registered workspace,
model route, permission boundary, role hint, and safe native conversation
reference. Later objectives create new Runs but do not call automatic Team
selection or build a new task DAG first. They go directly to the primary Agent,
which may handle the turn itself or use the OriginRouter MCP gateway to list,
ask, and delegate to the existing Team.

The primary Agent cannot silently broaden the Session boundary. If a later
objective needs another device, workspace, runtime, model route, or permission
profile, it must call `request_team_change`. OriginRouter records an immutable
proposed Team revision and shows the exact member/binding change for local user
confirmation. Until confirmation, the old revision remains authoritative and
the new participant cannot receive work. Confirmation updates the Session and
current Run; unchanged members retain their native context while changed
members start fresh. Rejection resumes within the existing boundary.

`/resume <session-id>` restores the Workspace Session at its latest Run and
latest confirmed Team revision. Run IDs are deliberately not accepted by this
command: a Session is an ordered conversation, so an older Run cannot become a
new continuation point or implicit branch. Use `/new` for an intentional new
project, context, or trust boundary.

When a Run completes, managed Agent wrappers are released. The daemon retains
the safe native-session references required for a compatible later follow-up;
it does not leave an idle process group running. Reopening Workspace and using
`/resume <session-id>` restores the latest Session context before the next
objective is submitted.

## Multi-device transport and ownership

The coordinating CLI is the owner of the Workspace Session Team record. It is
stored in the coordinator's local collaboration database; the OriginRouter
Server, App, and MySQL do not store Team membership or native Agent session
references. MySQL may store only display-safe continuity identifiers used by
the App: Workspace Session ID, previous Run ID, Team revision number, and the
continuation flag. Server bridge, proxy URL, and direct IP/domain deployments
all use the existing authenticated Relay configuration.

Cross-device work follows one path:

```text
Coordinator CLI
  -> authenticated E2EE Relay / Server bridge
  -> target CLI
  -> target machine's loopback-only managed supervisor
```

Remote dispatch, Agent results, MCP requests/responses, capability checks, and
workspace trust requests are end-to-end encrypted between trusted devices.
The server routes ciphertext and presence only. Attempt numbers, fencing
tokens, leases, source/target device checks, registered-workspace checks, and
the target CLI's local approval policy remain authoritative. No new
cross-machine local API or unauthenticated direct coordinator port is opened.

## Entry points

Open the workspace in the current directory:

```sh
originrouter
```

Run one objective directly:

```sh
originrouter "Fix the login timeout and add regression tests"
originrouter -c claude --mode build-review "Implement and review the change"
```

`-c` / `--coordinator` accepts `codex` or `claude`; Codex is the default.
`--mode` / `--team` accepts:

- `auto`
- `solo`
- `build-review`
- `plan-build-verify`
- `parallel-research`
- `review-panel`
- `remote-ops`

Inside the interactive workspace, `/mode <name>` changes mode and Shift+Tab
cycles modes. `/coordinator codex|claude` changes the preferred coordinator.

## Managed runtime boundary

Agent Workspace does not replace the Codex or Claude execution engine. It
creates the same daemon-owned collaboration Run used by the App and advanced
`originrouter collaboration` commands. The Run dispatches managed Codex
app-server or Claude Agent SDK sessions, normalizes their structured events,
and preserves approval, budget, audit, resume, and remote-device semantics.

Native escape hatches remain available:

```sh
originrouter codex
originrouter claude
```

Native TUI sessions expose a smaller structured-control surface than managed
sessions and are not the default Agent Workspace runtime.

## Auto mode

Auto mode selects the smallest useful collaboration shape without sending the
objective to the OriginRouter control server. Device capability discovery is
performed first, then deterministic local classification selects an initial
mode. The read-only Planner still creates and validates the actual task DAG.

Cloud-assisted planning is opt-in:

```sh
originrouter --cloud-advice "Compare safe rollout strategies"
```

Only the objective and a typed capability summary containing runtime names and
counts are sent to the AI Server. Device IDs, workspace paths, route provider
names, model names, credentials, and environment values are excluded. The AI
response is advisory: a manually selected mode remains fixed, deterministic
risk may be raised but never lowered, and any error or unavailable recommendation
falls back to local planning.

Current classifications include:

- explanation and small questions: Solo;
- implementation and fixes: Build + Review;
- production, deployment, migration, security, and large cross-module work:
  Plan + Build + Verify;
- investigations and audits: Parallel Research;
- architecture decisions and approach comparisons: Review Panel;
- remote service and server requests: Remote Ops.

Explicit mode selection is a Planner constraint rather than a display-only
preference.

## Confirmation policy

Routine local workspace objectives use the active guarded permission profile
and can start after planning without an extra plan prompt. Production,
deployment, release, destructive, privileged, payment, database-migration, and
Remote Ops objectives require explicit interactive review. Tool-level approval
policies remain authoritative regardless of plan confirmation.

## Interactive commands

```text
/status               show workspace settings and the latest Run
/runs [category]      list Runs; category is active, recent, or all
/resume <session-id>  restore the Session at its latest ordered Run
/attach <run-id>      follow a known Run without creating another Run
/pause [run-id]       pause the latest or named Run
/retry [run-id]       retry the latest or named Run
/cancel [run-id]      cancel the latest or named Run
/agents [run-id]      show assigned Agents and their selected routes
/mode [name]          show or change collaboration mode for the next Run
/approval [profile]   show or change Session approval
/coordinator <agent>  choose codex or claude for the next Run
/team                 show the next team constraint
/new                  start a fresh Workspace Session after a completed Run
/help [command]       show available commands or one command's usage
/exit                 exit Agent Workspace
```

Typing `/` opens matching command suggestions. Use Up/Down to select a
candidate, Tab to insert it without executing it, and Esc to hide the list;
Enter submits only the text already in the composer. Suggestions also complete
mode names, approval policies, coordinator runtimes, Run categories, known Run
IDs for Run controls, and known Session IDs for `/resume`. Commands that
operate on a Run use the OriginRouter Run ID, not a Codex thread ID or a Claude
conversation UUID. `/resume <session-id>` resolves the Session's latest Run;
when that Run is paused, Workspace asks for confirmation before it continues.
A completed latest Run remains available as the latest result and accepts a
new objective in the same Session. Historical Runs remain inspectable but
cannot be resumed as alternate conversation endpoints.

Closing the foreground viewer does not cancel a daemon-owned Run. The advanced
`originrouter collaboration` commands remain available for scripting, JSON
output, exports, diagnostics, and task-level controls.

`/model` and `/compact` are intentionally not Workspace commands yet. A
collaboration Run can contain several managed Agent sessions, so changing a
route or compacting context needs an explicit per-Agent or next-Run scope; the
Workspace does not imply a cross-Agent live change it cannot guarantee.

## Parallel-write safety

Read-only and verification tasks may run in parallel up to the Run budget.
`workspace_write` tasks targeting the same trusted workspace are serialized.
This fail-closed rule prevents concurrent Agents from overwriting one another;
isolated worktree execution is not assumed unless a future integration can
also prove and audit the merge step.
