# CLI Local Mgmt API — PR Review Checklist

> Source: `cli-local-management-security.md`
> Use this in PR review for any change under
> `originrouter-cli/src/local/` or any code that mounts the
> 127.0.0.1 control plane.

## 4 layers of defense

- [ ] Host check: only `127.0.0.1:<port>`, `localhost:<port>`, and
      `--bind-host` value pass; everything else `403 host_not_allowed`
- [ ] Origin check: same-origin + `OR_CLI_TRUSTED_ORIGINS` only;
      `Origin: null` and `https://originrouter.com` both rejected
- [ ] Auth + Sec-Fetch-Site: writes require `Authorization` +
      `Sec-Fetch-Site: same-origin` (or `none` for direct CLI);
      `Sec-Fetch-Mode: cors` present
- [ ] Network: bound to `127.0.0.1:<random>`; never `0.0.0.0`;
      CORS preflight returns exact origin, never `*`

## CSRF synchronizer token

- [ ] `GET /api/csrf` returns token + sets
      `Set-Cookie: or_cli_csrf=...; HttpOnly=false; Secure=true; SameSite=Strict`
- [ ] Mutations + sensitive reads require `X-CSRF-Token` matching
      the cookie
- [ ] On mismatch: `419 csrf_token_mismatch`

## Rate limits (per mgmt-token)

- [ ] Mutation 60/min
- [ ] Sensitive reads 120/min
- [ ] status / health 300/min
- [ ] doctor / proxy-restart 5/min
- [ ] `429` response includes `Retry-After` header

## mgmt-token

- [ ] Generated at startup as 32 random bytes (base64url)
- [ ] Never written to disk, env, or stdout/stderr
- [ ] Rotated on every CLI restart
- [ ] IPC'd to the desktop shell via Unix socket / named pipe

## Audit (Sprint 0.7 — flag for follow-up PR)

- [ ] `device_route_create` writes audit
- [ ] `device_route_update` writes audit
- [ ] `device_route_delete` writes audit
- [ ] `device_doctor_run` writes audit
- [ ] `device_proxy_restart` writes audit
- [ ] `device_disconnect` writes audit
- [ ] `GET /api/routes*` writes audit
- [ ] `GET /api/requests/recent` writes audit
- [ ] `GET /api/devices/connected` writes audit
- [ ] No audit `meta_json` field contains `sk-…` or `Bearer …`

## Error code discipline

- [ ] `5xx` responses do not leak stack traces or internal details
- [ ] All error responses follow `{ "code": <int>, "msg": <safe>, "data": null }`

## Test coverage

- [ ] Unit test: `Origin: null` returns 403
- [ ] Unit test: `Origin: https://originrouter.com` returns 403
- [ ] Unit test: `Host: example.com` returns 403
- [ ] Unit test: mutation without `X-CSRF-Token` returns 419
- [ ] Unit test: mutation with mismatched CSRF cookie+header returns 419
- [ ] Unit test: rate limit returns 429 with `Retry-After`
- [ ] Integration: `evil.com` trying to call `/api/routes` cannot
      reach the endpoint (CORS preflight fails)
- [ ] No regressions in `originrouter-cli/tests/test_*.py`
