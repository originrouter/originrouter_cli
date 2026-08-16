# Third-party notices

OriginRouter is an independent project. Its own source code is licensed under
the license stated in [`LICENSE`](LICENSE). That license does not replace or
override the licenses, commercial terms, account terms, or usage policies that
apply to third-party products and dependencies.

This notice is provided for transparency and is not a substitute for the
complete terms published by each third party.

## User-installed developer tools

OriginRouter can interoperate with developer tools installed and authenticated
by the user, including Claude Code and Codex. These products are not licensed
under the OriginRouter license. Users are responsible for obtaining the
required accounts, subscriptions, licenses, and access rights.

- Claude, Claude Code, and related Anthropic services are subject to the
  applicable [Anthropic legal agreements](https://code.claude.com/docs/en/legal-and-compliance),
  including the [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms)
  when those terms apply.
- Codex and related OpenAI services are subject to their applicable licenses,
  account terms, and usage policies.

References to third-party products identify compatibility and do not imply
affiliation, endorsement, sponsorship, or partnership.

## Anthropic Claude Agent SDK

The `@anthropic-ai/claude-agent-sdk` package is currently an OriginRouter npm
dependency used by the managed Claude runtime. It is not licensed under the
OriginRouter license. Its package license states that use is subject to the
Anthropic legal agreements linked above. Components shipped within that SDK
may carry separate licenses in their own distributions.

## LiteLLM

OriginRouter can create a user-local Python virtual environment and install a
pinned LiteLLM Proxy release on demand. LiteLLM is not included in the
OriginRouter npm tarball.

The LiteLLM repository states that content outside its separately licensed
`enterprise/` directory is available under the MIT License:

> MIT License  
> Copyright (c) 2023 Berri AI

See the complete [LiteLLM license](https://github.com/BerriAI/litellm/blob/main/LICENSE).
OriginRouter does not include or grant rights to LiteLLM Enterprise features.

## Direct open-source npm dependencies

The following direct dependencies declare the MIT License in their package
metadata at the time of this notice:

- `@modelcontextprotocol/sdk`
- `better-sqlite3`
- `node-pty`
- `ws`
- `zod`

Their complete license texts and copyright notices are included in their
respective package distributions. Transitive dependencies may use additional
licenses; the installed dependency tree and each distributed license file are
authoritative.

## Trademarks

Anthropic, Claude, Claude Code, OpenAI, Codex, LiteLLM, and other product names
and marks are the property of their respective owners. The OriginRouter license
does not grant rights to any third-party trademark.
