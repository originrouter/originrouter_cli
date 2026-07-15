# Agent Runtime Security Audit

Current runtime invariants:

- Local user providers are LiteLLM proxy configurations.
- OriginRouter Cloud and remote-device routes require OAuth login.
- Cloud catalogue requests use only the AI Access Token.
- Cloud Claude/Codex requests use only the Coding Access Token.
- Bridge reporting uses only the Control Access Token.
- Remote Coding and Relay WebSockets use only the Relay Access Token.
- Access Tokens are refreshed through a single rotating Refresh Token under a
  cross-process lock.
- Device identity is random persisted config identity, never hardware-derived.
- Provider secrets and OAuth credentials are masked from command output and
  excluded from remote-control payloads.
- Remote execution does not receive backend Surety service keys.

The authoritative credential shape is documented in
`originrouter-login-credential-architecture.md`. Historical authentication
designs are obsolete and intentionally removed.
