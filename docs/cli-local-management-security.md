# CLI Local Management Security Implementation Spec v1

> Status: Sprint 0.2 (P0-4) — DRAFT
> Audience: CLI engineer implementing the local HTTP control plane in Sprint 0.6
> Source of truth: `origin_router_h5/docs/security/cli-local-mgmt-api-contract.md`

This document translates the Stage 10.0 / Sprint 0.1 *contract* into a
*checklist* the CLI engineer can implement against and that PR review
can use to gate the change.

## 0. Scope

The CLI exposes a local HTTP API on `127.0.0.1:<random_port>` that:

- The CLI's own bundled control console page can call (same-origin)
- The desktop shell (Electron / Tauri) can call (with explicit
  `Origin` trust)
- Remote devices reach via the OriginRouter Relay (mobile app →
  AI Server → Surety → this CLI's mgmt port)

**Browser PWA / mobile WebView is NEVER a direct caller.** The H5
control surface always goes through the Relay, not this port.

## 1. The 4 layers of defense (mandatory, all four)

### 1.1 Host header check (mandatory)

- Accept: `127.0.0.1:<port>`, `localhost:<port>`, and the value
  passed via `--bind-host` at startup (rare; off by default).
- Reject everything else with `403 host_not_allowed`.
- The bound port is chosen at random at startup and recorded in
  `~/.originrouter/state/control-port`. **Never** listen on
  `0.0.0.0`.

### 1.2 Origin strict whitelist (mandatory; no `null`)

The following Origins are accepted; **all others** are rejected:

- `http://127.0.0.1:<port>` (the CLI's own served console)
- Origins declared by the desktop shell at startup via
  `OR_CLI_TRUSTED_ORIGINS` (comma-separated). Empty by default.

Explicitly rejected:

- `Origin: null` (sandboxed iframe / `file://` / `data:` / worker)
- `https://originrouter.com` (the official H5 domain — this CLI
  trusts it for nothing; the H5 always reaches the CLI via the
  Relay, which injects the mgmt-token)
- Any other origin

### 1.3 Authorization + Sec-Fetch-Site (mandatory)

For **every write** (`PUT` / `POST` / `DELETE`) and **every sensitive
read** (`/api/routes*`, `/api/requests/recent`,
`/api/devices/connected`):

- `Authorization: Bearer <mgmt-token>` header required
- `Sec-Fetch-Site: same-origin` OR `Sec-Fetch-Site: none` (CLI direct)
- `Sec-Fetch-Mode: cors` present
- `X-CSRF-Token: <csrf_token>` header (see §2)

For non-sensitive reads (`/api/status`, `/api/health`): no auth
required on the same-origin path, but the Origin/Host checks from
§1.1-§1.2 still apply.

### 1.4 Network and CORS (mandatory)

- Bind to `127.0.0.1:<random_port>`. **Never** `0.0.0.0`.
- Port randomized at startup. Persist the port to
  `~/.originrouter/state/control-port` with mode `0600`. Do **not**
  persist the mgmt-token anywhere.
- CORS responses use the exact whitelisted origin. **Never**
  `Access-Control-Allow-Origin: *`.
- Preflight (`OPTIONS`) is allowed only for whitelisted origins.

## 2. CSRF synchronizer token (mandatory)

- `GET /api/csrf` returns `{ "csrf_token": "<token>" }` and sets
  `Set-Cookie: or_cli_csrf=<token>; HttpOnly=false; Secure=true;
  SameSite=Strict; Path=/`.
- The control console page reads the cookie and includes the
  token in `X-CSRF-Token` on every mutation / sensitive read.
- Server validates that the cookie value **equals** the header
  value (synchronizer token pattern). On mismatch return `419
  csrf_token_mismatch`.
- Tokens rotate on a configurable interval (default 4h) and on
  logout.

## 3. Rate limits (per mgmt-token)

| Bucket | Limit |
|---|---|
| Mutation (`PUT`/`POST`/`DELETE` on routes) | 60 / min |
| Sensitive reads (`/api/routes*`, `/api/requests/recent`) | 120 / min |
| Status / health | 300 / min |
| `POST /api/doctor` / `/api/proxy/restart` | 5 / min |

`429` on exceed; include `Retry-After: <seconds>`.

## 4. mgmt-token lifecycle

- Generated at startup: `crypto.randomBytes(32).toString("base64url")`.
- **Never** written to disk, env, or stdout/stderr.
- Rotated on every CLI restart.
- IPC'd to the desktop shell via Unix socket (macOS/Linux) or
  named pipe (Windows). The shell caches it in OS Keychain
  (macOS) / Credential Manager (Windows).
- Revoke: the user clicks "disconnect this device" in the App,
  the AI Server signals the CLI process, the in-memory token is
  zero-filled.

## 5. Audit integration (handoff to Sprint 0.7)

Sprint 0.6 ships the API surface; Sprint 0.7 wires the 5 write
operations and 3 sensitive reads into the audit log via
`audit_log.write_audit(...)`.

- Writes that MUST audit: `device_route_create`,
  `device_route_update`, `device_route_delete`, `device_doctor_run`,
  `device_proxy_restart`, `device_disconnect`
- Reads that MUST audit: `GET /api/routes`, `GET /api/routes/:name`,
  `GET /api/requests/recent`, `GET /api/devices/connected`

The audit helper is already in place at
`UPT_back_end/originrouter_cli/audit_log.py`. Redaction is
baked in (Sprint 0.1 contract).

## 6. Error code map

| HTTP | `code` | Meaning |
|---|---|---|
| 200 | 0 | success |
| 400 | 400 | bad parameter |
| 401 | 401 | missing or invalid `Authorization` |
| 403 | 403 | host / origin / CSRF rejected |
| 404 | 404 | resource not found |
| 409 | 409 | state conflict (e.g. route in use) |
| 410 | 410 | token expired (CLI restart) |
| 419 | 419 | CSRF token mismatch |
| 429 | 429 | rate limit (with `Retry-After`) |
| 500 | 500 | internal error; do not leak details |
| 503 | 503 | proxy not running / health failure |

## 7. Implementation checklist (Sprint 0.6 review gate)

- [ ] Bind 127.0.0.1 + random port; persist port to state file
- [ ] Reject all non-127.0.0.1 hosts (`403 host_not_allowed`)
- [ ] Reject `Origin: null` and `https://originrouter.com` (`403 origin_not_allowed`)
- [ ] `GET /api/csrf` sets cookie + returns token
- [ ] Mutations require `Authorization` + `Sec-Fetch-Site: same-origin` + `X-CSRF-Token`
- [ ] CORS preflight returns exact origin, never `*`
- [ ] Rate limits enforced per token (60/120/300/5 per minute)
- [ ] mgmt-token generated in memory only; never logged
- [ ] `app_audit_log` writes wired (5 writes + 3 sensitive reads) — Sprint 0.7
- [ ] Error responses use the `code` table from §6

## 8. Out of scope for Sprint 0.6 (do not implement)

- Provider Vault: Sprint 0.3
- Memory API: Sprint 0.4
- Relay Control Plane: Sprint 0.5
- Audit write-point integration: Sprint 0.7
- CLI local console UI: Sprint 0.6 ships the API only; the page
  is a separate workstream
