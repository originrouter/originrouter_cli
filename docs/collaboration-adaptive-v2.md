# Adaptive Agent collaboration

`plan_implement_verify` remains supported for runs created by older App and CLI
versions. New runs use `adaptive_collaboration`: participants and a read-only
Planner replace the fixed Lead/Worker form.

## User flow

1. Describe the objective.
2. Select one or more participants. A participant binds an Agent runtime to a
   device and trusted workspace. The first participant is the default Planner.
3. Optionally describe collaboration preferences, choose a built-in starting
   pattern, or add coordination instructions.
4. The Planner produces a validated task DAG in read-only mode.
5. The App or CLI shows the proposed plan. No execution task starts before the
   user confirms it.
6. The runtime dispatches dependency-ready tasks. Different participants may
   run concurrently; one participant receives only one task at a time.

Built-in patterns are prompts, not hard-coded state machines:

- `adaptive`
- `plan_implement_verify`
- `parallel_research`
- `review_panel`

The Planner may produce a different number of tasks and assignments when the
objective or user instructions require it. The runtime still enforces the
validated schema, participant allow-list, acyclic dependencies, concurrency
limit, approval policy, budget policy, lease, fencing, Outbox, and E2EE relay.

## CLI

List starting patterns:

```sh
originrouter collaboration templates
```

Create a collaboration and wait for its proposed plan:

```sh
originrouter collaboration create \
  --objective "Investigate and fix provider reconnection" \
  --participant architect:codex:local:/path/to/project \
  --participant builder:claude:local:/path/to/project \
  --role architect="analyze the architecture and verify the result" \
  --role builder="implement and test the change" \
  --preference "research independently when useful; do not edit before the plan is confirmed"
```

The command prints the proposed plan and asks for confirmation in an
interactive terminal. In scripts it leaves the plan pending unless `--yes` is
provided.

```sh
originrouter collaboration show <run-id>
originrouter collaboration confirm <run-id>
originrouter collaboration cancel <run-id>
```

For reusable or detailed definitions, pass a JSON file:

```json
{
  "objective": "Audit and improve the release pipeline",
  "preferences": "Use parallel research, then one synthesis task.",
  "workflow_template_id": "parallel_research",
  "coordination_prompt": "The verifier must not be the implementation participant.",
  "participants": [
    {
      "participant_id": "release_architect",
      "runtime": "codex",
      "device_id": "local",
      "workspace_id": "/project",
      "role_hint": "analyze and synthesize",
      "planner": true
    },
    {
      "participant_id": "release_builder",
      "runtime": "claude",
      "device_id": "local",
      "workspace_id": "/project",
      "role_hint": "implement and test"
    }
  ],
  "budget": {
    "max_concurrency": 2
  }
}
```

```sh
originrouter collaboration create --spec collaboration.json
```

## Privacy and recovery

Objectives, coordination instructions, plans, task prompts, and results remain
on the coordinator device or inside E2EE device envelopes. The server receives
only the existing redacted run projection and usage/budget data.

SQLite schema upgrades are automatic. After a daemon restart, active adaptive
tasks are reissued with a new attempt and fencing token. Old local session
bindings are detached, and stale remote fencing tokens cannot advance the run.
