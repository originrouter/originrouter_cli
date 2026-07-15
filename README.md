# OriginRouter CLI

OriginRouter CLI manages local LiteLLM routes and connects a CLI installation
to OriginRouter Cloud, remote devices, and Proxy Control.

## Install and test

```bash
npm install
npm test
node ./bin/originrouter.js --help
```

## Device identity

The CLI creates a cryptographically random `device-<32 hex>` identifier and
persists it in the local state directory. It never reads MAC addresses,
hardware serials, hostnames, machine IDs, or platform hardware UUIDs.

The same config directory keeps the same device ID across logins. Separate
config directories are separate installations, even on one physical machine.

## OAuth login

```bash
originrouter login
originrouter auth status
originrouter logout
```

Login uses RFC 8628 Device Authorization Grant directly with Surety:

1. CLI requests a Device Code from Surety.
2. CLI prints and opens the verification URL.
3. User approves the code in the H5 page.
4. CLI polls Surety and stores one rotating Refresh Token plus short-lived
   Control, AI, Coding, and Relay Access Tokens.

Credential prefixes:

```text
or_at_*   access token
or_rt_*   refresh token
or_dc_*   device code
or_ses_*  session identifier
```

Credentials are written with mode `0600`. Refresh rotation is protected by a
cross-process lock so two CLI processes cannot reuse the same Refresh Token.

Environment overrides:

```text
SURETY_BASE_URL=https://surety.easytransnote.com
ORIGINROUTER_LOGIN_URL=https://originrouter.com/cli/authorize
ORIGINROUTER_API_BASE_URL=https://app.easytransnote.com
ORIGINROUTER_CONTROL_BASE_URL=https://app.easytransnote.com
ORIGINROUTER_RELAY=https://app.easytransnote.com
```

## Route sources

Local providers are LiteLLM proxy configurations only:

```bash
originrouter provider add my-provider \
  --type proxy \
  --engine litellm \
  --litellm-provider anthropic \
  --base-url https://api.example.com \
  --api-key os.environ/PROVIDER_API_KEY \
  --model model-id
```

OriginRouter Cloud and remote CLI devices are login-backed sources, not local
providers:

```bash
originrouter route cloud models
originrouter route cloud set claude.main
originrouter route remote devices
originrouter route remote set claude.main
```

Audience use is strict:

```text
Control AT  device registry and runtime reporting
AI AT       Cloud model catalogue
Coding AT   Claude/Codex Cloud requests
Relay AT    remote coding and realtime relay
```

## Common commands

```bash
originrouter status
originrouter doctor
originrouter provider list
originrouter route list
originrouter env print --agent claude
originrouter proxy install
originrouter proxy start --port 4000
originrouter daemon
originrouter service install
originrouter claude
originrouter codex
```

`originrouter provider add` does not create an OriginRouter Cloud provider.
Cloud access exists only after OAuth login.

## Security rules

- Never put Surety backend service keys (`or_sk_*`) in CLI config.
- Never send a token to a resource with a different audience.
- Never log raw Access Tokens, Refresh Tokens, Device Codes, or provider keys.
- An expired Refresh Token requires a new login.
- Logout/revoke removes local credentials and revokes the Surety session.

See [docs/originrouter-login-credential-architecture.md](docs/originrouter-login-credential-architecture.md)
for the credential contract and [docs/provider-route-resolution.md](docs/provider-route-resolution.md)
for route precedence.
