#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import net from "node:net";

import { CompatibilityEngine } from "./engine.js";
import { createCompatibilityGateway } from "./gateway.js";
import {
  compatibilityPatchPreferencesPath,
  loadActiveCompatibilityPack,
  readCompatibilityPatchPreferences,
} from "./patchStore.js";

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || argv[index + 1] == null) throw new Error(`invalid argument '${key || ""}'`);
    result[key.slice(2)] = argv[index + 1];
  }
  return result;
}

function reservePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(url, child, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function main() {
  const options = args(process.argv.slice(2));
  const host = options.host || "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("compatibility gateway only supports 127.0.0.1");
  const publicPort = Number(options.port);
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) throw new Error("invalid public port");
  if (!options.litellm || !options.config || !options["state-dir"] || !options["route-map"]) {
    throw new Error("litellm, config, state-dir and route-map are required");
  }
  const internalPort = await reservePort(host);
  const litellm = spawn(options.litellm, [
    "--config", options.config,
    "--port", String(internalPort),
    "--host", host,
  ], { stdio: "inherit", env: process.env });
  let gateway = null;
  let activePackPath = null;
  let preferencesPath = null;
  let reloadEngine = null;
  let engine = null;
  const retiredEngines = new Set();
  const retireEngine = (previous) => {
    if (!previous || previous === engine) return;
    retiredEngines.add(previous);
  };
  try {
    const healthy = await waitForHealth(`http://${host}:${internalPort}/health/liveliness`, litellm);
    if (!healthy) throw new Error("internal LiteLLM did not become healthy");
    const routeMap = JSON.parse(readFileSync(options["route-map"], "utf8"));
    const updatePack = loadActiveCompatibilityPack(options["state-dir"]);
    const preferences = readCompatibilityPatchPreferences(options["state-dir"]);
    engine = new CompatibilityEngine({
      updatePack,
      disabledPatchIds: preferences.disabled_patch_ids,
    });
    activePackPath = join(options["state-dir"], "compatibility", "active-pack.json");
    preferencesPath = compatibilityPatchPreferencesPath(options["state-dir"]);
    reloadEngine = () => {
      try {
        const previous = engine;
        const nextPreferences = readCompatibilityPatchPreferences(options["state-dir"]);
        const next = new CompatibilityEngine({
          updatePack: loadActiveCompatibilityPack(options["state-dir"]),
          disabledPatchIds: nextPreferences.disabled_patch_ids,
        });
        engine = next;
        retireEngine(previous);
        console.log("[compatibility-gateway] activated updated compatibility pack");
      } catch (error) {
        console.error(`[compatibility-gateway] keeping previous patch pack: ${error.message}`);
      }
    };
    watchFile(activePackPath, { interval: 5000, persistent: false }, reloadEngine);
    watchFile(preferencesPath, { interval: 500, persistent: false }, reloadEngine);
    gateway = createCompatibilityGateway({
      upstreamBaseUrl: `http://${host}:${internalPort}`,
      routeMap,
      engineProvider: () => engine,
    });
    await new Promise((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(publicPort, host, resolve);
    });
  } catch (error) {
    if (activePackPath && reloadEngine) unwatchFile(activePackPath, reloadEngine);
    if (preferencesPath && reloadEngine) unwatchFile(preferencesPath, reloadEngine);
    if (litellm.exitCode == null) litellm.kill("SIGTERM");
    throw error;
  }
  let closing = false;
  const close = async (code = 0) => {
    if (closing) return;
    closing = true;
    if (activePackPath && reloadEngine) unwatchFile(activePackPath, reloadEngine);
    if (preferencesPath && reloadEngine) unwatchFile(preferencesPath, reloadEngine);
    if (gateway) await new Promise((resolve) => gateway.close(resolve));
    engine?.close?.();
    for (const retired of retiredEngines) retired.close?.();
    retiredEngines.clear();
    if (litellm.exitCode == null) litellm.kill("SIGTERM");
    setTimeout(() => process.exit(code), 100).unref();
  };
  process.on("SIGTERM", () => void close(0));
  process.on("SIGINT", () => void close(0));
  litellm.on("exit", (code, signal) => {
    if (!closing) void close(code === 0 && !signal ? 0 : 1);
  });
}

main().catch((error) => {
  console.error(`[compatibility-gateway] ${error.stack || error.message}`);
  process.exitCode = 1;
});
