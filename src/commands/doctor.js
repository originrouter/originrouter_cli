// Stage 9.8 — `originrouter doctor` 诊断命令。
//
// 跑一组 PASS/FAIL/WARN 检查，30 秒内回答"为什么我的 CLI 不工作"。
// 不修复任何东西，不改 coding-key.json，不发任何改变服务端状态的请求。
//
// 输出格式（颜色由 cliErrors.js 的 _useColor 决定）：
//   ✓ <name>:    <detail>
//   ⚠ <name>:    <detail>
//   ✗ <name>:    <detail>
//   ────────────────────────────────────────
//   Result: <N> passed, <N> warning, <N> failed — <verdict>

import { readCodingAuth } from "../persistence/codingAuth.js";
import {
  accessTokenFor,
  isOAuthCredentialShape,
  OAUTH_RESOURCES,
} from "../runtime/authContract.js";
import { getStateDir } from "../persistence/state.js";
import { readConfig } from "../persistence/state.js";
import { getAgentRoutes, getRoutes } from "../config/routes.js";
import {
  DEFAULT_ORIGINROUTER_CONTROL_BASE_URL,
  DEFAULT_ORIGINROUTER_H5_BASE_URL,
  DEFAULT_SURETY_BASE_URL,
} from "../config/providerRoutes.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const useColor = process.stderr?.isTTY === true && process.stdout?.isTTY === true;
const c = (code) => (useColor ? code : "");

/**
 * @typedef {"pass" | "warn" | "fail" | "skip"} Status
 * @typedef {{ name: string; status: Status; detail: string; next?: string }} CheckResult
 */

/**
 * Run all doctor checks in sequence. Each check is independent; a
 * failure in one does not stop the others.
 *
 * @param {object} [options]
 * @param {string} [options.stateDir]
 * @param {object} [options.config]
 * @param {string} [options.apiBaseUrl]
 * @param {string} [options.h5BaseUrl]
 * @param {string} [options.suretyBaseUrl]
 * @param {number} [options.timeoutMs=4000]
 * @returns {Promise<CheckResult[]>}
 */
export async function runDoctor(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_ORIGINROUTER_CONTROL_BASE_URL;
  const h5BaseUrl = options.h5BaseUrl || DEFAULT_ORIGINROUTER_H5_BASE_URL;
  const suretyBaseUrl = options.suretyBaseUrl || _inferSuretyBaseUrl(apiBaseUrl);
  const timeoutMs = options.timeoutMs ?? 4000;
  const config = options.config || _readConfigSafe();

  const checks = [
    await _checkSignin(stateDir),
    await _checkTokenVerify(stateDir),
    _checkCodingKeyShape(stateDir),
    _checkRoutesConfig(config),
    await _checkReachable(`${suretyBaseUrl}/healthz`, "Surety", timeoutMs),
    await _checkReachable(`${apiBaseUrl}/health`, "Gateway", timeoutMs),
    _checkWorkerConfigured(config),
  ];
  return checks;
}

/**
 * Pretty-print a list of CheckResult to stdout and write a summary.
 * Returns the overall verdict as a string ("ok" | "warn" | "fail").
 */
export function printDoctorResults(checks, options = {}) {
  if (!options.skipBanner) {
    console.log("");
    console.log(`${c(BOLD)}OriginRouter doctor${c(RESET)}`);
    console.log("");
  }
  let passed = 0, warned = 0, failed = 0, skipped = 0;
  for (const r of checks) {
    if (r.status === "pass") {
      console.log(`${c(GREEN)}✓${c(RESET)} ${r.name.padEnd(18)} ${r.detail}`);
      passed++;
    } else if (r.status === "warn") {
      console.log(`${c(YELLOW)}⚠${c(RESET)} ${r.name.padEnd(18)} ${r.detail}`);
      if (r.next) console.log(`${c(DIM)}  Next: ${r.next}${c(RESET)}`);
      warned++;
    } else if (r.status === "fail") {
      console.log(`${c(RED)}✗${c(RESET)} ${r.name.padEnd(18)} ${r.detail}`);
      if (r.next) console.log(`${c(DIM)}  Next: ${r.next}${c(RESET)}`);
      failed++;
    } else {
      console.log(`${c(DIM)}○ ${r.name.padEnd(18)} ${r.detail}${c(RESET)}`);
      skipped++;
    }
  }
  console.log("");
  console.log(`${c(DIM)}${"─".repeat(48)}${c(RESET)}`);
  let verdict;
  let verdictText;
  if (failed > 0) {
    verdict = "fail";
    verdictText = `${failed} check${failed === 1 ? "" : "s"} failed — fix the items above and run doctor again.`;
  } else if (warned > 0) {
    verdict = "warn";
    verdictText = `${passed} passed, ${warned} warning — you're good to go.`;
  } else {
    verdict = "ok";
    verdictText = `${passed} passed — everything looks good.`;
  }
  console.log(`${c(BOLD)}Result:${c(RESET)} ${verdictText}`);
  console.log("");
  return verdict;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function _checkSignin(stateDir) {
  const stored = readCodingAuth(stateDir);
  if (!stored) {
    return {
      name: "Sign-in",
      status: "fail",
      detail: "no local credential on disk",
      next: "Run `originrouter login`.",
    };
  }
  if (!isOAuthCredentialShape(stored)) {
    return {
      name: "Sign-in",
      status: "fail",
      detail: "stored credential has an unknown shape",
      next: "Run `originrouter login` again to refresh.",
    };
  }
  const label = stored.deviceName
    ? `${stored.deviceName} (${stored.deviceId})`
    : stored.deviceId;
  return { name: "Sign-in", status: "pass", detail: `signed in as ${label}` };
}

async function _checkTokenVerify(stateDir) {
  const stored = readCodingAuth(stateDir);
  if (!stored) {
    return { name: "Token", status: "skip", detail: "skipped (not signed in)" };
  }
  if (!isOAuthCredentialShape(stored)) {
    return {
      name: "Token",
      status: "fail",
      detail: "stored OAuth credential is malformed",
      next: "Run `originrouter login` again.",
    };
  }

  const now = Date.now();
  if (stored.refreshExpiresAt <= now) {
    return {
      name: "Token",
      status: "fail",
      detail: "refresh token has expired",
      next: "Run `originrouter login` again.",
    };
  }

  const resources = Object.values(OAUTH_RESOURCES);
  const expired = resources.filter((resource) => {
    const token = accessTokenFor(stored, resource);
    return !token || token.expiresAt <= now;
  });
  const refreshMinutes = Math.max(
    0,
    Math.floor((stored.refreshExpiresAt - now) / 60_000),
  );
  if (expired.length > 0) {
    return {
      name: "Token",
      status: "warn",
      detail: `${expired.length} access token(s) need refresh; refresh session valid for ${refreshMinutes} min`,
      next: "The next authenticated request will refresh the required audience token.",
    };
  }
  return {
    name: "Token",
    status: "pass",
    detail: `4 audience tokens cached; refresh session valid for ${refreshMinutes} min`,
  };
}

function _checkCodingKeyShape(stateDir) {
  const stored = readCodingAuth(stateDir);
  if (!stored) {
    return { name: "Coding key file", status: "skip", detail: "no file (not signed in)" };
  }
  if (!isOAuthCredentialShape(stored)) {
    return {
      name: "Coding key file",
      status: "fail",
      detail: "shape check failed",
      next: "Run `originrouter login` to rewrite the file.",
    };
  }
  return {
    name: "Coding key file",
    status: "pass",
    detail: `${stored.kind} shape, fields complete`,
  };
}

function _checkRoutesConfig(config) {
  if (!config) {
    return { name: "Route config", status: "skip", detail: "no config found" };
  }
  const routes = getRoutes(config);
  const codexRoutes = getAgentRoutes(config, "codex");
  const hasClaude = Boolean(routes.main);
  const hasCodex = Boolean(codexRoutes.main);
  if (!hasClaude && !hasCodex) {
    return {
      name: "Route config",
      status: "pass",
      detail: "Claude inherits its environment; Codex route is unset",
    };
  }
  const summary = [];
  if (hasClaude) summary.push("claude");
  if (hasCodex) summary.push("codex");
  return {
    name: "Route config",
    status: "pass",
    detail: `${summary.join(", ")} configured`,
  };
}

async function _checkReachable(url, label, timeoutMs) {
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status >= 500) {
      return {
        name: label,
        status: "fail",
        detail: `HTTP ${resp.status}`,
        next: `${label} is unhealthy. Try again in a minute.`,
      };
    }
    // 2xx, 3xx, 4xx all count as "reachable" for a health probe —
    // a 401 on /health just means the server is up.
    return { name: label, status: "pass", detail: `reachable (${url})` };
  } catch (err) {
    return {
      name: label,
      status: "fail",
      detail: `unreachable: ${err.message || err}`,
      next: `Check the URL (${url}) and your network.`,
    };
  }
}

function _checkWorkerConfigured(config) {
  if (!config) {
    return { name: "Worker", status: "skip", detail: "no config found" };
  }
  const routes = getRoutes(config);
  const codexRoutes = getAgentRoutes(config, "codex");
  const remoteProviders = [];
  if (routes.main?.provider) {
    remoteProviders.push(routes.main.provider);
  }
  if (codexRoutes.main?.provider) {
    remoteProviders.push(codexRoutes.main.provider);
  }
  if (remoteProviders.length === 0) {
    return { name: "Worker", status: "skip", detail: "no remote routes configured" };
  }
  // Stage 9.8: doctor does not actively probe workers — that's the
  // responsibility of the relay. We just confirm at least one remote
  // provider is wired.
  return {
    name: "Worker",
    status: "warn",
    detail: `remote provider(s) configured: ${remoteProviders.join(", ")} — worker liveness checked at request time`,
    next: "If a remote request fails, run `originrouter claude` and watch the relay logs.",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _inferSuretyBaseUrl() {
  return process.env.SURETY_BASE_URL || DEFAULT_SURETY_BASE_URL;
}

function _readConfigSafe() {
  try {
    return readConfig();
  } catch {
    return null;
  }
}
