import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  COMPATIBILITY_CODE_BUNDLE_SCHEMA,
  COMPATIBILITY_CODE_SIGNATURE_DOMAIN,
  COMPATIBILITY_CODE_SIGNED_ENVELOPE,
  COMPATIBILITY_WASM_ABI,
  canonicalCompatibilityCodeJson,
  orderCompatibilityCodePatches,
  validateCompatibilityCodeBundle,
  verifySignedCompatibilityCodeBundle,
} from "../src/compatibility/codeBundle.js";
import { CompatibilityEngine } from "../src/compatibility/engine.js";
import {
  installSignedCompatibilityPack,
  loadActiveCompatibilityPack,
  rollbackCompatibilityPack,
} from "../src/compatibility/patchStore.js";
import { WasmPatchExecutor } from "../src/compatibility/wasmExecutor.js";

const directory = mkdtempSync(join(tmpdir(), "originrouter-compatibility-wasm-"));
const asc = fileURLToPath(new URL("../node_modules/assemblyscript/bin/asc.js", import.meta.url));

function compile(name, source) {
  const input = join(directory, `${name}.ts`);
  const output = join(directory, `${name}.wasm`);
  writeFileSync(input, source);
  const result = spawnSync(process.execPath, [
    asc, input,
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
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return readFileSync(output);
}

function moduleRecord(bytes) {
  return {
    runtime: "wasm",
    abi: COMPATIBILITY_WASM_ABI,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.toString("base64"),
  };
}

const setterSource = `
@external("originrouter_json_v1", "object_set")
declare function objectSet(handle: i32, pointer: usize, length: i32, value: i32): i32;
@external("originrouter_json_v1", "create_string_utf8")
declare function createString(pointer: usize, length: i32): i32;
function bytes(value: string): ArrayBuffer { return String.UTF8.encode(value, false); }
export function originrouter_patch_apply(root: i32, context: i32, state: i32): i64 {
  const key = bytes("wasm_test");
  const stateKey = bytes("seen");
  const valueBytes = bytes("ok");
  const value = createString(changetype<usize>(valueBytes), valueBytes.byteLength);
  objectSet(root, changetype<usize>(key), key.byteLength, value);
  objectSet(state, changetype<usize>(stateKey), stateKey.byteLength, value);
  return (<i64>1 << 32) | <i64><u32>root;
}
`;

try {
  const bytes = compile("setter", setterSource);
  const payload = validateCompatibilityCodeBundle({
    schema: COMPATIBILITY_CODE_BUNDLE_SCHEMA,
    bundle_id: "wasm-test",
    revision: 1,
    min_engine_version: "2.0.0",
    max_engine_version: null,
    generated_at: null,
    expires_at: null,
    complete_snapshot: true,
    patches: [{
      id: "wasm.setter",
      version: "1.0.0",
      phase: "request",
      priority: 10,
      required: true,
      failure_mode: "reject",
      match: { paths: ["/v1/responses"] },
      before: [],
      after: [],
      conflicts_with: [],
      module: moduleRecord(bytes),
    }],
  });

  const pair = generateKeyPairSync("ed25519");
  const envelope = {
    schema: COMPATIBILITY_CODE_SIGNED_ENVELOPE,
    key_id: "wasm-test",
    algorithm: "Ed25519",
    payload,
    signature: sign(
      null,
      Buffer.from(`${COMPATIBILITY_CODE_SIGNATURE_DOMAIN}${canonicalCompatibilityCodeJson(payload)}`),
      pair.privateKey,
    ).toString("base64url"),
  };
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
  assert.equal(verifySignedCompatibilityCodeBundle(envelope, { "wasm-test": publicKey }).revision, 1);

  const stateDir = join(directory, "state");
  assert.equal(installSignedCompatibilityPack(stateDir, envelope, { "wasm-test": publicKey }).installed, true);
  assert.equal(loadActiveCompatibilityPack(stateDir).schema, COMPATIBILITY_CODE_BUNDLE_SCHEMA);

  const removedPayload = validateCompatibilityCodeBundle({ ...payload, revision: 2, patches: [] });
  const removedEnvelope = {
    ...envelope,
    payload: removedPayload,
    signature: sign(
      null,
      Buffer.from(`${COMPATIBILITY_CODE_SIGNATURE_DOMAIN}${canonicalCompatibilityCodeJson(removedPayload)}`),
      pair.privateKey,
    ).toString("base64url"),
  };
  assert.equal(installSignedCompatibilityPack(
    stateDir,
    removedEnvelope,
    { "wasm-test": publicKey },
  ).installed, true);
  assert.equal(loadActiveCompatibilityPack(stateDir).patches.length, 0);
  assert.equal(rollbackCompatibilityPack(stateDir).rolledBack, true);
  assert.equal(loadActiveCompatibilityPack(stateDir).patches.length, 1);

  const engine = new CompatibilityEngine({ updatePack: payload });
  try {
    const executionState = {};
    const result = await engine.apply("request", {
      method: "POST",
      path: "/v1/responses",
      protocol: "openai.responses",
      providerFamily: "test",
      stream: false,
    }, { input: [] }, executionState);
    assert.equal(result.document.wasm_test, "ok");
    assert.equal(result.applied[0].operations[0].operator, "wasm");
    assert.equal(executionState["wasm.setter"].seen, "ok");
  } finally {
    engine.close();
  }

  const ordered = orderCompatibilityCodePatches([
    { ...payload.patches[0], id: "third", priority: 100, before: [], after: ["second"] },
    { ...payload.patches[0], id: "first", priority: 1, before: ["second"], after: [] },
    { ...payload.patches[0], id: "second", priority: 50, before: [], after: [] },
  ]);
  assert.deepEqual(ordered.map((patch) => patch.id), ["first", "second", "third"]);
  assert.throws(() => orderCompatibilityCodePatches([
    { ...payload.patches[0], id: "a", before: [], after: ["b"] },
    { ...payload.patches[0], id: "b", before: [], after: ["a"] },
  ]), /dependency cycle/);

  const emptyBundle = validateCompatibilityCodeBundle({
    ...payload,
    revision: 2,
    patches: [],
  });
  const emptyEngine = new CompatibilityEngine({ updatePack: emptyBundle });
  try {
    const untouched = { tools: [{ type: "namespace", tools: [] }], input: [] };
    const result = await emptyEngine.apply("request", {
      method: "POST", path: "/v1/responses", protocol: "openai.responses", providerFamily: "test",
    }, untouched);
    assert.equal(result.document, untouched, "complete empty snapshot must not fall back to built-in patches");
  } finally {
    emptyEngine.close();
  }

  const passthroughPayload = validateCompatibilityCodeBundle({
    ...payload,
    revision: 3,
    patches: [{ ...payload.patches[0], required: false, failure_mode: "passthrough" }],
  });
  const failingFactory = () => ({
    async execute() { throw new Error("synthetic patch failure"); },
    close() {},
  });
  const passthroughEngine = new CompatibilityEngine({
    updatePack: passthroughPayload,
    wasmExecutorFactory: failingFactory,
  });
  try {
    const original = { input: [] };
    const result = await passthroughEngine.apply("request", {
      method: "POST", path: "/v1/responses", protocol: "openai.responses", providerFamily: "test",
    }, original);
    assert.equal(result.document, original);
    assert.equal(result.failures[0].operator, "wasm");
  } finally {
    passthroughEngine.close();
  }

  const requiredEngine = new CompatibilityEngine({
    updatePack: payload,
    wasmExecutorFactory: failingFactory,
  });
  try {
    await assert.rejects(requiredEngine.apply("request", {
      method: "POST", path: "/v1/responses", protocol: "openai.responses", providerFamily: "test",
    }, { input: [] }), (error) => error.code === "originrouter_compatibility_patch_failed");
  } finally {
    requiredEngine.close();
  }

  const domApi = compile("dom-api", `
@external("originrouter_json_v1", "object_get") declare function objectGet(h:i32,p:usize,n:i32):i32;
@external("originrouter_json_v1", "object_set") declare function objectSet(h:i32,p:usize,n:i32,v:i32):i32;
@external("originrouter_json_v1", "object_length") declare function objectLength(h:i32):i32;
@external("originrouter_json_v1", "object_key_at") declare function objectKeyAt(h:i32,i:i32):i32;
@external("originrouter_json_v1", "string_length_utf8") declare function stringLength(h:i32):i32;
@external("originrouter_json_v1", "string_read_utf8") declare function stringRead(h:i32,p:usize,n:i32):i32;
@external("originrouter_json_v1", "create_string_utf8") declare function createString(p:usize,n:i32):i32;
@external("originrouter_json_v1", "create_number") declare function createNumber(v:f64):i32;
@external("originrouter_json_v1", "number_value") declare function numberValue(h:i32):f64;
@external("originrouter_json_v1", "create_boolean") declare function createBoolean(v:i32):i32;
@external("originrouter_json_v1", "boolean_value") declare function booleanValue(h:i32):i32;
@external("originrouter_json_v1", "create_null") declare function createNull():i32;
@external("originrouter_json_v1", "create_array") declare function createArray():i32;
@external("originrouter_json_v1", "array_push") declare function arrayPush(h:i32,v:i32):i32;
@external("originrouter_json_v1", "array_get") declare function arrayGet(h:i32,i:i32):i32;
@external("originrouter_json_v1", "array_set") declare function arraySet(h:i32,i:i32,v:i32):i32;
@external("originrouter_json_v1", "array_length") declare function arrayLength(h:i32):i32;
function bytes(v:string):ArrayBuffer{return String.UTF8.encode(v,false);}
function get(o:i32,k:string):i32{const b=bytes(k);return objectGet(o,changetype<usize>(b),b.byteLength);}
function set(o:i32,k:string,v:i32):void{const b=bytes(k);objectSet(o,changetype<usize>(b),b.byteLength,v);}
export function originrouter_patch_apply(root:i32,context:i32,state:i32):i64{
  const source=get(root,"source");
  const size=stringLength(source);
  const buffer=new ArrayBuffer(size);
  stringRead(source,changetype<usize>(buffer),size);
  set(root,"copied",createString(changetype<usize>(buffer),size));
  const array=createArray();
  arrayPush(array,createNumber(1));
  arraySet(array,0,createNumber(numberValue(arrayGet(array,0))+1));
  set(root,"array",array);
  set(root,"flag",createBoolean(booleanValue(createBoolean(1))));
  set(root,"nothing",createNull());
  set(root,"key_count",createNumber(<f64>objectLength(root)));
  set(state,"first_key",objectKeyAt(root,0));
  return (<i64>1<<32)|<i64><u32>root;
}
`);
  const domExecutor = new WasmPatchExecutor(domApi);
  try {
    const result = await domExecutor.execute({ source: "你好, WASM" }, {}, {});
    assert.equal(result.document.copied, "你好, WASM");
    assert.deepEqual(result.document.array, [2]);
    assert.equal(result.document.flag, true);
    assert.equal(result.document.nothing, null);
    assert.equal(result.state.first_key, "source");
  } finally {
    domExecutor.close();
  }

  const infinite = compile("infinite", `
@external("originrouter_json_v1", "create_string_utf8")
declare function createString(pointer: usize, length: i32): i32;
export function originrouter_patch_apply(root: i32, context: i32, state: i32): i64 {
  const value = String.UTF8.encode("loop", false);
  createString(changetype<usize>(value), value.byteLength);
  while (true) {}
  return <i64><u32>root;
}
`);
  const executor = new WasmPatchExecutor(infinite, { timeoutMs: 25 });
  try {
    await assert.rejects(
      executor.execute({}, {}),
      (error) => error.code === "originrouter_wasm_patch_timeout",
    );
  } finally {
    executor.close();
  }

  const forbidden = compile("forbidden", `
@external("env", "forbidden") declare function forbidden(): void;
export function originrouter_patch_apply(root: i32, context: i32, state: i32): i64 {
  forbidden();
  return <i64><u32>root;
}
`);
  assert.throws(() => validateCompatibilityCodeBundle({
    ...payload,
    revision: 2,
    patches: [{ ...payload.patches[0], module: moduleRecord(forbidden) }],
  }), /forbidden capability/);
  assert.throws(() => validateCompatibilityCodeBundle({
    ...payload,
    revision: 4,
    patches: [{
      ...payload.patches[0],
      module: { ...payload.patches[0].module, sha256: "0".repeat(64) },
    }],
  }), /sha256 does not match/);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("compatibility WASM tests passed");
