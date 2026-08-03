# OriginRouter Agent MCP Gateway

OriginRouter uses a hybrid Agent-to-Agent architecture:

- The OriginRouter collaboration runtime is the control plane. It owns the task graph, device identity, E2EE delivery, leases, fencing, budgets, cancellation, recovery, approvals, and audit records.
- MCP is the Agent-facing communication plane. A managed Claude or Codex session receives an `originrouter` MCP server automatically while it owns an active adaptive-collaboration task.

The MCP server exposes four tools:

- `list_participants`: lists the other participants available in the current run.
- `delegate_task`: creates a typed child task and returns immediately.
- `get_task_result`: reads the state and final result of a child task created by the caller.
- `ask_agent`: delegates a bounded discussion task and polls for its result.

## Security boundary

The stdio MCP process talks only to the authenticated loopback daemon API. The daemon derives the run, participant, and current task from the managed session id; the model cannot select or impersonate a different source session.

For a remote caller, MCP requests are encrypted through the existing trusted-device E2EE transport and evaluated by the coordinator. The coordinator verifies that:

- the run is an executing adaptive collaboration;
- the source device and participant match the active task lease;
- the requested target is another participant and is not already busy;
- synchronous `ask_agent` has a free concurrency slot;
- result reads refer to a child task created by the caller's active task.

Delegation is recorded as an `agent.mcp.delegated` collaboration message and as a local `collaboration` audit record. The delegated Agent keeps its configured workspace, provider, model, and permission profile; MCP delegation does not grant tool authority.

## Transport and recovery

MCP itself remains local stdio, so Claude and Codex do not receive account credentials or remote network endpoints. Cross-device work is dispatched through OriginRouter's durable E2EE collaboration transport. A long-running task can use `delegate_task` and later poll `get_task_result`; `ask_agent` is a convenience for online, bounded exchanges and returns a task id if its wait expires.

This design intentionally does not expose arbitrary device ports or make one Agent a generally reachable MCP server. OriginRouter remains the policy-enforcing gateway between Agents.
