# OriginRouter Approval Policy v2

Status: implementation specification

OriginRouter Approval Policy is a local, declarative policy-as-code format for
Claude and Codex permission requests. The policy is evaluated by the CLI on the
device running the Agent. A relay may transport an encrypted policy update, but
the relay and OriginRouter Server never make the authorization decision.

## Security model

- The language is data, not executable code.
- Every interaction is normalized into one or more atomic operations.
- A compound interaction is automatically allowed only when every atom is
  allowed. One denied atom denies the interaction. Any unresolved atom asks the
  user.
- `deny` overrides `ask`, and `ask` overrides `allow`.
- Parse errors, unknown tools, dynamic shell expansion, and insufficient
  context default to `ask`.
- Low-confidence and opaque atoms cannot be converted to `allow`, even by a
  wildcard rule or an `allow` fallback. A policy may still deny them.
- Requests containing secrets cannot be automatically answered by policy.
- Path-based allow rules require both the user-requested path and its canonical
  filesystem target to satisfy the condition. A symlink cannot make an outside
  target appear to be inside an allowed directory.
- Paths that cannot be resolved safely, including broken or looping symlinks,
  cannot be automatically allowed and fall back to `ask`.
- User/device policies may grant authority. A repository policy is
  restriction-only until the user explicitly trusts its fingerprint.
- Policies do not weaken the operating-system sandbox. A policy can approve a
  request, but the runtime still has to obtain and enforce the requested OS
  capability.

## File location and precedence

Canonical user policies live under:

```text
~/.originrouter/policies/<policy-id>.json
```

A workspace may contain `.originrouter/approval-policy.json`. An untrusted
workspace policy is evaluated as an additional restriction layer and cannot
turn an upstream `ask` or `deny` into `allow`.

The effective decision is combined in this order:

```text
built-in runtime boundary
  AND user/device policy
  AND trusted workspace policy, or restriction-only workspace policy
  AND session override
```

## Minimal policy

```json
{
  "$schema": "https://originrouter.com/schemas/approval-policy-v2.schema.json",
  "version": 2,
  "id": "developer-default",
  "name": "Developer default",
  "defaults": {
    "unmatched": "ask",
    "parse_error": "ask",
    "unknown": "ask"
  },
  "rules": [
    {
      "id": "allow-workspace-reads",
      "effect": "allow",
      "actions": ["fs.read", "fs.list", "fs.search"],
      "when": {
        "field": "resource.path",
        "op": "path_under",
        "value": "${workspace}"
      }
    }
  ]
}
```

## Rule model

Each rule has:

- `id`: stable identifier used by audit records.
- `effect`: `allow`, `deny`, or `ask`.
- `priority`: optional integer used for deterministic display and diagnostics.
- `actions`: optional glob patterns matched against atomic action IDs.
- `tools`: optional glob patterns matched against normalized tool names.
- `when`: optional condition tree. Omitting it means the action/tool selectors
  are the complete condition.
- `reason`: optional user-facing explanation stored in local audit records.

Rules are combined with `deny_overrides`. Priority does not let an allow rule
override a deny rule.

## Condition language

Logical nodes:

```json
{ "all": [condition, condition] }
{ "any": [condition, condition] }
{ "none": [condition, condition] }
{ "not": condition }
```

Leaf condition:

```json
{ "field": "command.executable", "op": "eq", "value": "npm" }
```

Collection-valued fields may select an explicit quantifier:

```json
{
  "field": "command.argv",
  "op": "glob",
  "value": "--safe-*",
  "quantifier": "all"
}
```

The supported quantifiers are `any`, `all`, and `none`. When omitted, allow
rules use `all` and restrictive ask/deny rules use `any`. Operators other than
`exists` and `not_exists` return false when the field is missing; negative
operators do not treat absent evidence as proof that an operation is safe.

Supported operators:

- Presence: `exists`, `not_exists`
- Equality: `eq`, `neq`
- Text and paths: `glob`, `not_glob`, `contains`, `not_contains`,
  `starts_with`, `ends_with`, `path_under`, `path_equals`
- Collections: `in`, `not_in`, `intersects`, `contains_all`
- Numeric: `lt`, `lte`, `gt`, `gte`, `between`

`glob` supports `*`, `**`, and `?`. Matching is case-sensitive unless the leaf
sets `case_sensitive` to `false`. Regular expressions are intentionally not in
v1 because JavaScript regular expressions supplied by an untrusted repository
can cause denial-of-service through catastrophic backtracking.

`path_under` and `path_equals` use filesystem-aware canonical paths. Existing
symlinks are resolved with `realpath`. For a destination that does not exist
yet, the evaluator resolves its nearest existing ancestor and appends the
missing descendants, so creating `${workspace}/generated/new.txt` remains
eligible while `${workspace}/link-to-outside/new.txt` does not. Allow rules
must match both the requested and canonical path. Restrictive `ask` and `deny`
rules match either representation, preventing a symlink from bypassing a
blacklist written against its visible location.

Relative paths extracted from shell commands are resolved against the command's
actual canonical working directory, not automatically against the workspace
root. Copy and move commands emit atoms for every source and the destination;
the complete operation is allowed only when all of them are allowed.

Canonicalization is performed when the permission request is evaluated. It
reduces symbolic-link and path-traversal bypasses, but it is not a replacement
for an operating-system sandbox: a separate process could still change a path
after approval and before use. High-assurance deployments should combine
approval policies with filesystem sandboxing and least-privilege OS accounts.

Condition fields address the normalized atom, including:

```text
action
risk
confidence
provider
runtime
interaction.kind
tool.name
command.raw
command.executable
command.argv
command.cwd
command.dynamic
resource.kind
resource.path
resource.uri
network.protocol
network.host
network.port
network.method
database.engine
database.operation
database.database
database.schema
database.tables
code.language
code.script
code.module
code.sha256
```

Only these built-in substitutions are expanded in string values:

```text
${workspace}
${home}
${state_dir}
```

Environment-variable interpolation is not supported because a policy must not
silently consume secrets from the Agent environment.

## Atomic operations

### Agent interaction

```text
agent.plan.continue
agent.input.answer
agent.form.submit
agent.url.open
secret.input
```

### Filesystem

```text
fs.read
fs.list
fs.search
fs.create
fs.write
fs.append
fs.patch
fs.copy
fs.move
fs.delete
fs.permissions.write
fs.unknown
```

### Process and code

```text
process.exec
process.opaque
process.signal
shell.dynamic
code.python.execute
code.javascript.execute
code.shell.execute
code.opaque
```

### Network

```text
network.dns.resolve
network.connect
network.listen
network.http.read
network.http.write
network.transfer.upload
network.transfer.download
```

### Version control and packages

```text
vcs.read
vcs.write
vcs.destructive
vcs.remote.read
vcs.remote.write
package.read
package.install
package.remove
package.publish
```

### Database

```text
db.read
db.insert
db.update
db.delete
db.schema.create
db.schema.alter
db.schema.drop
db.transaction
db.admin
db.unknown
```

### System and infrastructure

```text
system.service.read
system.service.manage
system.identity.manage
system.schedule.manage
system.storage.manage
infra.read
infra.write
infra.destroy
permission.additional
tool.unknown
```

The registry is append-only within major version 1. New atoms may be added, but
an unknown atom continues to resolve through `defaults.unknown`.

## Bash and shell commands

OriginRouter tokenizes shell commands without executing expansion. Pipelines,
`;`, `&&`, `||`, and redirections produce multiple atoms. For example:

```text
cat app.log | grep ERROR > report.txt
```

produces at least:

```text
process.exec        executable=cat
fs.read             path=app.log
process.exec        executable=grep
fs.search
fs.write            path=report.txt
```

Command substitution, backticks, `eval`, `source`, `bash -c`, `sh -c`, and
unresolved shell expansion add `shell.dynamic`. Opaque shell behavior always
asks the user; an allow wildcard cannot suppress this boundary.

## SQL

SQL passed directly by a database tool, or through common client flags such as
`psql -c`, `mysql -e`, and `sqlite3 <database> <sql>`, is split into statements.
Each statement becomes an atom. Multi-statement input is allowed only if every
statement is allowed. Unknown dialect syntax becomes `db.unknown`.

Examples:

```text
SELECT, SHOW, DESCRIBE, EXPLAIN -> db.read
INSERT                         -> db.insert
UPDATE                         -> db.update
DELETE                         -> db.delete
CREATE                         -> db.schema.create
ALTER                          -> db.schema.alter
DROP, TRUNCATE                 -> db.schema.drop
GRANT, REVOKE                  -> db.admin
BEGIN, COMMIT, ROLLBACK        -> db.transaction
MERGE                          -> db.update
COPY, CALL, EXEC, PRAGMA       -> db.unknown
VACUUM, ATTACH, DETACH         -> db.admin
```

## Python and other scripts

Static inspection cannot prove the side effects of arbitrary code. A Python
invocation therefore emits `process.exec`, `code.python.execute`, and, when the
script cannot be safely described, `code.opaque`.

Policies can declare a known invocation and its expected operations:

```json
{
  "id": "known-report-script",
  "match": {
    "all": [
      { "field": "code.language", "op": "eq", "value": "python" },
      { "field": "code.script", "op": "path_equals", "value": "${workspace}/scripts/report.py" },
      { "field": "code.sha256", "op": "eq", "value": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }
    ]
  },
  "replaces_opaque": true,
  "emits": [
    { "action": "fs.read", "resource": { "kind": "path", "path": "${workspace}/data/**" } },
    { "action": "fs.write", "resource": { "kind": "path", "path": "${workspace}/reports/**" } }
  ]
}
```

Declarations are matched against the actual executable, arguments, resolved
script path, and current file hash. If an asserted hash no longer matches,
`code.opaque` remains and the interaction asks the user.

In v2, `replaces_opaque: true` requires both an exact `code.script`
`path_equals` condition and a 64-character `code.sha256` equality condition.
The runtime applies this replacement boundary to v1 policies as a fail-closed
compatibility hardening.

## Enforcement modes

Policies enforce decisions by default. Observation mode evaluates and audits a
policy without automatically allowing or denying the request:

```json
{
  "metadata": { "enforcement": "shadow" }
}
```

The CLI emits `agent.approval_policy.shadow` with display-safe per-layer and
per-atom results, then forwards the request to normal user approval.

## Capabilities, simulation, and rollback

Managed Agent status includes supported policy versions, the latest version,
the action/operator registry hash, evaluator limits, and the active path
boundary mode. The App verifies the selected policy version and registry hash
before deployment.

The authenticated local API provides:

```text
GET  /approval-policies/capabilities
POST /approval-policies/validate
POST /approval-policies/simulate
GET  /approval-policies/<id>/revisions
POST /approval-policies/<id>/rollback
```

The CLI retains the latest 20 immutable local revisions for each installed
policy. Simulation uses the same authoritative atomizer and evaluator as live
Agent requests and never executes the simulated request.

The App exposes these operations from the policy editor under **Validate and
simulate**. The user selects a reachable CLI device, chooses a common operation,
a pending approval request, or a JSON request, and receives the final effect,
every normalized atom, matched rule IDs, classification confidence, and fallback
reason. Device revision history marks the currently installed revision. A
rollback changes only that device; it does not overwrite the account template.

For remote devices, request and response payloads use the trusted device E2EE
channel. OriginRouter Server routes ciphertext and never receives the policy,
synthetic request, matched rules, or revision contents in plaintext.

## Validation diagnostics

Validation returns errors, warnings, and an impact summary. Warnings currently
cover:

- action patterns that match no registered atomic operation;
- identical or overlapping rules whose stronger decision makes another rule
  redundant;
- allow/ask/deny conflicts over the same static scope;
- unconditional wildcard or process execution rules;
- declarations that are not constrained by a stable tool, executable, module,
  script path, or digest;
- declarations that emit too many atoms to review as one auditable unit.

The impact summary reports enabled and disabled rule counts, declaration count,
broad rule count, enforcement mode, and the number of registered actions
covered by allow, ask, and deny rules. These counts describe possible static
coverage. They do not claim that every condition will match at runtime.

## Registry source and generation

The canonical registry is:

```text
schemas/approval-policy-registry.json
```

It generates the CLI JavaScript registry and the App Dart registry. Published
v1 and v2 schemas are checked against the same source during CLI tests.

```bash
npm run generate:approval-policy-registry
npm run check:approval-policy-registry
```

The generator updates the sibling `originrouter_app` checkout when present. A
standalone CLI checkout validates its own generated JavaScript and schemas.

## Example: whitelist plus blacklist

```json
{
  "$schema": "https://originrouter.com/schemas/approval-policy-v2.schema.json",
  "version": 2,
  "id": "backend-development",
  "name": "Backend development",
  "defaults": { "unmatched": "ask", "parse_error": "ask", "unknown": "ask" },
  "rules": [
    {
      "id": "deny-secrets-and-env",
      "effect": "deny",
      "actions": ["secret.*"],
      "reason": "Credentials must always be entered by the user."
    },
    {
      "id": "deny-destructive-git",
      "effect": "deny",
      "actions": ["vcs.destructive"]
    },
    {
      "id": "allow-workspace-files",
      "effect": "allow",
      "actions": ["fs.read", "fs.list", "fs.search", "fs.create", "fs.write", "fs.patch"],
      "when": { "field": "resource.path", "op": "path_under", "value": "${workspace}" }
    },
    {
      "id": "allow-repository-inspection",
      "effect": "allow",
      "actions": ["process.exec", "vcs.read"],
      "when": {
        "all": [
          { "field": "command.executable", "op": "eq", "value": "git" },
          { "field": "command.argv", "op": "intersects", "value": ["status", "diff", "log"] },
          { "field": "command.cwd", "op": "path_under", "value": "${workspace}" }
        ]
      }
    },
    {
      "id": "ask-production-hosts",
      "effect": "ask",
      "actions": ["network.*", "db.*"],
      "when": {
        "any": [
          { "field": "network.host", "op": "glob", "value": "prod-**" },
          { "field": "database.database", "op": "glob", "value": "prod_*" }
        ]
      }
    }
  ]
}
```

## Audit contract

Every evaluation records locally:

- policy ID, revision hash, and source layer;
- normalized atoms and classification confidence;
- matched rule IDs and effects;
- final effect and fallback reason;
- whether a declaration replaced an opaque-code atom.

Raw secrets and unredacted environment values are never written to the audit
record.
