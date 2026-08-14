import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const constants = await readFile(new URL("../src/constants.js", import.meta.url), "utf8");

assert.equal(pkg.private, undefined, "package.json must not set private=true");
assert.equal(pkg.license, "MIT");
assert(pkg.repository?.url, "repository.url is required");
assert(pkg.homepage, "homepage is required");
assert(pkg.bugs?.url, "bugs.url is required");
assert(pkg.files?.length, "an explicit files allowlist is required");
assert.equal(pkg.publishConfig?.access, "public");
assert.equal(pkg.name, "originrouter", "the public npm package name must be originrouter");
assert.equal(pkg.bin?.originrouter, "bin/originrouter.js");
assert.equal(pkg.bin?.or, "bin/originrouter.js");
assert(constants.includes(`VERSION = "${pkg.version}"`), "src/constants.js VERSION must match package.json");

await access(new URL("../LICENSE", import.meta.url));
await access(new URL("../README.md", import.meta.url));
await access(new URL("../bin/originrouter.js", import.meta.url));

console.log(`release metadata ok: ${pkg.name}@${pkg.version}`);
