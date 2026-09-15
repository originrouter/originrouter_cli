import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const constants = await readFile(new URL("../src/constants.js", import.meta.url), "utf8");
const args = process.argv.slice(2);
const tagIndex = args.indexOf("--tag");
const releaseTag = tagIndex >= 0 ? args[tagIndex + 1]?.trim() : "";

if (tagIndex >= 0) {
  assert(releaseTag, "--tag requires a GitHub Release tag");
  assert.equal(
    releaseTag,
    `v${pkg.version}`,
    `GitHub Release tag must be v${pkg.version} for ${pkg.name}@${pkg.version}`,
  );
}

assert.equal(pkg.private, undefined, "package.json must not set private=true");
assert.equal(pkg.license, "Apache-2.0");
assert(pkg.repository?.url, "repository.url is required");
assert(pkg.homepage, "homepage is required");
assert(pkg.bugs?.url, "bugs.url is required");
assert(pkg.files?.length, "an explicit files allowlist is required");
assert.equal(pkg.publishConfig?.access, "public");
assert.equal(pkg.name, "@originrouter/cli", "the public npm package name must be @originrouter/cli");
assert.equal(pkg.bin?.originrouter, "bin/originrouter.js");
assert.equal(pkg.bin?.or, "bin/originrouter.js");
// src/constants.js derives VERSION from package.json at runtime, so no
// static version match is required here. Guard against regressions to a
// hardcoded literal instead.
assert(
  !/^export const VERSION = "/m.test(constants),
  "src/constants.js must derive VERSION from package.json, not hardcode it",
);

await access(new URL("../LICENSE", import.meta.url));
await access(new URL("../NOTICE", import.meta.url));
await access(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url));
await access(new URL("../README.md", import.meta.url));
await access(new URL("../bin/originrouter.js", import.meta.url));

console.log(
  `release metadata ok: ${pkg.name}@${pkg.version}${releaseTag ? ` (${releaseTag})` : ""}`,
);
