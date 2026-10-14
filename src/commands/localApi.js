import { join } from "node:path";

import {
  DEFAULT_LOCAL_API_PORT,
  DEFAULT_RELAY_URL,
} from "../constants.js";
import {
  LOOPBACK_ADDRESSES,
  DEFAULT_BIND_ADDRESS,
  resolveBindAddress,
  resolveAllowLan,
  bindAddressConflict,
} from "../local/localApi.js";
import { loopbackDialHost } from "../local/localApiHttp.js";
import { pairingDeepLink } from "../local/localPairing.js";
import {
  ensureStateDir,
  readDaemonState,
  readLocalApiConfig,
  writeLocalApiConfig,
} from "../persistence/state.js";
import { readApiToken, rotateApiToken } from "../persistence/authToken.js";
import qrcode from "qrcode-terminal";
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
    host = loopbackDialHost(state?.localApiBindAddress || DEFAULT_BIND_ADDRESS);
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
  const bind = state.localApiBindAddress || DEFAULT_BIND_ADDRESS;
  const host = loopbackDialHost(bind);
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

// What the daemon would bind with the config as it stands.
//
// The same resolution `startDaemon` performs, so `show` reports the address in
// force rather than whatever the file happens to record. Printing the record
// was how a stale default kept looking deliberate after the default moved.
function effectiveBindAddress(config) {
  return resolveBindAddress({ config }).bindAddress;
}

// Whether the daemon would expose itself, with the config as it stands.
//
// Derived from the effective bind rather than read off the file, so the pair
// on screen is always one the daemon could actually start with. Printing the
// stored field is how a config ends up showing `bindAddress: 0.0.0.0` beside
// `allowLan: off` — a combination that is not a setting but a refusal to boot.
function effectiveAllowLan(config) {
  return resolveAllowLan({
    bindAddress: effectiveBindAddress(config),
    config,
  });
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
    console.log(`bindAddress: ${effectiveBindAddress(config)}`);
    console.log(`allowLan:    ${effectiveAllowLan(config) ? "on" : "off"}`);
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
    // Mark operator intent: on a service install the supervisor starts the
    // daemon with no flags, so this file is the only channel a chosen port has.
    if (port !== undefined) {
      patch.port = port;
      patch.portSource = "operator";
    }
    if (bindAddress) {
      patch.bindAddress = bindAddress;
      // Same marker `set-host` writes, and for the same reason: without it the
      // daemon would read this back as a record of where it landed rather than
      // as a choice, and quietly move off it on the next start.
      patch.bindAddressSource = "operator";
    }
    if (allowLan !== undefined) {
      patch.allowLan = allowLan;
      // Marks this as a decision rather than the record of a default that the
      // daemon writes on every start — see `resolveAllowLan`.
      patch.allowLanSource = "operator";
    }
    if (relayMode) patch.relayMode = relayMode;
    if (relayUrl) patch.relayUrl = relayUrl;
    if (Object.keys(patch).length === 0) {
      throw new Error("Usage: originrouter local config set [--port <p>] [--bind <addr>] [--allow-lan on|off] [--relay-mode auto|cloud|local|custom] [--relay-url <url>]");
    }
    // Refuse a combination the daemon cannot honour, here rather than at the
    // next start. The address and the consent are separate settings and can
    // contradict each other; discovering that as a service that will not come
    // up is a much worse place to find out.
    const pending = { ...readLocalApiConfig(), ...patch };
    const conflict = bindAddressConflict(
      resolveBindAddress({ config: pending }).bindAddress,
      resolveAllowLan({ config: pending }),
    );
    if (conflict) throw new Error(conflict);
    const next = writeLocalApiConfig(patch);
    console.log("Local API config updated.");
    console.log(`port:        ${next.port ?? DEFAULT_LOCAL_API_PORT}`);
    console.log(`bindAddress: ${effectiveBindAddress(next)}`);
    console.log(`allowLan:    ${effectiveAllowLan(next) ? "on" : "off"}`);
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
    console.log(`bindAddress: ${effectiveBindAddress(config)}`);
    console.log(`allowLan:    ${effectiveAllowLan(config) ? "on" : "off"}`);
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
    if (!host) throw new Error("Usage: originrouter local api set-host <address> [--allow-lan on|off]");
    const trimmed = String(host).trim();
    const allowLanFlag = parseOnOff(optionValue(args, "allow-lan"), "--allow-lan");
    const existing = readLocalApiConfig();
    const isLoopback = LOOPBACK_ADDRESSES.has(trimmed.toLowerCase());

    // Two directions, and only the widening one needs consent.
    //
    // Narrowing to loopback removes the LAN surface, so it is always allowed
    // and it withdraws the LAN consent it makes unnecessary — which means the
    // next widening has to ask again, at the moment it actually widens.
    //
    // Widening reaches past this machine, and it still needs the bearer token
    // minted: the token is what makes the rest of this API unreachable
    // without it, and an unauthenticated LAN socket is not a thing to set up
    // on the way to something else.
    const allowLan = allowLanFlag !== undefined
      ? allowLanFlag
      : (isLoopback ? false : true);
    if (!isLoopback) {
      if (!readApiToken(stateDir)) {
        throw new Error(`Refusing to bind "${trimmed}" without a bearer token. Run \`originrouter daemon\` first to mint one, then retry.`);
      }
      if (!allowLan) throw new Error(`Refusing to bind "${trimmed}" without --allow-lan on.`);
    }
    // The operator marker, or the daemon records this as its own doing and
    // the next start is free to replace it — see `resolveBindAddress`.
    writeLocalApiConfig({
      bindAddress: trimmed,
      bindAddressSource: "operator",
      allowLan,
      allowLanSource: "operator",
    });
    console.log(`bindAddress: ${trimmed}`);
    console.log(`allowLan:    ${allowLan ? "on" : "off"}`);
    console.log(`tokenSet:    ${readApiToken(stateDir) ? "yes" : "no"}`);
    console.log("Restart `originrouter daemon` for the change to take effect.");
    if (isLoopback) {
      console.log("");
      console.log("The local API will be reachable only from this machine. Phone pairing");
      console.log("over the LAN needs it bound wider again:");
      console.log(`  originrouter local api set-host ${DEFAULT_BIND_ADDRESS} --allow-lan on`);
    }
    return;
  }
  if (sub === "set-port") {
    const port = parseLocalConfigPort(rest[0]);
    if (port === undefined) throw new Error("Usage: originrouter local api set-port <int>");
    // See `local config set`: the operator marker is what makes the daemon
    // honour this port on the next start instead of drifting back to the default.
    writeLocalApiConfig({ port, portSource: "operator" });
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
    // The address is a suggestion, not a claim: the user may be on this
    // machine, on the LAN, or reaching a domain, and the App lets them edit it
    // either way. It is printed so they can see what the CLI assumed, not so
    // they have to keep it.
    const host = String(pairing?.suggested_host || "").trim();
    const port = Number(pairing?.port || 0);
    if (!pairingLine.startsWith("ORIGINROUTER_LOCAL_PAIR_V1:") || !expiresAt
        || !host || !Number.isInteger(port) || port < 1) {
      throw new Error("OriginRouter service returned invalid pairing details.");
    }
    const credentialFiles = {
      access_key: join(stateDir, "local-api.token"),
      device_identity: join(stateDir, "device.json"),
      active_endpoint: join(stateDir, "daemon.state.json"),
    };
    console.log("OriginRouter App pairing");
    console.log("Expires in 5 minutes. Single use.");
    console.log("The access key is never printed or embedded; the App redeems it over the pairing endpoint.");
    console.log("");
    // The labels are the keys as they appear inside those files, so a reader
    // grepping one of them knows where it lives without a translation table.
    console.log(`  access_key       ${credentialFiles.access_key}`);
    console.log(`  device_identity  ${credentialFiles.device_identity}`);
    console.log(`  active_endpoint  ${credentialFiles.active_endpoint}`);
    console.log("");
    console.log(`  Address  ${host}:${port}`);
    console.log("");
    console.log("App → Add direct address → pairing import, then scan:");
    console.log("");
    qrcode.generate(pairingDeepLink(pairingLine), { small: true });
    console.log("");
    console.log("Or paste the line below instead of scanning.");
    console.log(pairingLine);
    console.log("");
    console.log(`Edit the address in the App if this device does not reach the CLI at ${host}.`);
    console.log("Treat the pairing line as a credential.");
    // Only when the address cannot work. A loopback `Address` on a pairing
    // ticket is not a suggestion that might be wrong — it is the truth about
    // this daemon, and a phone scanning the code above will be refused. Saying
    // so here is the difference between a user who knows to run one command
    // and a user who concludes the App is broken.
    if (LOOPBACK_ADDRESSES.has(host.toLowerCase())) {
      console.log("");
      console.log(`This daemon is bound to ${host}, so only this machine can reach it.`);
      console.log("A phone on the same network cannot. To pair from one:");
      console.log(`  originrouter local api set-host ${DEFAULT_BIND_ADDRESS} --allow-lan on`);
      console.log("  originrouter daemon    # restart to apply");
    }
    return;
  }
  throw new Error("Usage: originrouter local api status|pair|set-host <addr>|set-port <int>");
}
