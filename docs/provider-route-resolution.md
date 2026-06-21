# Provider Route Resolution

> **Stage 9.0.** The single source of truth for which HTTP
> transport an agent invocation uses, given its provider type,
> runtime, and resolved model id. Implemented in pure ESM at
> `src/config/providerRoutes.js`; the runtime does not yet
> call it (9.1+).

## The three provider types

| Type | Transport | Endpoint prefix | Auth | Notes |
|---|---|---|---|---|
| `originrouter` | `originrouter-coding` | `/coding/...` | managed coding key (Stage 9.1+ exchange) | Real model id. Default base URL `https://server.originrouter.com`. |
| `proxy` | `proxy` | `/v1/...` | LiteLLM-rendered; engine is `litellm` | Fixed alias per slot. |
| `remote` | `remote` | `null` (the device resolves) | device grant | Off by default. 9.1+ real impl. |

`litellm` is a CLI-input alias that persists as
`proxy(engine=litellm)`. It is NOT a wire type. `openai-compatible`
is REJECTED on write.

## Runtime → endpoint table

The `resolveRoute` helper returns one of the following for
`providerType: "originrouter"`:

| Runtime | Endpoint |
|---|---|
| `claude` | `/coding/v1/messages` |
| `claude-sdk` | `/coding/v1/messages` |
| `codex` | `/coding/v1/responses` |
| `codex-app-server` | `/coding/v1/responses` |
| (none) | `/coding/v1/messages` (default for Claude) |

For `providerType: "proxy"`:

| Runtime | Endpoint | Default model |
|---|---|---|
| `claude` | `/v1/messages` | `originrouter-claude-model` |
| `claude-sdk` | `/v1/messages` | `originrouter-claude-model` |
| `claude-fast` | `/v1/messages` | `originrouter-claude-fast-model` |
| `codex` | `/v1/responses` | `originrouter-codex-model` |
| `codex-app-server` | `/v1/responses` | `originrouter-codex-model` |

For `providerType: "remote"`:

| Runtime | Endpoint | Notes |
|---|---|---|
| (any) | `null` | Resolved by the remote device. The CLI's role is to forward the request to the device, full stop. |

## Codex endpoint default

- **Official originrouter:** `/coding/v1/responses`
- **Local proxy:** `/v1/responses`

`/v1/chat/completions` is a backend alias the CLI does not
target in 9.0. The CLI's Codex path always uses
`/v1/responses` (or `/coding/v1/responses` on the official
endpoint). Choosing `/v1/responses` over
`/v1/chat/completions` is documented here so future stages do
not need to re-derive it.

## Proxy alias table

```
originrouter-claude-model         (Claude main slot, full-strength)
originrouter-claude-fast-model    (Claude small slot, fast variant)
originrouter-codex-model          (Codex main slot)
```

These are the **only** model strings the proxy transport
emits when the caller does not supply an explicit model. They
map to whatever the LiteLLM profile + `providerRoutes.js`
configuration specifies at proxy-start time. The alias table is
the same one used by `src/config/routes.js#ROUTE_DEFS`.

## The `remote` transport

`remote` does not resolve locally. The CLI's role is to
forward the request to the device id, full stop. The route
resolver returns:

```js
{
  transport: "remote",
  endpoint: null,
  model: <remote-resolved or explicit>,
  deviceId: <required>,
  target: "proxy" | "agent",  // default "proxy"
}
```

The `target` field tells the device which subsystem on the
remote side should answer:

- `target: "proxy"` — the device's local LiteLLM proxy.
- `target: "agent"` — the device's local Claude / Codex
  agent runtime.

## DEFAULT_ORIGINROUTER_BASE_URL

`https://server.originrouter.com` is exported from
`src/config/providerRoutes.js`. The CLI's `buildAgentProviderEnv`
and the runtime path that actually opens the HTTP connection
must use this constant when a provider record's `baseUrl` is
null / undefined. The constant lives in ONE place so a future
move of the official server is a one-line change.

## Why the /coding prefix is part of the contract

Mixing `/coding/...` and bare `/v1/...` would produce a
request the runtime cannot dispatch unambiguously: the same
`/v1/messages` path means different things on the official
endpoint vs the local proxy. Locking the prefix into the
resolver output means the runtime can read the path and
immediately know which transport to use, without a separate
flag. This is also why `providerRoutes.js` is the **only**
module in the CLI that constructs these paths.

## Out of scope (preserved)

- The resolver does NOT resolve auth (managed key exchange
  is 9.1+).
- The resolver does NOT retry on network failure.
- The resolver does NOT decide whether the local daemon is
  allowed to control a remote device — that is a separate
  permission layer.
- The resolver does NOT pick a model when one is not
  supplied for `providerType: "originrouter"` (it returns
  `null`); the calling code must either supply one or
  surface an error.
