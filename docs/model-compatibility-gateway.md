# OriginRouter Model Compatibility Gateway

## Purpose

OriginRouter runs a local compatibility gateway in front of its managed
LiteLLM process. Claude Code, Codex, App chat and remote E2EE requests use the
stable public proxy port, while LiteLLM listens on a private random loopback
port.

```text
Claude / Codex / App / remote E2EE request
                    |
                    v
OriginRouter Compatibility Gateway
                    |
                    v
LiteLLM private loopback port
                    |
                    v
Provider
```

The Gateway supports signed, remotely updatable WebAssembly compatibility code.
The Server distributes code but never sees decrypted model traffic and never
executes a patch. Remote traffic remains E2EE until the target CLI, which runs
the same local Gateway used by direct requests.

## Offline fallback and online snapshots

The CLI contains JavaScript fallback implementations for the first two fixes:

1. non-OpenAI Responses namespace flattening and function pair repair;
2. non-Anthropic Messages server-tool history conversion.

They work before any online bundle has been installed. A verified WASM bundle
is a complete snapshot: once active, its patch set replaces the fallback set.
Adding or deleting a source directory therefore adds or deletes that patch in
the next revision without an implicit fallback to a same-ID built-in patch.

The previous verified snapshot is retained for rollback.

## Patch source and release artifact

Patch source is maintained in `originrouter_server/compatibility/patches/`.
Every patch directory contains:

```text
manifest.json     matching, version, failure and ordering metadata
patch.ts          real AssemblyScript patch code
tests/*.json      mandatory release fixtures
```

`manifest.json` also carries the signed user-facing patch `name` and
`description`. The CLI and App render these fields without interpreting them as
code.

The release tool compiles `patch.ts` to WASM, runs its fixtures, embeds the WASM
bytes and SHA-256 digest into a complete bundle, and signs the canonical bundle
with an offline Ed25519 key. The generated Git-deployable artifact is:

```text
originrouter_server/compatibility/patches.signed.json
```

No Python, Rust or compiler is required on user devices. AssemblyScript is a
release-only development dependency.

## WASM ABI and capabilities

ABI `originrouter-json-dom-v1` presents the request, response, stream event or
error as a JSON DOM handle. It also supplies one request-local, patch-local JSON
state object, allowing stream patches to pair information across SSE events
without sharing state between requests. Patches can:

- inspect and enumerate objects and arrays;
- read and create strings, finite numbers, booleans and null;
- clone, insert, replace and delete JSON values;
- inspect secret-free protocol, provider, model and route context.

Patches cannot import or access:

- network or DNS;
- filesystem or OS APIs;
- environment variables;
- process or Shell execution;
- Authorization headers, API keys or E2EE keys;
- Agent approval and local-control capabilities;
- Node.js APIs or WASI.

Every module must import host-limited memory and may only import the exact JSON
DOM ABI. The CLI rejects unknown imports, owned/exported memory, invalid hashes,
bad signatures and missing ABI exports before activation.

Each execution uses a fresh WASM instance inside a dedicated Worker. The host
enforces initialization and execution timeouts, a 16 MiB linear-memory maximum,
Worker heap limits, JSON handle limits, string limits and output-size limits.
An infinite loop is terminated with the Worker rather than blocking the Daemon.

## Matching and deterministic order

Host-side matching occurs before a module is invoked. A manifest may match
method, path, protocol, runtime, provider, provider family, model, LiteLLM
version and streaming mode.

Patches execute only in their phase: `request`, `response`, `stream` or `error`.
Within one phase:

1. `before` and `after` dependencies form a directed acyclic graph;
2. ready patches are ordered by descending `priority`;
3. equal priorities are ordered by patch ID.

Missing dependencies, cycles, duplicate IDs and declared conflicts reject the
entire release before signing.

## Signature, update and rollback

Code bundles use schema `originrouter-compatibility-code-signed-v1`. The
signature covers a domain-separated canonical JSON payload, including every
module byte through both its embedded Base64 value and SHA-256 digest.

The private Ed25519 key remains outside Git and outside production. Trusted
public keys are pinned in the CLI, with an environment key ring available only
for development, private deployments and rotation testing.

The CLI checks on startup and every six hours unless relay mode is `local` or
updates are disabled. Installation verifies signature, engine range, expiry,
module structure, capabilities and revision before an atomic mode-0600 write.
Running Gateways reload the snapshot without restarting LiteLLM.

```bash
originrouter compatibility status
originrouter compatibility list
originrouter compatibility inspect <patch-id>
originrouter compatibility check
originrouter compatibility update
originrouter compatibility rollback
```

`refresh` remains an alias for `update`. The App exposes the same operations in
the selected CLI device's Provider Control details. An App command contains
only an action and operation ID; the target CLI downloads from the fixed
official endpoint, verifies the signature locally, performs the action, and
reports the final operation result in its display-safe runtime snapshot.

## Release workflow

From `originrouter_server`:

```bash
node compatibility/release.mjs
git add compatibility
git commit -m "update compatibility patches"
git push
```

The release command automatically increments the bundle revision. Production
only needs `git pull`; the Server reads `compatibility/patches.signed.json` on
each request. Exact key generation, CLI public-key pinning and deployment steps
are documented in `originrouter_server/compatibility/README.md`.

## When a CLI release is still required

WASM patches can implement new model-protocol JSON transformations without a
CLI update. A CLI release is still required for a new host capability such as
transport, TLS, authentication, process management, filesystem access or a new
WASM ABI. Compatibility code is intentionally unable to expand its own system
authority.
