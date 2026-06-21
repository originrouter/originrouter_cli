# OriginRouter Login Credential Architecture

> **Stage 9.1B — runtime Claude/Codex wired to OriginRouter /coding.**
> - 9.0: contract + storage + Dart / TypeScript / Python shape modules + endpoint doc.
> - 9.1A: real routes (5 endpoints under `/originrouter/auth/...`),
>   CLI commands (`originrouter login --manual-code <code>` is
>   the required completion path), and the
>   `api_model_key_metadata` SQL migration.
> - 9.1B: runtime `buildAgentProviderEnv` reads `coding-key.json` for routes of
>   `type=originrouter`; no local LiteLLM proxy required for direct routes.
> - Browser callback UX (login → `/login-code` → CLI callback
>   redirect) is **experimental in 9.1A**; the CLI shape is
>   final, but Universal_PDF_H5 wiring ships in 9.1A.1.

## Why `uuid` is NOT a long-term /coding key

The backend's `Authorization: Bearer uuid:<uuid>` shape is a
**browser login session**. It is not a CLI / App credential for
these reasons:

1. **Scope too large.** A browser uuid has full user-scope
   authority. Leaking it gives an attacker everything. A
   managed coding key is scoped to `scope: "coding"` only.
2. **No per-device revocation.** A uuid cannot be revoked for
   a single device. A managed key is bound to a `device_id`
   and a `device_grant_id`; revoking the grant invalidates
   the key in one call.
3. **Weak audit.** A uuid is shared across every browser tab
   and request; audit logs cannot tell which device made a
   given call. A managed key carries `source`
   (`originrouter_cli` / `originrouter_app`) and `device_id`
   on every request.
4. **Non-standard format.** `uuid:<uuid>` is a custom header
   value the backend invented. It is not compatible with
   Claude / OpenAI / Codex toolchains, all of which expect an
   `x-api-key` or `Authorization: Bearer <api-key>` header.
5. **Bad rotation story.** A uuid changes only when the user
   re-logs in. A managed key is auto-rotated by the CLI / App
   on a 30-day cadence (see below).

The Stage 9.0 contract is: **the CLI and the Flutter App hold a
managed coding API key, never the browser uuid.** The browser
uuid is used only to perform the one-time exchange that mints
the first managed key (Stage 9.1+).

## Lifetimes

| Token | Lifetime | Notes |
|---|---|---|
| Login code | 5–10 minutes, single-use | Stage 9.1+ — issued by the login page, exchanged for a device grant. |
| Device grant | 90-day idle, 365-day absolute, revocable | The grant is the umbrella identity. Revoking the grant invalidates every managed key bound to it. |
| Managed coding API key | 30 days default, auto-rotated by CLI / App | Bound to `device_id`. The CLI / App rotates the key 7 days before expiry (Stage 9.1+). |

The 30-day default is preferred over a 90-day alternative
because the managed key is the only token that can actually
consume model resources. Shorter lifetimes limit blast radius.

## Token types

```ts
type LoginCode = {
  value: string;
  expiresAt: number;       // epoch ms; between 5 and 10 min from issue
  singleUse: true;
};

type DeviceGrant = {
  deviceId: string;
  userId: string;
  issuedAt: number;        // epoch ms
  lastUsedAt: number;      // epoch ms
  idleExpiresAt: number;   // issuedAt + 90d
  absoluteExpiresAt: number; // issuedAt + 365d
  revokedAt?: number;      // epoch ms; absent when active
};

// Canonical ManagedCodingKey — exactly what `isManagedKeyShape`
// (src/runtime/authContract.js) requires. The runtime reads this
// shape from `<stateDir>/coding-key.json` and uses `key` as the
// Authorization: Bearer value, `deviceGrant` as the
// Authorization: Bearer value for rotate / revoke.
type ManagedCodingKey = {
  kind: "managed";                              // always "managed"
  keyId: string;                                // opaque ok_<token>
  key: string;                                  // raw API key value
  deviceGrantId: string;                        // opaque og_<token>
  deviceGrant: string;                          // raw device-grant token
  deviceId: string;
  source: "originrouter_cli" | "originrouter_app";
  scopes: ["coding"];                           // Stage 9.0: only "coding"
  expiresAt: number;                            // epoch ms; 30d default
  // Optional — validated when present:
  deviceGrantIdleExpiresAt?: number;            // epoch ms; 90d
  deviceGrantAbsoluteExpiresAt?: number;        // epoch ms; 365d
  // Persisted by writeCodingAuth; not part of the shape check:
  writtenAt?: number;                           // epoch ms; set by IO layer
};
```

These are the **canonical** shapes. Each platform
implements them in its own language:

- **TypeScript / JavaScript:** `src/runtime/authContract.js`
  in the CLI repo. Exports `KEY_SCOPE`, `KEY_SOURCE`,
  `KEY_KIND`, `LOGIN_CODE_TTL_MS_MIN/MAX`, etc.
- **Dart:** `lib/features/auth/auth_state.dart` + the
  `ProviderConfig` sealed class in
  `lib/features/providers/provider_config.dart`.
- **Python:** `UPT_back_end/ai/server/originrouter_auth_contract.py`.
  The dataclass `ManagedCodingKey` and the
  `validate_managed_key_shape` helper are the backend's
  reference.

## Managed key rotation

The CLI and the App auto-rotate the managed key 7 days before
its `expiresAt`. Rotation is a single POST to the backend
(`POST /originrouter/auth/device/rotate-coding-key` — Stage
9.1+). The previous key is invalidated in the same call. The
on-disk record is overwritten in place; the file mode stays
0o600.

If the CLI / App is offline when rotation is due, the key is
still usable until `expiresAt`. The first network call after
expiry triggers a rotation; if that fails, the CLI / App shows
a "managed key expired, please re-authenticate" prompt and
stops sending requests.

## Local storage expectations

**CLI side:** `<stateDir>/coding-key.json`, mode 0o600. The
record is the `ManagedCodingKey` shape above plus a
`writtenAt: number` field (epoch ms, set by `writeCodingAuth`).
The IO layer is `src/persistence/codingAuth.js`. The pure
shape check is `isManagedKeyShape` in
`src/runtime/authContract.js`. **The IO layer delegates the
shape check to the pure helper** — there is exactly one source
of truth for "what counts as a valid managed key."

**App side:** Stage 9.0 keeps the AuthState in memory; Stage
9.1+ integrates with the OS keychain (Keychain on iOS / macOS,
Keystore on Android, Credential Manager on Windows / Linux).
The App mirrors the CLI's `coding-key.json` shape; the
provider / auth flows on the App side read from
`lib/features/auth/auth_state.dart` and `provider_config.dart`.

**No default secret sync.** The CLI and App do NOT sync the
managed key to each other, to the cloud, or to any relay.
Stage 9.0 explicitly forbids it. If a future stage adds sync,
it must be initiated by the local CLI explicitly and should be
E2EE; this is a 9.1+ design discussion, not a 9.0 deliverable.

## Logout behavior

`originrouter logout` (Stage 9.1+) clears the local file via
`clearCodingAuth(stateDir)` and POSTs
`POST /originrouter/auth/device/revoke` to the backend. The
backend revokes the device grant, which in turn invalidates
every managed key bound to it. The user can immediately log in
again from any device.

Stage 9.0 ships only the storage side of logout. The CLI
subcommand and the backend endpoint are 9.1+.

## Backend endpoint contract (Stage 9.1A)

These endpoints ARE registered in 9.1A at
`UPT_back_end/ai/server/routes/originrouter_auth.py`. Full
contract lives in `UPT_back_end/docs/originrouter-auth.md`.

- `POST /originrouter/auth/login-code` — browser-authenticated.
  Mints a one-time code (5–10 min, single-use).
- `POST /originrouter/auth/device/exchange` — exchanges a code
  for a device grant + first managed key. Returns raw grant
  and raw key exactly once.
- `POST /originrouter/auth/device/rotate-coding-key` — rotates
  the managed key bound to the calling device. Idempotent on
  the device-grant side; the rotation itself produces a new key
  every call.
- `POST /originrouter/auth/device/revoke` — revokes the calling
  device's grant and all bound keys. Returns
  `{already_revoked: bool}`.
- `GET  /originrouter/auth/devices` — returns the **calling
  device only** under `scope: "current_device_only"`. Not a
  full user-device list.

## Runtime wiring (Stage 9.1B)

`src/config/claudeConfig.js` `buildAgentProviderEnv(agent, config, options)`
returns:

| Trigger | ANTHROPIC_BASE_URL | OPENAI_BASE_URL | source |
|---|---|---|---|
| route → originrouter | `<base>/coding` | `<base>/coding/v1` | `originrouter-coding` |
| route → proxy + hash match | `http://127.0.0.1:<port>` | `http://127.0.0.1:<port>/v1` | `routes` |
| otherwise | throws PROVIDER_UNSUPPORTED | throws PROVIDER_UNSUPPORTED | — |

`auth.keyRef` is a **local managed coding key reference**, not a fixed key id.
After `originrouter auth rotate`, the new key id differs but the reference is
unchanged; the runtime always reads the current `<stateDir>/coding-key.json`.

In Stage 9.1B, only `keyRef: "current"` is meaningful for the CLI runtime —
the runtime reads the file on disk, not a key-by-key-id table. Future stages
may add additional `keyRef` values (e.g. per-environment), but the
authoritative value today is `current`, and the runtime contract is
"whatever is in `coding-key.json` right now." Anyone who later assumes
`keyRef` must match `keyId` will break after the first rotate.

The runtime also rejects malformed `coding-key.json` (missing `deviceGrant`,
missing `scopes`, wrong `source`) before injecting env, so a stale or
hand-edited file produces a clean login prompt rather than a leaked
`ANTHROPIC_API_KEY=` with an empty value.

## Login command

The required 9.1A completion path is `--manual-code <code>`:

```
# 1. Mint a code from the backend (browser uuid auth).
CODE=$(curl -s -X POST <api>/originrouter/auth/login-code \
  -H "Authorization: Bearer uuid:<known-uuid>" \
  -H "Content-Type: application/json" \
  -d '{"device_id":"smoke-device","source":"originrouter_cli"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")

# 2. Exchange it on the CLI.
originrouter login --manual-code "$CODE" --api-base-url <api>
# → writes <stateDir>/coding-key.json with the full managed key
#   (deviceGrant, deviceId, deviceGrantIdleExpiresAt, etc.)

originrouter auth status        # masked summary, no backend call
originrouter auth rotate        # rotates via backend
originrouter auth device list   # current_device_only block
originrouter logout             # revokes + clears local file
```

The browser callback flow (`originrouter login` without
`--manual-code`) opens a local HTTP server on 127.0.0.1 and
waits for `/originrouter/login/callback?code=...&state=...`.
End-to-end UX requires Universal_PDF_H5 to call
`/login-code` and redirect to the callback URL. That wiring is
**9.1A.1**. Until then, `--manual-code` is the supported path.

The managed key written here is what `originrouter claude` /
`originrouter codex` read at runtime (Stage 9.1B). The runtime
also rejects malformed `coding-key.json` (missing `deviceGrant`,
missing `scopes`, wrong `source`) before injecting env, so a
stale or hand-edited file produces a clean login prompt rather
than a leaked `ANTHROPIC_API_KEY=` with an empty value.

## Remote provider runtime wiring (Stage 9.2)

A route of `type=remote, target=proxy` makes the caller's local
Claude/Codex talk to a worker device's local proxy through
`originrouter-server` as a typed relay. The runtime env points at a
caller-side `RemoteCodingRelayProxy` on `127.0.0.1:<port>`, owned
by the local `originrouter claude` / `originrouter codex` wrapper
process (not the long-running daemon). The relay proxy bridges HTTP
↔ SSE `remote.coding.*` events to the relay. The worker-side daemon
receives `remote.coding.request`, strips caller credential/transport
headers (`authorization`, `x-api-key`, `host`, `content-length`,
`connection`, `transfer-encoding`), and forwards the request to the
worker's local LiteLLM proxy, streaming the response back.

The relay forwards the request and response bodies opaquely — it
does not parse them, does not log them, does not write them to disk,
and replaces `headers` and `body` with placeholders in its debug
ring. End-to-end confidentiality (so the relay genuinely cannot
read the body) requires WebRTC / E2EE and is a later stage. 9.2
ships no formal auth — `remote.coding.*` is routed by `deviceId`
alone. A future "9.x security" stage will add `relayAccessToken`
signed by the worker's `deviceGrant`; that stage is the only correct
place to put a real auth check.

Stage 9.2 supports only `target=proxy`. `target=agent` (run the
worker's own Claude/Codex) and WebRTC/P2P are deferred to 9.3+.
