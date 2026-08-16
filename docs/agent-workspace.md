# Agent Workspace

Agent Workspace is the prompt-first terminal entry for managed Codex, Claude
Code, and multi-Agent collaboration. It keeps the user in OriginRouter while
the daemon owns the underlying managed Agent sessions and durable Run.

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
/mode [name]          show or change collaboration mode
/coordinator <agent> choose codex or claude
/team                 show the active team constraint
/help                 show workspace commands
/exit                 exit Agent Workspace
```

Closing the foreground viewer does not cancel a daemon-owned Run. Existing
`collaboration attach`, `pause`, `resume`, `cancel`, and attention commands
remain the advanced control surface.

## Parallel-write safety

Read-only and verification tasks may run in parallel up to the Run budget.
`workspace_write` tasks targeting the same trusted workspace are serialized.
This fail-closed rule prevents concurrent Agents from overwriting one another;
isolated worktree execution is not assumed unless a future integration can
also prove and audit the merge step.
