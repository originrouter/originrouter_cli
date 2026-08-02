#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from "node:crypto";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  COMPATIBILITY_CODE_BUNDLE_SCHEMA,
  COMPATIBILITY_CODE_ENGINE_VERSION,
  COMPATIBILITY_CODE_SIGNATURE_DOMAIN,
  COMPATIBILITY_CODE_SIGNED_ENVELOPE,
  COMPATIBILITY_WASM_ABI,
  canonicalCompatibilityCodeJson,
  orderCompatibilityCodePatches,
  validateCompatibilityCodeBundle,
} from "../src/compatibility/codeBundle.js";
import { compileCompatibilityWasm, executeCompatibilityWasm } from "../src/compatibility/wasmDomHost.js";

const SOURCE_SCHEMA = "originrouter-compatibility-patch-source-v1";
const asc = fileURLToPath(new URL("../node_modules/assemblyscript/bin/asc.js", import.meta.url));

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument '${key || ""}'`);
    result[key.slice(2)] = value;
  }
  return result;
}

function defaultPrivateKey() {
  return join(homedir(), ".originrouter-release", "compatibility.private.pem");
}

function readNextRevision(output) {
  if (!existsSync(output)) return 1;
  try {
    const current = JSON.parse(readFileSync(output, "utf8"));
    const revision = current?.payload?.revision;
    return Number.isSafeInteger(revision) && revision >= 1 ? revision + 1 : 1;
  } catch {
    return 1;
  }
}

function sourceManifest(directory) {
  const path = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.schema !== SOURCE_SCHEMA) throw new Error(`${path} has an unsupported schema`);
  const allowed = new Set([
    "schema", "id", "name", "description", "version", "phase", "priority", "required", "failure_mode", "entry",
    "match", "before", "after", "conflicts_with",
  ]);
  for (const key of Object.keys(manifest)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
  if (typeof manifest.entry !== "string" || !manifest.entry || manifest.entry.includes("..")) {
    throw new Error(`${path}.entry must be a file inside the patch directory`);
  }
  const entry = resolve(directory, manifest.entry);
  if (dirname(entry) !== resolve(directory) || !existsSync(entry) || !statSync(entry).isFile()) {
    throw new Error(`${path}.entry does not identify a patch source file`);
  }
  return { manifest, entry };
}

async function compilePatch(directory, temporaryDirectory) {
  const { manifest, entry } = sourceManifest(directory);
  const output = join(temporaryDirectory, `${manifest.id}.wasm`);
  const compilation = spawnSync(process.execPath, [
    asc,
    entry,
    "--outFile", output,
    "--runtime", "stub",
    "--importMemory",
    "--noExportMemory",
    "--initialMemory", "2",
    "--maximumMemory", "256",
    "--stackSize", "16384",
    "--optimize",
    "--noAssert",
    "--noUnsafe",
  ], { encoding: "utf8" });
  if (compilation.status !== 0) {
    throw new Error(`failed to compile ${manifest.id}:\n${compilation.stderr || compilation.stdout}`);
  }
  const bytes = readFileSync(output);
  const module = await compileCompatibilityWasm(bytes);
  const testsDirectory = join(directory, "tests");
  const fixtures = existsSync(testsDirectory)
    ? readdirSync(testsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(testsDirectory, entry.name))
      .sort()
    : [];
  if (fixtures.length === 0) throw new Error(`${manifest.id} must provide at least one tests/*.json fixture`);
  for (const fixturePath of fixtures) {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const result = executeCompatibilityWasm(module, fixture.input, fixture.context || {}, fixture.state || {});
    assert.deepEqual(result.document, fixture.expected, `${fixturePath} output mismatch`);
    assert.equal(result.changed, fixture.changed, `${fixturePath} changed flag mismatch`);
    if (Object.prototype.hasOwnProperty.call(fixture, "expected_state")) {
      assert.deepEqual(result.state, fixture.expected_state, `${fixturePath} state mismatch`);
    }
  }
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    phase: manifest.phase,
    priority: manifest.priority,
    required: manifest.required,
    failure_mode: manifest.failure_mode,
    match: manifest.match || {},
    before: manifest.before || [],
    after: manifest.after || [],
    conflicts_with: manifest.conflicts_with || [],
    module: {
      runtime: "wasm",
      abi: COMPATIBILITY_WASM_ABI,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.toString("base64"),
    },
  };
}

const args = options(process.argv.slice(2));
if (!args["source-dir"] || !args.output) {
  throw new Error(
    "Usage: npm run release:compatibility -- --source-dir <patches-dir> --output <patches.signed.json> "
    + "[--private-key <ed25519.pem>] --key-id <id> [--revision <n>]",
  );
}
const sourceDir = resolve(args["source-dir"]);
const output = resolve(args.output);
const privateKeyPath = resolve(args["private-key"] || process.env.ORIGINROUTER_COMPATIBILITY_SIGNING_KEY || defaultPrivateKey());
const keyId = args["key-id"] || process.env.ORIGINROUTER_COMPATIBILITY_SIGNING_KEY_ID;
if (!keyId) throw new Error("--key-id or ORIGINROUTER_COMPATIBILITY_SIGNING_KEY_ID is required");
const revision = args.revision == null ? readNextRevision(output) : Number(args.revision);
if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("revision must be a positive integer");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "originrouter-compatibility-release-"));

try {
  mkdirSync(dirname(output), { recursive: true });
  const directories = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(sourceDir, entry.name))
    .filter((directory) => existsSync(join(directory, "manifest.json")))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
  if (directories.length === 0 && args["allow-empty"] !== "true") {
    throw new Error(`no patch manifests found under ${sourceDir}; pass --allow-empty true for an intentional empty snapshot`);
  }
  const compiled = [];
  for (const directory of directories) compiled.push(await compilePatch(directory, temporaryDirectory));
  const payload = validateCompatibilityCodeBundle({
    schema: COMPATIBILITY_CODE_BUNDLE_SCHEMA,
    bundle_id: "originrouter-compatibility",
    revision,
    min_engine_version: COMPATIBILITY_CODE_ENGINE_VERSION,
    max_engine_version: null,
    generated_at: new Date().toISOString(),
    expires_at: null,
    complete_snapshot: true,
    patches: compiled,
  });
  orderCompatibilityCodePatches(payload.patches);
  const privateKey = createPrivateKey(readFileSync(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("compatibility signing key must be Ed25519");
  const signature = sign(
    null,
    Buffer.from(`${COMPATIBILITY_CODE_SIGNATURE_DOMAIN}${canonicalCompatibilityCodeJson(payload)}`),
    privateKey,
  ).toString("base64url");
  const envelope = {
    schema: COMPATIBILITY_CODE_SIGNED_ENVELOPE,
    key_id: keyId,
    algorithm: "Ed25519",
    payload,
    signature,
  };
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, output);
  chmodSync(output, 0o644);
  console.log(`Released ${payload.patches.length} WASM patches as revision ${payload.revision}: ${output}`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
