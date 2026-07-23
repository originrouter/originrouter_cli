# Agent Local Audit Ledger

OriginRouter keeps Agent approval and external-change history on the CLI device.
The App reads it on demand through the local API when possible and through the
OriginRouter Relay when the device is remote. The application server does not
persist audit record bodies.

## Storage

Each OriginRouter session has an append-only JSONL ledger under:

```text
~/.originrouter/audit/sessions/<sha256(session-id)>.jsonl
```

The directory uses mode `0700`; ledger files use mode `0600`. Every record
contains the previous record hash and its own SHA-256 hash. Request/result
phases remain append-only, while the read projection merges phases with the
same correlation ID into one App record.

## Approval records

The ledger records blocking requests and their outcomes, including automatic
policy decisions, local App decisions, remote App decisions, terminal/native
decisions when reported by the runtime, denial, cancellation, expiry, and
failure. Secret-bearing inputs are redacted before they reach the ledger.

## Change records

The change view is deliberately not a complete file-edit history. Routine
`Edit`, `Write`, patch, and file-change operations inside the current workspace
are excluded because Git is the recovery source for those changes.

The ledger includes operations that can create external or difficult-to-revert
side effects:

- database mutations and migration commands;
- remote host, push, infrastructure, and mutating HTTP operations;
- system service, package, permission, container, and configuration changes;
- destructive commands;
- file changes outside the workspace;
- migration/deploy/seed/backfill/cleanup/repair/restore/rollback scripts that
  cannot be proven read-only.

Script entries are labelled as potential changes when the CLI cannot determine
their exact side effects. A completed tool call records success or failure; it
does not claim that a recovery script is automatically available.

## Read protocol

Local direct:

```text
GET /agent/local/sessions/{session_id}/audit
  ?category=approval|change
  &before=<sequence>
  &limit=50
```

Remote:

```text
App -> agent.audit.request -> Server Relay -> CLI
CLI -> agent.audit.page -> Server Relay -> App
```

The server validates the user/session/device association. Redis Pub/Sub and
WebSockets are transport only. The page body is not written to MySQL, Redis,
the server audit log, or application logs.

If the CLI device is offline, the App cannot read these records. Existing
ledger files remain available after Agent processes and the daemon restart.
