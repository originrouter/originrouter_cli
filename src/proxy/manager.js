// Stage 4: ProxyManager — owns the LiteLLM proxy process lifecycle.
//
// Responsibilities:
//   - install: create venv + pip install litellm[proxy]==<version>
//   - start: spawn venv/bin/litellm, write proxy.state.json
//   - stop: SIGTERM the running process, clear state
//   - status: read state + check pid alive + poll /health/liveliness
//   - restart: stop + start
//
// The manager starts one detached OriginRouter Compatibility Gateway process.
// That child owns the private LiteLLM process and exposes the stable public
// loopback port. Keeping HTTP transformation logic in the child still leaves
// this lifecycle manager testable with a mocked child_process spawn.
//
// Bind safety is enforced at start time: if a caller tries to start with
// host != 127.0.0.1 the manager throws before spawn.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LITELLM_PACKAGE,
  isInstalled,
  litellmBinaryPath,
  pipBinaryPath,
  pythonBinaryPath,
  renderLitellmConfigYaml,
  renderLitellmProvidersConfigYaml,
  renderLitellmRoutesConfigYaml,
  runtimeDir,
  venvDir,
} from "./litellm.js";
import {
  ROUTE_AGENTS,
  ROUTE_DEFS,
  effectiveAgentRoutes,
  getAllRoutes,
  hashRoutes,
} from "../config/routes.js";
import { readConfig, readProxyState, writeProxyState, clearProxyState } from "../persistence/state.js";
import { buildCompatibilityRouteMap } from "../compatibility/routeMap.js";

// The public port is opened only after the child Gateway has started and
// health-checked its private LiteLLM process. Allow enough time for both
// layers on slower first boots.
const HEALTH_POLL_TIMEOUT_MS = 35_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const PROXY_HOST = "127.0.0.1";
const COMPATIBILITY_GATEWAY_PROCESS = fileURLToPath(
  new URL("../compatibility/gatewayProcess.js", import.meta.url),
);

// Stage 6: signals that count as a "crash" for UI reporting. SIGTERM is
// graceful (we sent it). The others are unexpected deaths.
const CRASH_SIGNALS = new Set([
  "SIGKILL", "SIGSEGV", "SIGABRT", "SIGBUS", "SIGILL",
]);

export class ProxyManager {
  constructor({
    stateDir,
    stateKey = "proxy",
    pythonCommand = "python3",
    logger = console,
    spawnFn = spawn,
    fetchFn = globalThis.fetch,
  }) {
    this.stateDir = stateDir;
    this.stateKey = stateKey;
    this.pythonCommand = pythonCommand;
    this.logger = logger;
    this.spawnFn = spawnFn;
    this.fetchFn = fetchFn;
    this.activeChild = null; // tracked so `stop()` can SIGTERM even if state is stale
  }

  _readState() {
    return readProxyState(this.stateKey);
  }

  _writeState(state) {
    return writeProxyState(state, this.stateKey);
  }

  _clearState() {
    return clearProxyState(this.stateKey);
  }

  _configDir() {
    return join(this.stateDir, `${this.stateKey}.state.d`);
  }

  _logPrefix() {
    return this.stateKey === "proxy" ? "litellm" : this.stateKey;
  }

  _writeCompatibilityRouteMap(configDir, name, input) {
    const routeMapPath = join(configDir, `compatibility-routes-${name}.json`);
    writeFileSync(routeMapPath, `${JSON.stringify(buildCompatibilityRouteMap(input))}\n`, { mode: 0o600 });
    return routeMapPath;
  }

  _gatewayArgs({ litellm, configPath, routeMapPath, port }) {
    return [
      COMPATIBILITY_GATEWAY_PROCESS,
      "--litellm", litellm,
      "--config", configPath,
      "--route-map", routeMapPath,
      "--state-dir", this.stateDir,
      "--port", String(port),
      "--host", PROXY_HOST,
    ];
  }

  // ----------------------------------------------------------------
  // install
  // ----------------------------------------------------------------

  async install({ version = LITELLM_PACKAGE.match(/==(.+)$/)[1], force = false } = {}) {
    const venv = venvDir(this.stateDir, version);
    const py = pythonBinaryPath(this.stateDir, version);
    if (!force && existsSync(py)) {
      return { ok: true, version, pythonPath: py, alreadyInstalled: true };
    }

    mkdirSync(dirname(venv), { recursive: true });

    // Step 1: python3 -m venv <venv>. Idempotent only if --force was given.
    await this._runCommand(this.pythonCommand, ["-m", "venv", venv]);

    // Step 2: <venv>/bin/pip install "litellm[proxy]==<version>". We stream
    // the pip output so users see real progress instead of silence.
    const pip = pipBinaryPath(this.stateDir, version);
    const pkg = `litellm[proxy]==${version}`;
    await this._runCommand(pip, ["install", pkg], { streamOutput: true });

    return { ok: true, version, pythonPath: py, alreadyInstalled: false };
  }

  // ----------------------------------------------------------------
  // start
  // ----------------------------------------------------------------

  async start({ providerName, providerNames, mode = "route", version = LITELLM_PACKAGE.match(/==(.+)$/)[1], port = 0 } = {}) {
    if (!isInstalled(this.stateDir, version)) {
      return { ok: false, error: `LiteLLM not installed. Run \`originrouter proxy install\` first.` };
    }
    if (port === 0) {
      return { ok: false, error: `proxy start requires an explicit --port; auto-port (0) is not yet supported. Pick a free port (e.g. 40123).` };
    }

    const config = readConfig();

    // Stage 7.5: mode dispatch. Default is "route" (new in 7.5). Legacy
    // "provider" mode is kept for debug / single-provider boot.
    if (mode === "route") {
      // Stage 8.0: accept a route from any configured agent. The proxy
      // YAML is rendered from all configured aliases (Claude and/or Codex).
      const allRoutes = getAllRoutes(config);
      const hasAny = ROUTE_AGENTS.some((agent) => {
        const slots = ROUTE_DEFS[agent].slots;
        return slots.some((slot) => allRoutes[agent][slot]);
      });
      if (!hasAny) {
        return {
          ok: false,
          error: `no routes configured. Set claude.main or codex.main first.`,
        };
      }
      const providers = config.providers || {};
      return await this._startRouteInner({ version, port, allRoutes, providers });
    }

    if (mode === "share") {
      const selectedNames = [...new Set(
        (Array.isArray(providerNames) ? providerNames : [])
          .map((name) => String(name || "").trim())
          .filter(Boolean),
      )];
      if (selectedNames.length === 0) {
        return { ok: false, error: "remote share requires at least one local LiteLLM provider" };
      }
      const configuredProviders = config.providers || {};
      const selectedProviders = [];
      for (const name of selectedNames) {
        const provider = configuredProviders[name];
        if (!provider) {
          return { ok: false, error: `unknown provider '${name}'. Run \`originrouter provider list\`.` };
        }
        const providerIsLiteLlm = provider.type === "openai-compatible"
          || provider.type === "litellm"
          || (provider.type === "proxy" && provider.engine === "litellm");
        if (!providerIsLiteLlm) {
          return {
            ok: false,
            error: `provider '${name}' is not a local LiteLLM provider and cannot be shared`,
          };
        }
        selectedProviders.push(provider.type === "openai-compatible"
          ? { ...provider, type: "litellm", litellmProvider: "custom_openai" }
          : provider);
      }

      while (this._startLock) await this._startLock;
      let release;
      this._startLock = new Promise((resolve) => { release = resolve; });
      try {
        return await this._startInner({
          providerNames: selectedNames,
          providers: selectedProviders,
          mode: "share",
          version,
          port,
        });
      } finally {
        this._startLock = null;
        release();
      }
    }

    // mode === "provider" — legacy path
    const provider = (config.providers || {})[providerName];
    if (!provider) {
      return { ok: false, error: `unknown provider '${providerName}'. Run \`originrouter provider list\`.` };
    }
    const providerIsLiteLlm = provider.type === "openai-compatible"
      || provider.type === "litellm"
      || (provider.type === "proxy" && provider.engine === "litellm");
    if (!providerIsLiteLlm) {
      return {
        ok: false,
        error: `provider '${providerName}' is type='${provider.type}'. The proxy only routes type='litellm' providers (and the legacy type='openai-compatible' alias). type='anthropic' is the direct path — it does not run through LiteLLM.`,
      };
    }

    // Stage 6: per-instance start lock. Two parallel start() calls (e.g. two
    // browser tabs both clicking Start) can both pass the "already running"
    // check before either writes state.json. Serialize them.
    while (this._startLock) {
      await this._startLock;
    }
    let release;
    this._startLock = new Promise((r) => { release = r; });
    try {
      return await this._startInner({ providerName, version, port, provider, mode: "provider" });
    } finally {
      this._startLock = null;
      release();
    }
  }

  async _startInner({ providerName, providerNames = [], version, port, provider, providers = [], mode = "provider" }) {
    // Reconcile stale state FIRST. status() self-heals if the recorded pid
    // is dead (clears the state file). After this call, `fresh.state ===
    // "running"` only when there's a real, live process.
    const fresh = await this.status();
    if (fresh.state === "running") {
      return {
        ok: false,
        error: `proxy already running on port ${fresh.port} (pid ${fresh.pid}). Stop it before starting another configuration.`,
      };
    }


    // Write the LiteLLM config.yaml so the proxy knows which provider to route.
    // Legacy type=openai-compatible records project to litellm/custom_openai
    // before rendering so the renderer sees a uniform input shape. The disk
    // record is NOT modified here; the migration happens on next PUT.
    const configDir = this._configDir();
    mkdirSync(configDir, { recursive: true });
    const configPath = join(
      configDir,
      mode === "share" ? "config-share.yaml" : `config-${providerName}.yaml`,
    );
    if (mode === "share") {
      writeFileSync(configPath, renderLitellmProvidersConfigYaml(providers), { mode: 0o600 });
    } else {
      const forRender = provider.type === "openai-compatible"
        ? { ...provider, type: "litellm", litellmProvider: "custom_openai" }
        : provider;
      writeFileSync(configPath, renderLitellmConfigYaml(forRender), { mode: 0o600 });
    }
    const routeMapProviders = mode === "share"
      ? Object.fromEntries(providers.map((item) => [item.name, item]))
      : { [providerName]: provider };
    const routeMapPath = this._writeCompatibilityRouteMap(
      configDir,
      mode === "share" ? "share" : `provider-${providerName}`,
      {
        config: { providers: routeMapProviders },
        mode,
        providerName,
        providerNames,
        litellmVersion: version,
      },
    );

    // Bind safety: only loopback.
    if (PROXY_HOST !== "127.0.0.1") {
      // Hard-coded; this branch is unreachable in production. The check
      // exists so a future refactor that pulls the host from config can't
      // accidentally open the proxy to the LAN.
      return { ok: false, error: `proxy host must be 127.0.0.1 (got ${PROXY_HOST})` };
    }

    // Capture stdout/stderr to a per-proxy log file so failures are inspectable.
    const logDir = join(this.stateDir, "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `${this._logPrefix()}-${Date.now()}.log`);
    const outFd = openSync(logPath, "a", 0o600);
    const errFd = openSync(logPath, "a", 0o600);

    const litellm = litellmBinaryPath(this.stateDir, version);
    const args = this._gatewayArgs({ litellm, configPath, routeMapPath, port });

    const child = this.spawnFn(process.execPath, args, {
      stdio: ["ignore", outFd, errFd],
      detached: true,
    });
    try { closeSync(outFd); } catch {}
    try { closeSync(errFd); } catch {}
    child.unref?.();
    this.activeChild = child;

    child.on("exit", (code, signal) => {
      this.logger.log(`[proxy] process exited code=${code} signal=${signal}`);
      this.activeChild = null;
      // Stage 6: differentiate crash from graceful stop. We persist the
      // last-exit reason into proxy.state.json (in place of clearing it
      // immediately) so the next status() call can surface it to the UI.
      // The state file gets cleared on the next status() reconcile pass.
      const cur = this._readState();
      if (cur && cur.pid === child.pid) {
        const isCrash = (signal && CRASH_SIGNALS.has(signal))
          || (code != null && code !== 0);
        const reason = isCrash ? "crashed" : "stopped";
        this._writeState({
          ...cur,
          state: "stopped",
          lastExitReason: reason,
          lastExitCode: code,
          lastExitSignal: signal,
          lastExitAt: new Date().toISOString(),
        });
      }
    });

    // Wait for the bound port to be allocated. node's spawn returns a pid
    // immediately but the OS-assigned port isn't visible until the child
    // binds. We don't currently pipe stdout in a parseable way, so we use
    // a tight loop that polls the health endpoint AND probes a list of
    // candidate ports. The simpler approach: bind to a fixed port and let
    // the caller choose. For Stage 4 v1, port=0 is supported but we wait
    // on the /health/liveliness endpoint and rely on the manager to know
    // the port from the child's bound socket — which we can't observe.
    //
    // Compromise: poll a short loop and check any reachable port the proxy
    // might have grabbed. If port !== 0 we just poll that port; otherwise
    // we give up on auto-port and require the caller to pass a port.
    //
    // Wait for the proxy to become healthy.
    const healthUrl = `http://${PROXY_HOST}:${port}/health/liveliness`;
    const healthy = await this._waitForHealth(healthUrl);
    if (!healthy) {
      child.kill("SIGTERM");
      this._clearState();
      return {
        ok: false,
        error: `proxy failed to become healthy on ${healthUrl} within ${HEALTH_POLL_TIMEOUT_MS}ms. Check ${logPath}.`,
        logPath,
      };
    }

    // Persist state.
    this._writeState({
      version_pinned: version,
      state: "running",
      pid: child.pid,
      port,
      host: PROXY_HOST,
      mode,
      provider: mode === "provider" ? providerName : null,
      providers: mode === "share" ? providerNames : null,
      startedAt: new Date().toISOString(),
      configPath,
      routeMapPath,
      logPath,
    });

    return {
      ok: true,
      state: "running",
      port,
      pid: child.pid,
      mode,
      provider: mode === "provider" ? providerName : null,
      providers: mode === "share" ? providerNames : null,
      version,
      configPath,
      routeMapPath,
      logPath,
    };
  }

  // ----------------------------------------------------------------
  // stop
  // ----------------------------------------------------------------

  // Stage 7.5: start in route mode. Mirrors _startInner but uses the
  // routes-driven renderer and writes mode/routesHash/aliases into
  // proxy.state.json.
  async _startRouteInner({ version, port, allRoutes, providers }) {
    while (this._startLock) {
      await this._startLock;
    }
    let release;
    this._startLock = new Promise((r) => { release = r; });
    try {
      const fresh = await this.status();
      if (fresh.state === "running") {
        return {
          ok: false,
          error: `proxy already running on port ${fresh.port} (pid ${fresh.pid}, provider ${fresh.currentProvider}). Run \`originrouter proxy stop\` first.`,
        };
      }

      let yaml;
      try {
        // Stage 8.0: render all configured agents (Claude and/or Codex).
        // effectiveAgentRoutes (per-agent) drives the renderer; the hash
        // is computed from the same all-agent shape so renderer + hash
        // agree on what "the routes" are.
        yaml = renderLitellmRoutesConfigYaml(allRoutes, providers);
      } catch (err) {
        return { ok: false, error: `rendering routes YAML failed: ${err.message}` };
      }

      const routesHash = hashRoutes(allRoutes);
      const configDir = this._configDir();
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, `config-routes-${routesHash}.yaml`);
      writeFileSync(configPath, yaml, { mode: 0o600 });
      const routeMapPath = this._writeCompatibilityRouteMap(
        configDir,
        `routes-${routesHash}`,
        {
          config: { providers, routes: allRoutes },
          mode: "route",
          litellmVersion: version,
        },
      );

      if (PROXY_HOST !== "127.0.0.1") {
        return { ok: false, error: `proxy host must be 127.0.0.1 (got ${PROXY_HOST})` };
      }

      const logDir = join(this.stateDir, "logs");
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, `${this._logPrefix()}-${Date.now()}.log`);
      const outFd = openSync(logPath, "a", 0o600);
      const errFd = openSync(logPath, "a", 0o600);

      const litellm = litellmBinaryPath(this.stateDir, version);
      const args = this._gatewayArgs({ litellm, configPath, routeMapPath, port });

      const child = this.spawnFn(process.execPath, args, {
        stdio: ["ignore", outFd, errFd],
        detached: true,
      });
      try { closeSync(outFd); } catch {}
      try { closeSync(errFd); } catch {}
      child.unref?.();
      this.activeChild = child;

      child.on("exit", (code, signal) => {
        this.logger.log(`[proxy] process exited code=${code} signal=${signal}`);
        this.activeChild = null;
        const cur = this._readState();
        if (cur && cur.pid === child.pid) {
          const isCrash = (signal && CRASH_SIGNALS.has(signal))
            || (code != null && code !== 0);
          const reason = isCrash ? "crashed" : "stopped";
          this._writeState({
            ...cur,
            state: "stopped",
            lastExitReason: reason,
            lastExitCode: code,
            lastExitSignal: signal,
            lastExitAt: new Date().toISOString(),
          });
        }
      });

      const healthUrl = `http://${PROXY_HOST}:${port}/health/liveliness`;
      const healthy = await this._waitForHealth(healthUrl);
      if (!healthy) {
        child.kill("SIGTERM");
        this._clearState();
        return {
          ok: false,
          error: `proxy failed to become healthy on ${healthUrl} within ${HEALTH_POLL_TIMEOUT_MS}ms. Check ${logPath}.`,
          logPath,
        };
      }

      const aliases = [];
      for (const agent of ROUTE_AGENTS) {
        const eff = effectiveAgentRoutes(agent, allRoutes[agent] || {});
        for (const slot of ROUTE_DEFS[agent].slots) {
          if (eff[slot]) aliases.push(ROUTE_DEFS[agent].aliases[slot]);
        }
      }

      this._writeState({
        version_pinned: version,
        state: "running",
        pid: child.pid,
        port,
        host: PROXY_HOST,
        mode: "route",
        routesHash,
        aliases,
        provider: null,
        startedAt: new Date().toISOString(),
        configPath,
        routeMapPath,
        logPath,
      });

      return {
        ok: true,
        state: "running",
        port,
        pid: child.pid,
        mode: "route",
        routesHash,
        aliases,
        configPath,
        routeMapPath,
        logPath,
      };
    } finally {
      this._startLock = null;
      release();
    }
  }

  async stop() {
    const cur = this._readState();
    if (!cur || cur.state !== "running") {
      this.activeChild = null;
      this._clearState();
      return { ok: true, state: "stopped", note: "no running proxy" };
    }
    const pid = cur.pid;
    let killed = false;
    if (this.activeChild && this.activeChild.pid === pid) {
      try { this.activeChild.kill("SIGTERM"); killed = true; } catch {}
    }
    if (!killed) {
      try { process.kill(pid, "SIGTERM"); killed = true; } catch (e) {
        // ESRCH = process already gone. Treat as already-stopped.
        if (e.code !== "ESRCH") {
          this.logger.error(`[proxy] failed to send SIGTERM to ${pid}: ${e.message}`);
        }
      }
    }
    // Best-effort wait. We don't block forever — the state file is the
    // source of truth, and the next status() will reconcile liveness.
    if (killed && this.activeChild && this.activeChild.pid === pid) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1000);
        this.activeChild.once("exit", () => { clearTimeout(t); resolve(); });
      });
    }
    // Stage 6: write lastExitReason="stopped" before clearing, so the UI can
    // distinguish a manual stop from a crash on the very next status() call.
    // (If the child.on("exit") handler already wrote "stopped", this is
    // effectively a no-op overwrite.)
    if (cur && cur.pid === pid) {
      try {
        this._writeState({
          ...cur,
          state: "stopped",
          lastExitReason: "stopped",
          lastExitCode: 0,
          lastExitSignal: "SIGTERM",
          lastExitAt: new Date().toISOString(),
        });
      } catch {}
    }
    this._clearState();
    this.activeChild = null;
    return { ok: true, state: "stopped", pid };
  }

  // ----------------------------------------------------------------
  // restart
  // ----------------------------------------------------------------

  // Stage 7.5: restart defaults to route mode. If the previous state was
  // mode=provider, that mode is preserved (so a debug session isn't silently
  // switched). If stopped and no --port, error.
  async restart({ providerName, providerNames, port, mode } = {}) {
    const prev = this._readState();
    const prevMode = mode || (prev && prev.mode) || "route";
    await this.stop();
    if (prevMode === "route") {
      return await this.start({ mode: "route", port });
    }
    if (prevMode === "share") {
      return await this.start({
        mode: "share",
        providerNames: providerNames || prev?.providers || [],
        port,
      });
    }
    return await this.start({ mode: "provider", providerName, port });
  }

  // ----------------------------------------------------------------
  // status
  // ----------------------------------------------------------------

  async status() {
    if (!isInstalled(this.stateDir, LITELLM_PACKAGE.match(/==(.+)$/)[1])) {
      return {
        state: "not-installed",
        port: null,
        version: null,
        pid: null,
        currentProvider: null,
        currentProviders: [],
        mode: null,
        routesHash: null,
        aliases: null,
        note: "Run `originrouter proxy install` to set up LiteLLM.",
      };
    }
    const cur = this._readState();
    if (!cur || cur.state !== "running") {
      return {
        state: "stopped",
        port: null,
        version: cur?.version_pinned || LITELLM_PACKAGE.match(/==(.+)$/)[1],
        pid: null,
        currentProvider: cur?.provider || null,
        currentProviders: Array.isArray(cur?.providers) ? cur.providers : [],
        mode: cur?.mode || null,
        routesHash: cur?.routesHash || null,
        aliases: cur?.aliases || null,
      };
    }
    // Verify the pid is still alive and the health endpoint responds.
    let alive = false;
    let healthy = false;
    try {
      process.kill(cur.pid, 0);
      alive = true;
    } catch (error) {
      // EPERM means the process exists but this environment cannot signal it.
      // Do not reconcile state to stopped if the health endpoint is reachable.
      if (error?.code === "EPERM") alive = true;
    }
    if (alive && cur.port) {
      try {
        const r = await this.fetchFn(`http://${cur.host || PROXY_HOST}:${cur.port}/health/liveliness`);
        healthy = r.ok;
      } catch {}
    }
    if (!alive || !healthy) {
      // The recorded process is gone. Pick up any lastExit* fields the
      // child.on("exit") handler wrote, return them once for the UI, then
      // clear the state file.
      const lastExit = {
        lastExitReason: cur.lastExitReason || null,
        lastExitCode: cur.lastExitCode ?? null,
        lastExitSignal: cur.lastExitSignal || null,
        lastExitAt: cur.lastExitAt || null,
      };
      this._clearState();
      return {
        state: "stopped",
        port: null,
        version: cur.version_pinned,
        pid: null,
        currentProvider: cur.provider,
        currentProviders: Array.isArray(cur.providers) ? cur.providers : [],
        mode: cur.mode || null,
        note: alive ? "proxy unhealthy" : "proxy process exited",
        ...lastExit,
      };
    }
    return {
      state: "running",
      port: cur.port,
      version: cur.version_pinned,
      pid: cur.pid,
      host: cur.host || PROXY_HOST,
      currentProvider: cur.provider,
      currentProviders: Array.isArray(cur.providers) ? cur.providers : [],
      mode: cur.mode || "provider",
      routesHash: cur.routesHash || null,
      aliases: cur.aliases || null,
      startedAt: cur.startedAt,
      configPath: cur.configPath,
      routeMapPath: cur.routeMapPath || null,
      logPath: cur.logPath,
      // Stage 6: include lastExit* (cleared on next successful start).
      lastExitReason: cur.lastExitReason || null,
      lastExitCode: cur.lastExitCode ?? null,
      lastExitSignal: cur.lastExitSignal || null,
      lastExitAt: cur.lastExitAt || null,
    };
  }

  // ----------------------------------------------------------------
  // helpers
  // ----------------------------------------------------------------

  async _runCommand(command, args, { streamOutput = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (streamOutput) this.logger.log(text.trimEnd());
      });
      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (streamOutput) this.logger.error(text.trimEnd());
      });
      child.on("error", (err) => reject(err));
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      });
    });
  }

  async _waitForHealth(url) {
    const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const r = await this.fetchFn(url);
        if (r.ok) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }
    return false;
  }
}
