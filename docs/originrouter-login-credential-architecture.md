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
3. Reuses an Access Token when it has more than 60 seconds remaining.
4. Rotates the Refresh Token for the exact requested resource.
5. Atomically persists both the new RT and new audience AT.

The runtime never falls back from one audience to another.

## Revocation and replacement

Logout calls the Surety public revocation endpoint and clears the local file.
Server-side device revoke revokes the Surety session. A new login using the
same `(outer_user_id, device_id, source)` replaces the previous active session.

## Trust boundary

The CLI talks directly to Surety for Device Code, token exchange, refresh, and
public revocation. It talks to `originrouter_server` only for application and
Relay APIs. Backend service-key authenticated Surety endpoints are never
called by the CLI.
