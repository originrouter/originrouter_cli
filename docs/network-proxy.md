# Network proxy selection

Network proxy settings are independent of model providers and model routing.
They do not change an Agent's API endpoint, model alias, login or billing.

## Selection and scope

For installations and Agent child processes, OriginRouter uses this order:

1. Existing `http_proxy` / `HTTP_PROXY`, `https_proxy` / `HTTPS_PROXY`, or
   `all_proxy` / `ALL_PROXY`. Existing values are not replaced by OS settings.
2. `ORIGINROUTER_PROXY`, as an explicit fallback when those variables are absent.
3. Available static system settings: macOS SystemConfiguration (`scutil`),
   Windows Internet Settings, or Linux GNOME/KDE user settings.
4. No added proxy configuration when no supported setting is available.

Missing uppercase/lowercase aliases are filled for compatibility. If the user
supplies conflicting spellings, both are preserved. Prefer consistent values:
different tools have different precedence rules. In particular, curl ignores
uppercase `HTTP_PROXY` for HTTP requests.

Discovery supplies a fresh environment to each child, including nested
downloads. It does not write Shell profiles or user/system proxy settings.
Existing proxy variables are not cleared when the OS proxy is switched off.
Automatically discovered bypass lists retain OS exclusions and localhost,
127.0.0.1 and ::1. User-supplied `NO_PROXY` is preserved.

`ORIGINROUTER_NO_PROXY=1` disables OS/fallback discovery; it does not delete
manual proxy variables. The installer option `--no-proxy` / `-NoProxy`
continues to mean “skip the LiteLLM runtime”, not “disable a network proxy”.

The Unix pre-Node bootstrap discovers macOS and GNOME static settings. KDE
discovery is available in the Node-based setup and command paths. Headless
Linux hosts normally use environment variables. Static OS reads are optional;
Node-based discovery uses bounded subprocesses.

Windows PowerShell installation also bridges HTTP(S) settings to the current
.NET web client for Windows PowerShell 5.1. When invoked through `irm | iex`,
the installer's proxy environment and .NET settings are restored on exit.

## Native agy entry

```sh
originrouter agy
originrouter agy --conversation=<native-conversation-id>
```

The native entry inherits the resolved network environment and preserves
official agy flags. `--native-config` is implicit; spelling it explicitly is
also accepted and consumed by OriginRouter. `--provider` is rejected.

Interactive runs now register the native PTY session and use official Hooks plus transcripts for App control. App-created/resumed sessions use the separate official ACP runtime. See [Antigravity integration](antigravity-integration.md).
Those require their own runtime adapter and end-to-end verification. A
successful `--version` verifies startup, not login or a model request.

## Compatibility boundaries

- Proxy variables are a widely used convention, not a universal standard.
  `ALL_PROXY` and SOCKS support vary. Claude Code's published network guide
  explicitly says it does not support SOCKS proxies. An HTTP CONNECT proxy
  can carry HTTPS requests using an `http://` proxy URL.
- PAC/WPAD is destination-dependent. A PAC URL must not be exported as if it
  were a static HTTP proxy. Automatic PAC evaluation is not implemented here.
- `NO_PROXY` wildcard and CIDR matching also varies by client. Keeping the
  user's values does not guarantee that every external tool interprets them
  identically.
- Exporting variables for a child does not itself configure OriginRouter's
  Node HTTP, fetch or WebSocket transports. Each transport needs compatible
  proxy handling. Do not infer full network support from child startup alone.
- macOS live tests pass. Windows/Linux settings have fixture coverage; their
  complete native installation/network paths still need platform testing.

## Validation

The setup suite includes system-setting fixtures, environment precedence,
per-protocol URLs, bypass preservation, nested download inheritance, and a
clean CLI-entry test for `originrouter agy`. A macOS smoke test additionally
launched the installed official agy 1.5.12 through the same environment chain.

## References

- [curl proxy environment](https://everything.curl.dev/usingcurl/proxies/env.html)
- [Python getproxies](https://docs.python.org/3/library/urllib.request.html#urllib.request.getproxies)
- [Go ProxyFromEnvironment](https://pkg.go.dev/net/http#ProxyFromEnvironment)
- [Claude Code network configuration](https://code.claude.com/docs/en/network-config)
- [Node built-in proxy support](https://nodejs.org/api/http.html#built-in-proxy-support)
