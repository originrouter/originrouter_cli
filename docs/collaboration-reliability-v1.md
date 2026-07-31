# Collaboration reliability v1

This document describes the reliability boundary implemented for the current
`plan_implement_verify` collaboration runtime. It is intentionally narrower
than the future Task DAG, worktree isolation, and coordinator failover design.

## Durable device delivery

Cross-device collaboration messages are written to `collaboration_outbox`
before transmission. The daemon sends them through `DeviceE2eeRelayTransport`.
An accepted relay delivery marks the record delivered and removes the local
plaintext payload. Temporary delivery failures remain pending and retry with
bounded exponential backoff. Protocol, identity, and directory-fork failures
become terminal outbox failures instead of retrying indefinitely.

Delivery is at least once. Every dispatch has a stable `deliveryId`; receivers
deduplicate replayed deliveries before launching or messaging an Agent.

## Attempts, leases, and fencing

Each role dispatch receives:

- an incrementing attempt;
- an incrementing fencing token;
- a random lease id;
- lease expiry and heartbeat timestamps.

Results, usage, errors, and cancellation messages carry the attempt and fencing
token. A coordinator accepts them only when they match the active role lease.
This prevents an expired attempt from advancing a run after a newer attempt has
started.

Lease expiry is not yet an automatic reassignment trigger. The current release
records and refreshes lease metadata but does not assume that a disconnected
remote process has stopped. Automatic quarantine, zombie cleanup, and safe
reassignment belong to the coordinator failover phase.

## Rolling upgrade compatibility

Protocol v1 peers released before fencing support omit the new fields. The
runtime accepts those messages using the previous run/task/role validation and
marks incoming assignments as legacy. Strict fencing applies when both peers
send the new metadata. This compatibility path can be removed only after the
minimum supported CLI version includes fencing.

## Server visibility

Collaboration objectives, task titles, prompts, results, commands, and
artifacts are device content. Device messages are E2EE, and run projections send
blank objective/title fields. The control server may retain operational
metadata such as run id, state, device id, token usage, configured-price amount,
and timestamps.

## Not implemented by this phase

- automatic Git or filesystem rollback;
- disposable worktrees or shadow workspaces;
- Task DAG scheduling and parallel writers;
- lease-expiry reassignment;
- coordinator election or failover;
- automatic context distillation.

Those features must build on the durable outbox and fencing rules rather than
bypassing them.
