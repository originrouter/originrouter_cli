import {
  assertCompatibilityEngineRange,
  installSignedCompatibilityPack,
  loadActiveCompatibilityPack,
  readCompatibilityUpdateMetadata,
  verifySignedCompatibilityArtifact,
  writeCompatibilityUpdateMetadata,
} from "./patchStore.js";
import { trustedCompatibilityKeys } from "./trustedKeys.js";

export const DEFAULT_COMPATIBILITY_PACK_URL =
  "https://app.easytransnote.com/public/v1/compatibility/patches/latest";
const MAX_PACK_BYTES = 8 * 1024 * 1024;

async function readLimitedBody(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PACK_BYTES) {
    throw new Error("compatibility pack exceeds the 8 MiB limit");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_PACK_BYTES) {
      throw new Error("compatibility pack exceeds the 8 MiB limit");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PACK_BYTES) {
        await reader.cancel();
        throw new Error("compatibility pack exceeds the 8 MiB limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function requestCompatibilityPack({
  stateDir,
  install,
  url = process.env.ORIGINROUTER_COMPATIBILITY_PACK_URL || DEFAULT_COMPATIBILITY_PACK_URL,
  trustedKeys = trustedCompatibilityKeys(),
  fetchFn = globalThis.fetch,
  now = new Date(),
} = {}) {
  if (!stateDir) throw new Error("stateDir is required");
  if (!trustedKeys || Object.keys(trustedKeys).length === 0) {
    return { ok: false, skipped: true, reason: "no_trusted_keys" };
  }
  const previousMetadata = readCompatibilityUpdateMetadata(stateDir);
  const activeBeforeRequest = loadActiveCompatibilityPack(stateDir);
  const headers = { Accept: "application/json" };
  const conditionalEtag = install
    ? (Number(previousMetadata.revision) === Number(activeBeforeRequest?.revision)
      ? (previousMetadata.installed_etag || previousMetadata.etag)
      : null)
    : previousMetadata.latest_etag;
  if (conditionalEtag) headers["If-None-Match"] = conditionalEtag;
  const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (response.status === 304) {
    const active = loadActiveCompatibilityPack(stateDir);
    const latestRevision = Number(previousMetadata.latest_revision || active?.revision || 0) || null;
    writeCompatibilityUpdateMetadata(stateDir, {
      ...previousMetadata,
      checked_at: now.toISOString(),
      last_status: 304,
      update_available: Boolean(latestRevision && (!active || latestRevision > active.revision)),
    });
    return {
      ok: true,
      installed: false,
      reason: "not_modified",
      pack: active,
      latest_revision: latestRevision,
      update_available: Boolean(latestRevision && (!active || latestRevision > active.revision)),
    };
  }
  if (!response.ok) throw new Error(`compatibility pack request returned HTTP ${response.status}`);
  const text = await readLimitedBody(response);
  const envelope = JSON.parse(text);
  const verified = verifySignedCompatibilityArtifact(envelope, trustedKeys);
  assertCompatibilityEngineRange(verified);
  const active = loadActiveCompatibilityPack(stateDir);
  const updateAvailable = !active || verified.revision > active.revision;
  const result = install
    ? installSignedCompatibilityPack(stateDir, envelope, trustedKeys)
    : { installed: false, reason: updateAvailable ? "update_available" : "not_newer", pack: active };
  const responseEtag = response.headers?.get?.("etag") || null;
  writeCompatibilityUpdateMetadata(stateDir, {
    ...previousMetadata,
    checked_at: now.toISOString(),
    last_status: response.status,
    latest_etag: responseEtag,
    latest_pack_id: verified.pack_id || verified.bundle_id || null,
    latest_revision: verified.revision,
    update_available: install ? false : updateAvailable,
    ...(install ? {
      etag: responseEtag,
      installed_etag: responseEtag,
      pack_id: result.pack?.pack_id || result.pack?.bundle_id || null,
      revision: result.pack?.revision || null,
    } : {}),
  });
  return {
    ok: true,
    ...result,
    latest_pack: verified,
    latest_revision: verified.revision,
    update_available: install ? false : updateAvailable,
  };
}

export async function checkCompatibilityPack(options = {}) {
  return requestCompatibilityPack({ ...options, install: false });
}

export async function refreshCompatibilityPack(options = {}) {
  return requestCompatibilityPack({ ...options, install: true });
}
