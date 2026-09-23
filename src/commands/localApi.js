import { join } from "node:path";

import {
  DEFAULT_LOCAL_API_PORT,
  DEFAULT_RELAY_URL,
} from "../constants.js";
import { LOOPBACK_ADDRESSES } from "../local/localApi.js";
import {
  ensureStateDir,
  readDaemonState,
  readLocalApiConfig,
  writeLocalApiConfig,
} from "../persistence/state.js";
import { readApiToken, rotateApiToken } from "../persistence/authToken.js";
import { optionValue } from "./shared/cliArgs.js";

function resolveDaemonPort(portOverride) {
  let port = portOverride;
  if (!port) {
    try {
      const state = readDaemonState();
      if (state?.localApiPort) port = state.localApiPort;
    } catch {}
  }
  return port || null;
}

function buildApiUrl(stateDir, token, portOverride) {
  const port = resolveDaemonPort(portOverride);
  let host = "127.0.0.1";
  try {
    const state = readDaemonState();
    const bind = state?.localApiBindAddress;
    if (bind && bind !== "0.0.0.0") host = bind;
  } catch {}
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  if (!port) {
    return `http://${urlHost}:<port>/?daemon=${urlHost}:<port>&token=${token}`;
  }
  return `http://${urlHost}:${port}/?daemon=${urlHost}:${port}&token=${token}`;
}

export function remoteLocalApi() {
  const stateDir = ensureStateDir();
  const state = readDaemonState();
  const token = readApiToken(stateDir);
  if (!state?.localApiPort || !token) {
    throw new Error("OriginRouter service is not running. Run `originrouter service start` first.");
  }
  const bind = state.localApiBindAddress || "127.0.0.1";
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return { baseUrl: `http://${urlHost}:${state.localApiPort}`, token };
}

export async function remoteLocalRequest(path, { method = "GET", body } = {}) {
  const api = remoteLocalApi();
  const response = await fetch(`${api.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${api.token}`,
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `Local service request failed (${response.status})`);
    error.code = payload.reason || "REMOTE_LOCAL_API_FAILED";
    throw error;
  }
  return payload.data ?? payload;
}

function parseLocalConfigPort(raw) {
  if (raw == null || raw === "") return undefined;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`--port must be an integer in [0, 65535] (got '${raw}')`);
  }
  return parsed;
}

function parseOnOff(raw, flag) {
  if (raw == null) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${flag} must be on|off`);
}

export function handleTokenCommand(args) {
  const stateDir = ensureStateDir();
  const [action] = args;
  if (action === "rotate") {
    const token = rotateApiToken(stateDir);
    console.log("Token rotated.");
    console.log(`Token file: ${stateDir}/local-api.token`);
    console.log(`Default local API port: ${DEFAULT_LOCAL_API_PORT}`);
    console.log(`API URL: ${buildApiUrl(stateDir, token)}`);
    return;
  }
  if (action === "show" || !action) {
    const token = readApiToken(stateDir);
    if (!token) {
      console.error("No API token on disk. Run `originrouter daemon` first to mint one.");
      process.exitCode = 1;
      return;
    }
    console.log(`Token file: ${stateDir}/local-api.token`);
    console.log(`Default local API port: ${DEFAULT_LOCAL_API_PORT}`);
    console.log(`API URL: ${buildApiUrl(stateDir, token)}`);
    return;
  }
  throw new Error(`Unknown token action: ${action}`);
}

export function handleLocalConfigCommand(args) {
  const stateDir = ensureStateDir();
  const [action] = args;
  if (!action || action === "show") {
    const config = readLocalApiConfig();
    const state = readDaemonState();
    console.log(`Config file: ${stateDir}/local-api.json`);
    console.log(`Token file:  ${stateDir}/local-api.token`);
    console.log(`port:        ${config.port ?? DEFAULT_LOCAL_API_PORT}`);
    console.log(`bindAddress: ${config.bindAddress || "127.0.0.1"}`);
    console.log(`allowLan:    ${config.allowLan === true ? "on" : "off"}`);
    console.log(`relayMode:   ${config.relayMode || "auto"}`);
    console.log(`relayUrl:    ${config.relayUrl || DEFAULT_RELAY_URL}`);
    if (state?.localApiPort) {
      console.log(`running:     ${state.localApiBaseUrl || `http://127.0.0.1:${state.localApiPort}`}`);
    }
    return;
  }
  if (action === "set") {
    const port = parseLocalConfigPort(optionValue(args, "port"));
    const bindAddress = optionValue(args, "bind");
    const allowLan = parseOnOff(optionValue(args, "allow-lan"), "--allow-lan");
    const relayModeRaw = optionValue(args, "relay-mode");
    const relayUrl = optionValue(args, "relay-url");
    const relayMode = relayModeRaw ? String(relayModeRaw).trim().toLowerCase() : undefined;
    if (relayMode && !["auto", "cloud", "local", "custom"].includes(relayMode)) {
      throw new Error("--relay-mode must be auto|cloud|local|custom");
    }
    const patch = {};
    if (port !== undefined) patch.port = port;
    if (bindAddress) patch.bindAddress = bindAddress;
    if (allowLan !== undefined) patch.allowLan = allowLan;
    if (relayMode) patch.relayMode = relayMode;
    if (relayUrl) patch.relayUrl = relayUrl;
    if (Object.keys(patch).length === 0) {
      throw new Error("Usage: originrouter local config set [--port <p>] [--bind <addr>] [--allow-lan on|off] [--relay-mode auto|cloud|local|custom] [--relay-url <url>]");
    }
    const next = writeLocalApiConfig(patch);
    console.log("Local API config updated.");
    console.log(`port:        ${next.port ?? DEFAULT_LOCAL_API_PORT}`);
    console.log(`bindAddress: ${next.bindAddress || "127.0.0.1"}`);
    console.log(`allowLan:    ${next.allowLan === true ? "on" : "off"}`);
    console.log(`relayMode:   ${next.relayMode || "auto"}`);
    console.log(`relayUrl:    ${next.relayUrl || DEFAULT_RELAY_URL}`);
    console.log("Restart `originrouter daemon` for changes to take effect.");
    return;
  }
  throw new Error("Usage: originrouter local config show|set");
}

export async function handleLocalApiCommand(args) {
  const stateDir = ensureStateDir();
  const [sub, ...rest] = args;
  if (!sub || sub === "status") {
    const config = readLocalApiConfig();
    const state = readDaemonState();
    const tokenSet = Boolean(readApiToken(stateDir));
    console.log(`Config file: ${stateDir}/local-api.json`);
    console.log(`port:        ${config.port ?? DEFAULT_LOCAL_API_PORT}`);
    console.log(`bindAddress: ${config.bindAddress || "127.0.0.1"}`);
    console.log(`allowLan:    ${config.allowLan === true ? "on" : "off"}`);
    console.log(`tokenSet:    ${tokenSet ? "yes" : "no"}`);
    if (state?.localApiPort) {
      console.log(`running:     ${state.localApiBaseUrl || `http://127.0.0.1:${state.localApiPort}`}`);
    } else {
      console.log("running:     no");
    }
    return;
  }
  if (sub === "set-host") {
    const host = rest[0];
    if (!host) throw new Error("Usage: originrouter local api set-host <address> [--allow-lan on]");
    const trimmed = String(host).trim();
    const allowLanFlag = parseOnOff(optionValue(args, "allow-lan"), "--allow-lan");
    const existing = readLocalApiConfig();
    const allowLan = allowLanFlag !== undefined ? allowLanFlag : (existing.allowLan === true);
    const isLoopback = LOOPBACK_ADDRESSES.has(trimmed.toLowerCase());
    if (!isLoopback) {
      if (!readApiToken(stateDir)) {
        throw new Error(`Refusing to bind "${trimmed}" without a bearer token. Run \`originrouter daemon\` first to mint one, then retry.`);
      }
      if (!allowLan) throw new Error(`Refusing to bind "${trimmed}" without --allow-lan on.`);
    }
    writeLocalApiConfig({ bindAddress: trimmed, allowLan });
    console.log(`bindAddress: ${trimmed}`);
    console.log(`tokenSet:    ${readApiToken(stateDir) ? "yes" : "no"}`);
    console.log("Restart `originrouter daemon` for the change to take effect.");
    return;
  }
  if (sub === "set-port") {
    const port = parseLocalConfigPort(rest[0]);
    if (port === undefined) throw new Error("Usage: originrouter local api set-port <int>");
    writeLocalApiConfig({ port });
    const existingState = readDaemonState();
    console.log(`port: ${port}`);
    if (existingState?.localApiPort && existingState.localApiPort !== port) {
      console.log(`WARNING: daemon is currently bound to port ${existingState.localApiPort}. Restart \`originrouter daemon\` to apply.`);
    } else {
      console.log("Restart `originrouter daemon` for the change to take effect.");
    }
    return;
  }
  if (sub === "pair" || sub === "connect") {
    const pairing = await remoteLocalRequest("/local/pair/tickets", { method: "POST", body: {} });
    const pairingLine = String(pairing?.pairing_line || "").trim();
    const expiresAt = String(pairing?.expires_at || "").trim();
    if (!pairingLine.startsWith("ORIGINROUTER_LOCAL_PAIR_V1:") || !expiresAt) {
      throw new Error("OriginRouter service returned invalid pairing details.");
    }
    const credentialFiles = {
      access_key: join(stateDir, "local-api.token"),
      device_identity: join(stateDir, "device.json"),
      active_endpoint: join(stateDir, "daemon.state.json"),
    };
    if (args.includes("--json")) {
      console.log(JSON.stringify({ version: 1, pairing_line: pairingLine, expires_at: expiresAt, credential_files: credentialFiles }, null, 2));
      return;
    }
    console.log("OriginRouter App pairing");
    console.log("For safety, the access key is not printed or embedded in the pairing line.");
    console.log("This pairing request expires in 5 minutes and can be used by one App only.");
    console.log("They are stored locally at:");
    console.log(`Access key:      ${credentialFiles.access_key}`);
    console.log(`Device identity: ${credentialFiles.device_identity}`);
    console.log(`Active endpoint: ${credentialFiles.active_endpoint}`);
    console.log("");
    console.log("Copy the pairing line below and paste it into Add direct address > CLI pairing:");
    console.log(pairingLine);
    console.log("");
    console.log("The pairing line grants short-lived access to retrieve the key. Keep it private.");
    return;
  }
  throw new Error("Usage: originrouter local api status|pair|set-host <addr>|set-port <int>");
}
