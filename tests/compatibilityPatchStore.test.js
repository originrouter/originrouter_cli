import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMPATIBILITY_PACK_SCHEMA,
  COMPATIBILITY_SIGNATURE_DOMAIN,
  COMPATIBILITY_SIGNED_ENVELOPE,
  canonicalCompatibilityJson,
} from "../src/compatibility/patchPack.js";
import {
  installSignedCompatibilityPack,
  loadActiveCompatibilityPack,
  readCompatibilityPatchPreferences,
  rollbackCompatibilityPack,
  setCompatibilityPatchEnabled,
} from "../src/compatibility/patchStore.js";
import { compatibilityStatus } from "../src/compatibility/status.js";
import { checkCompatibilityPack, refreshCompatibilityPack } from "../src/compatibility/updater.js";

function signedEnvelope(pair, revision, version = String(revision)) {
  const payload = {
    schema: COMPATIBILITY_PACK_SCHEMA,
    pack_id: "remote-test",
    revision,
    min_engine_version: "1.0.0",
    patches: [{
      id: "remote-test-patch",
      version,
      phase: "request",
      priority: 5,
      match: { paths: ["/v1/responses"] },
      operations: [{ operator: "flatten_namespace_tools", options: {} }],
    }],
  };
  return {
    schema: COMPATIBILITY_SIGNED_ENVELOPE,
    key_id: "test",
    algorithm: "Ed25519",
    payload,
    signature: sign(
      null,
      Buffer.from(`${COMPATIBILITY_SIGNATURE_DOMAIN}${canonicalCompatibilityJson(payload)}`),
      pair.privateKey,
    ).toString("base64url"),
  };
}

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-compatibility-store-"));
const pair = generateKeyPairSync("ed25519");
const trustedKeys = { test: pair.publicKey.export({ type: "spki", format: "pem" }) };

try {
  const first = installSignedCompatibilityPack(stateDir, signedEnvelope(pair, 1), trustedKeys);
  assert.equal(first.installed, true);
  assert.equal(loadActiveCompatibilityPack(stateDir).revision, 1);

  const stale = installSignedCompatibilityPack(stateDir, signedEnvelope(pair, 1), trustedKeys);
  assert.equal(stale.installed, false);
  assert.equal(stale.reason, "not_newer");

  const second = installSignedCompatibilityPack(stateDir, signedEnvelope(pair, 2), trustedKeys);
  assert.equal(second.installed, true);
  assert.equal(loadActiveCompatibilityPack(stateDir).revision, 2);
  const rollback = rollbackCompatibilityPack(stateDir);
  assert.equal(rollback.rolledBack, true);
  assert.equal(loadActiveCompatibilityPack(stateDir).revision, 1);

  const envelope = signedEnvelope(pair, 3);
  const refresh = await refreshCompatibilityPack({
    stateDir,
    url: "https://updates.example/patches",
    trustedKeys,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === "etag" ? '"revision-3"' : null },
      text: async () => JSON.stringify(envelope),
    }),
  });
  assert.equal(refresh.installed, true);
  assert.equal(loadActiveCompatibilityPack(stateDir).revision, 3);
  const metadata = JSON.parse(readFileSync(join(stateDir, "compatibility", "update-metadata.json"), "utf8"));
  assert.equal(metadata.etag, '"revision-3"');

  setCompatibilityPatchEnabled(stateDir, "remote-test-patch", false);
  assert.deepEqual(
    readCompatibilityPatchPreferences(stateDir).disabled_patch_ids,
    ["remote-test-patch"],
  );
  let status = compatibilityStatus(stateDir);
  assert.equal(status.enabled_patch_count, 0);
  assert.equal(status.patches[0].enabled, false);
  setCompatibilityPatchEnabled(stateDir, "remote-test-patch", true);
  status = compatibilityStatus(stateDir);
  assert.equal(status.enabled_patch_count, 1);
  assert.equal(status.patches[0].enabled, true);

  const check = await checkCompatibilityPack({
    stateDir,
    url: "https://updates.example/patches",
    trustedKeys,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name === "etag" ? '"revision-4"' : null },
      text: async () => JSON.stringify(signedEnvelope(pair, 4)),
    }),
  });
  assert.equal(check.update_available, true);
  assert.equal(check.latest_revision, 4);
  assert.equal(loadActiveCompatibilityPack(stateDir).revision, 3, "check must not activate the bundle");
  const checkedMetadata = JSON.parse(readFileSync(join(stateDir, "compatibility", "update-metadata.json"), "utf8"));
  assert.equal(checkedMetadata.latest_revision, 4);
  assert.equal(checkedMetadata.revision, 3);
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("compatibilityPatchStore tests passed");
