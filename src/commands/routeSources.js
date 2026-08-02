// Login-backed route sources for OriginRouter Cloud and remote CLI devices.
//
// These are intentionally separate from local `provider add`: a person can
// only create a local Provider by configuring LiteLLM. Cloud and remote route
// records are derived from the current OriginRouter login instead.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { DEFAULT_ORIGINROUTER_AI_SERVER_BASE_URL } from "../config/providerRoutes.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";
import { accessTokenFor, OAUTH_RESOURCES } from "../runtime/authContract.js";

const CONTROL_CANDIDATES = Object.freeze([
  {
    controlBaseUrl: "https://app.originrouter.com",
    chatHealthUrl: "https://chat.originrouter.com/api/v1/health",
  },
  {
    controlBaseUrl: "https://app.easytransnote.com",
    chatHealthUrl: "https://chat.easytransnote.com/api/v1/health",
  },
]);

const REQUEST_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_000;

function trimBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function fetchWithTimeout(fetchFn, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeLatency(fetchFn, url, timeoutMs) {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(fetchFn, url, { method: "GET" }, timeoutMs);
    return response.status >= 200 && response.status < 500
      ? Date.now() - startedAt
      : null;
  } catch {
    return null;
  }
}

/// Select the same branded control-plane pair as the App: both the control
/// and chat health endpoints must be reachable; the lower worst-case latency
/// wins. Explicit environment overrides always take precedence.
export async function selectControlBaseUrl({
  fetchFn = globalThis.fetch,
  env = process.env,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const override = env.ORIGINROUTER_CONTROL_BASE_URL || env.ORIGINROUTER_API_BASE_URL;
  if (override) return trimBaseUrl(override);

  const scores = await Promise.all(CONTROL_CANDIDATES.map(async (candidate) => {
    const [control, chat] = await Promise.all([
      probeLatency(fetchFn, `${candidate.controlBaseUrl}/health`, probeTimeoutMs),
      probeLatency(fetchFn, candidate.chatHealthUrl, probeTimeoutMs),
    ]);
    if (control == null || chat == null) return { candidate, score: null };
    return { candidate, score: Math.max(control, chat) };
  }));

  const viable = scores.filter((result) => result.score != null);
  if (viable.length === 0) return CONTROL_CANDIDATES[0].controlBaseUrl;
  viable.sort((a, b) => a.score - b.score);
  return viable[0].candidate.controlBaseUrl;
}

async function signedInToken({
  stateDir,
  resource,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
}) {
  const credential = await ensureFreshAccessTokenFn({ stateDir, resource });
  const token = accessTokenFor(credential, resource)?.token;
  if (!token) {
    throw new Error("OriginRouter Cloud and remote routes require `originrouter login`.");
  }
  return token;
}

async function requestJson(fetchFn, url, options = {}) {
  const response = await fetchWithTimeout(fetchFn, url, options, REQUEST_TIMEOUT_MS);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The status below is the useful, non-sensitive diagnostic.
  }
  if (!response.ok) {
    const message = payload?.message || payload?.error || `request failed (${response.status})`;
    throw new Error(String(message));
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("OriginRouter returned an invalid JSON response.");
  }
  return payload;
}

function unwrapData(payload) {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function remoteShareCatalog(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const provider = nonEmptyString(item?.provider);
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    out.push({ provider, model: nonEmptyString(item?.model) });
  }
  return out;
}

function displayOrigin(value) {
  const origin = nonEmptyString(value) || "OriginRouter";
  const normalized = origin.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "officaloriginrouter" || normalized === "officialoriginrouter"
    ? "OriginRouter Cloud"
    : origin;
}

/// Reads the exact `/ai/model` catalogue used by App Agent Control.
export async function loadCloudModels({
  stateDir,
  fetchFn = globalThis.fetch,
  env = process.env,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
} = {}) {
  const token = await signedInToken({
    stateDir,
    resource: OAUTH_RESOURCES.AI,
    ensureFreshAccessTokenFn,
  });
  const baseUrl = trimBaseUrl(
    env.ORIGINROUTER_AI_SERVER_BASE_URL || DEFAULT_ORIGINROUTER_AI_SERVER_BASE_URL
  );
  const payload = await requestJson(fetchFn, `${baseUrl}/ai/model`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ v: "coding" }),
  });
  if (payload.code !== 1) {
    throw new Error("OriginRouter Cloud model catalogue request was rejected.");
  }

  const groups = unwrapData(payload).model_list;
  if (!Array.isArray(groups)) return [];
  const seen = new Set();
  const models = [];
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.models)) continue;
    const origin = displayOrigin(group.origin_name || group.origin_key);
    for (const entry of group.models) {
      const id = nonEmptyString(entry?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, name: nonEmptyString(entry.name) || id, origin });
    }
  }
  return models;
}

/// Lists only account-authorized CLI grants. The server enforces the same
/// whitelist used by App Proxy Control, so App-session records never leak in.
export async function loadRemoteCliDevices({
  stateDir,
  fetchFn = globalThis.fetch,
  env = process.env,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  selectControlBaseUrlFn = selectControlBaseUrl,
} = {}) {
  const [token, controlBaseUrl] = await Promise.all([
    signedInToken({
      stateDir,
      resource: OAUTH_RESOURCES.CONTROL,
      ensureFreshAccessTokenFn,
    }),
    selectControlBaseUrlFn({ fetchFn, env }),
  ]);
  const payload = await requestJson(fetchFn, `${trimBaseUrl(controlBaseUrl)}/cli/v1/devices`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const devices = unwrapData(payload).devices;
  if (!Array.isArray(devices)) return [];
  return devices
    .map((device) => ({
      deviceId: nonEmptyString(device?.device_id),
      deviceName: nonEmptyString(device?.device_name),
      isSelf: device?.is_self === true,
      online: device?.online === true,
      remoteShareRunning: device?.remote_share_running === true,
      remoteShareCatalog: remoteShareCatalog(device?.remote_share_catalog),
      remoteShareE2eePolicy: nonEmptyString(device?.remote_share_e2ee_policy) || "off",
      remoteShareE2eeSupported: device?.remote_share_e2ee_supported === true,
      trustStatus: "unknown",
    }))
    .filter((device) => device.deviceId);
}

/// Builds the general account device directory. Trust comes from the existing
/// E2EE directory endpoint; failure to load that optional projection must not
/// hide otherwise authorized devices.
export async function loadCliDeviceDirectory({
  stateDir,
  fetchFn = globalThis.fetch,
  env = process.env,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  selectControlBaseUrlFn = selectControlBaseUrl,
} = {}) {
  const devices = await loadRemoteCliDevices({
    stateDir,
    fetchFn,
    env,
    ensureFreshAccessTokenFn,
    selectControlBaseUrlFn,
  });
  if (devices.length === 0) return devices;
  try {
    const [token, controlBaseUrl] = await Promise.all([
      signedInToken({
        stateDir,
        resource: OAUTH_RESOURCES.CONTROL,
        ensureFreshAccessTokenFn,
      }),
      selectControlBaseUrlFn({ fetchFn, env }),
    ]);
    const payload = await requestJson(
      fetchFn,
      `${trimBaseUrl(controlBaseUrl)}/cli/v1/device-e2ee/directory`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const identities = unwrapData(payload).identities;
    const trustByDevice = new Map(
      (Array.isArray(identities) ? identities : [])
        .map((identity) => [
          nonEmptyString(identity?.device_id),
          nonEmptyString(identity?.trust_status) || "unknown",
        ])
        .filter(([deviceId]) => deviceId),
    );
    return devices.map((device) => ({
      ...device,
      trustStatus: trustByDevice.get(device.deviceId) || "unknown",
    }));
  } catch {
    return devices;
  }
}

export function remoteRouteEligibleDevices(devices) {
  return devices.filter(
    (device) =>
      device.online &&
      device.remoteShareRunning &&
      device.remoteShareCatalog.length > 0,
  );
}

export function printCliDevices(devices, printFn = console.log) {
  if (devices.length === 0) {
    printFn("No authorized CLI devices are available for this account.");
    return;
  }
  for (const device of devices) {
    const name = device.deviceName || device.deviceId;
    const status = [
      device.isSelf ? "this device" : null,
      device.online ? "online" : "offline",
      device.trustStatus && device.trustStatus !== "unknown"
        ? device.trustStatus
        : "trust unknown",
      device.remoteShareRunning
        ? `Remote Share on · ${device.remoteShareCatalog.length} shared provider${device.remoteShareCatalog.length === 1 ? "" : "s"}`
        : "Remote Share off",
    ].filter(Boolean);
    printFn(`${name} (${device.deviceId}) · ${status.join(" · ")}`);
  }
}

export function printCloudModels(models, printFn = console.log) {
  if (models.length === 0) {
    printFn("No OriginRouter Cloud coding models are available for this account.");
    return;
  }
  for (const model of models) {
    const label = model.name === model.id ? model.id : `${model.name} (${model.id})`;
    printFn(`${label} · ${model.origin}`);
  }
}

export function printRemoteCliDevices(
  devices,
  printFn = console.log,
  { allDevices = devices } = {},
) {
  if (devices.length === 0) {
    if (allDevices.length === 0) {
      printFn("No authorized CLI devices are available for this account.");
      return;
    }
    const online = allDevices.filter((device) => device.online);
    if (online.length === 0) {
      printFn("No devices are currently available for remote model routing.");
      printFn(`${allDevices.length} authorized CLI device${allDevices.length === 1 ? " is" : "s are"} offline.`);
      return;
    }
    const sharingWithoutModels = online.filter(
      (device) => device.remoteShareRunning && device.remoteShareCatalog.length === 0,
    );
    printFn("No devices are currently sharing remote model providers.");
    if (sharingWithoutModels.length > 0) {
      printFn(`${sharingWithoutModels.length} online device${sharingWithoutModels.length === 1 ? " has" : "s have"} Remote Share enabled but no provider models are shared.`);
    } else {
      printFn(`${online.length} authorized CLI device${online.length === 1 ? " is" : "s are"} online, but Remote Share is not enabled.`);
    }
    return;
  }
  for (const device of devices) {
    const name = device.deviceName || device.deviceId;
    const count = device.remoteShareCatalog.length;
    const detail = count > 0 ? ` · ${count} shared provider${count === 1 ? "" : "s"}` : "";
    printFn(`${name} (${device.deviceId})${detail}${device.online ? "" : " · offline"}`);
  }
}

export async function chooseFromList(items, {
  label,
  formatItem,
  inputStream = input,
  outputStream = output,
} = {}) {
  if (items.length === 0) throw new Error(`No ${label || "choices"} are available.`);
  if (!inputStream.isTTY || !outputStream.isTTY) {
    throw new Error(`No interactive terminal. Use an explicit flag to select a ${label || "value"}.`);
  }
  outputStream.write(`\nSelect ${label || "an option"}:\n`);
  items.forEach((item, index) => {
    outputStream.write(`  ${index + 1}. ${formatItem ? formatItem(item) : String(item)}\n`);
  });
  const readline = createInterface({ input: inputStream, output: outputStream });
  try {
    const answer = (await readline.question("Number: ")).trim();
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      throw new Error("Selection must be one of the listed numbers.");
    }
    return items[index];
  } finally {
    readline.close();
  }
}

export async function chooseCloudModel(models, modelId, options = {}) {
  if (modelId) {
    const selected = models.find((model) => model.id === modelId);
    if (!selected) throw new Error(`Cloud model '${modelId}' is not available to this account.`);
    return selected;
  }
  return chooseFromList(models, {
    label: "an OriginRouter Cloud model",
    formatItem: (model) => model.name === model.id
      ? `${model.id} · ${model.origin}`
      : `${model.name} (${model.id}) · ${model.origin}`,
    ...options,
  });
}

export async function chooseRemoteDevice(devices, deviceId, options = {}) {
  if (deviceId) {
    const selected = devices.find((device) => device.deviceId === deviceId);
    if (!selected) throw new Error(`Device '${deviceId}' is not authorized for this account.`);
    return selected;
  }
  return chooseFromList(devices, {
    label: "an authorized remote CLI device",
    formatItem: (device) => `${device.deviceName || device.deviceId} (${device.deviceId})${device.online ? "" : " · offline"}`,
    ...options,
  });
}

export async function chooseRemoteProvider(device, providerName, options = {}) {
  const catalog = device?.remoteShareCatalog || [];
  if (providerName) {
    const selected = catalog.find((item) => item.provider === providerName);
    if (!selected) {
      throw new Error(`Provider '${providerName}' is not shared by remote device '${device.deviceId}'.`);
    }
    return selected;
  }
  return chooseFromList(catalog, {
    label: `a shared Provider on ${device.deviceName || device.deviceId}`,
    formatItem: (item) => item.model ? `${item.provider} · ${item.model}` : item.provider,
    ...options,
  });
}

export function remoteProviderName(deviceId) {
  const normalized = String(deviceId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18) || "device";
  let hash = 2166136261;
  for (const codeUnit of String(deviceId)) {
    hash ^= codeUnit.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `remote-${normalized}-${hash.toString(16)}`.slice(0, 32);
}
