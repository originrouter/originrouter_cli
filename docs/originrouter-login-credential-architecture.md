# CLI OAuth Credential Architecture

## Stored shape

The CLI stores one OAuth credential document:

```js
{
  kind: "oauth",
  clientId: "originrouter_cli",
  source: "originrouter_cli",
  deviceId: "device-<32 hex>",
  sessionId: "or_ses_...",
  refreshToken: "or_rt_...",
  refreshExpiresAt: 0,
  tokenEndpoint: "https://surety.easytransnote.com/api/oauth/token",
  revocationEndpoint: "https://surety.easytransnote.com/api/oauth/revoke",
  accessTokens: {
    control: { token: "or_at_...", expiresAt: 0, scopes: [] },
    ai: { token: "or_at_...", expiresAt: 0, scopes: [] },
    coding: { token: "or_at_...", expiresAt: 0, scopes: [] },
    relay: { token: "or_at_...", expiresAt: 0, scopes: [] }
  }
}
```

The file is private (`0600`). No managed coding key, device grant, backend
service key, or hardware identifier is stored.

## Login

The CLI uses the RFC 8628 Device Authorization Grant against Surety. The
Device Code is short-lived and secret; the User Code is safe to display but
must still expire quickly.

After approval, the CLI receives the first Access/Refresh Token pair. It then
rotates the Refresh Token sequentially to obtain tokens for:

```text
originrouter.control
originrouter.ai
originrouter.coding
originrouter.relay
```

Sequential rotation is mandatory. Refreshing audiences in parallel would
reuse the same one-time Refresh Token and trigger session compromise handling.

## Runtime refresh

`src/runtime/oauthTokenRefresher.js`:

1. Reads the credential under a cross-process lock.
2. Rejects an expired Refresh Token before network access.
3. Reuses an Access Token when it has enough lifetime for the caller. Coding
   requests require 120 seconds of headroom; other callers default to 60.
4. Rotates the Refresh Token for the exact requested resource.
5. Atomically persists both the new RT and new audience AT.

The runtime never falls back from one audience to another.

## Coding runtime distribution

Claude and Codex never receive the real `originrouter.coding` Access Token.
Each managed session starts a loopback-only auth proxy on an ephemeral
`127.0.0.1` port and gives the child process a random session capability.

Before every `/coding/v1/messages`, `/coding/v1/chat/completions`, or
`/coding/v1/responses` request, the proxy obtains a sufficiently fresh Coding
Access Token and forwards the request to the fixed upstream
`https://api.easytransnote.com`. An upstream 401 causes one guarded refresh
and retry. The proxy is destroyed when its owning session exits.

## Revocation and replacement

Logout calls the Surety public revocation endpoint and clears the local file.
Server-side device revoke revokes the Surety session. A new login using the
same `(outer_user_id, device_id, source)` replaces the previous active session.

## Trust boundary

The CLI talks directly to Surety for Device Code, token exchange, refresh, and
public revocation. Application and Relay traffic goes to `originrouter_server`;
Coding inference goes to `api.easytransnote.com` through the session-local auth
proxy. Backend service-key authenticated Surety endpoints are never called by
the CLI.
