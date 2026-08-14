# Releasing OriginRouter CLI

## npm does not pre-review normal packages

npm does not run an App Store-style manual approval queue for ordinary public
packages. A publish becomes available when the registry accepts it. npm can
still block or remove packages for naming conflicts, malware, policy violations,
spam, or account/security problems.

The scoped package `@originrouter/cli` returned `404 Not Found` from the public
registry on 2026-08-14. The npm organization owner must publish it with public
access. Recheck immediately before the first publish because availability can change.

## One-time npm setup

1. Create or select the npm owner account and verify its email address.
2. Enable two-factor authentication for account access and package publishing.
3. Sign in locally with `npm login`, then confirm the expected identity with
   `npm whoami`.
4. Confirm the scoped package name with `npm view @originrouter/cli`.
5. Make the first publish manually from a clean tagged commit:

   ```bash
   npm ci
   npm test
   npm run release:check
   npm pack --dry-run
   npm publish --access public
   ```

6. In the published package's npm settings, configure a GitHub Actions trusted
   publisher for repository `originrouter/originrouter_cli` and workflow
   `publish.yml`. The workflow uses GitHub OIDC (`id-token: write`) and does not
   require a long-lived `NPM_TOKEN`.
7. Protect the GitHub `npm` environment and require review if the organization
   wants a human gate before publication.

## Every release

1. Update `package.json` and `src/constants.js` to the same SemVer version.
2. Update release notes and user-facing migration notes.
3. Run `npm test`, `npm run release:check`, and `npm pack --dry-run`.
   Confirm the Windows smoke job also passes, including both generated command
   shims (`originrouter.cmd` and `or.cmd`).
4. Inspect the tarball allowlist. Tests, local state, `.env`, and development
   artifacts must not be present.
5. Commit, create a signed tag such as `v0.1.0`, and publish a GitHub Release.
6. The release event runs `.github/workflows/publish.yml`, tests again, and
   publishes with npm provenance.
7. Verify `npm view @originrouter/cli version dist.integrity` and install the
   published version in a clean temporary directory.

Never reuse a version. npm versions are immutable after publication. If a
release is wrong, deprecate it and publish a new patch version. Unpublish is
time-limited and should be reserved for security or legal emergencies.
