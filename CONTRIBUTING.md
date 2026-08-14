# Contributing

Thanks for helping improve OriginRouter CLI.

## Development setup

```bash
npm install
npm test
npm run release:check
```

Node.js 22 or newer is required. Python is needed only for tests or workflows
that exercise the managed LiteLLM runtime.

## Pull requests

- Keep changes focused and add tests for behavior changes.
- Treat command names, stored configuration, Local API contracts, approval
  policy schemas, and encrypted message formats as compatibility-sensitive.
- Do not commit credentials, transcripts, local state, or provider request data.
- Update the public documentation when a user-facing command or mode changes.
- Run the relevant focused suite and the full test command before requesting review.

For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.
