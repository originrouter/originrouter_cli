import { VERSION } from "../constants.js";
import { readUpdateState, writeUpdateState } from "./state.js";
import { isNewerVersion, parseSemver } from "./semver.js";
import { updateModeFromConfig } from "./settings.js";

export const NPM_LATEST_URL = "https://registry.npmjs.org/@originrouter%2fcli/latest";
export const UPDATE_CHECK_INTERVAL_MS = 20 * 60 * 60_000;

export function updateCheckIsDue(state, {
  now = new Date(),
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
} = {}) {
  const checkedAt = Date.parse(state?.last_checked_at || "");
  return !Number.isFinite(checkedAt) || now.getTime() - checkedAt >= intervalMs;
}

export function buildUpdateStatus({
  config = {},
  state = {},
  currentVersion = VERSION,
  installContext = null,
} = {}) {
  const latestVersion = parseSemver(state.latest_version) ? state.latest_version : null;
  const installedVersion = parseSemver(state.installed_version) ? state.installed_version : null;
  const restartRequired = Boolean(
    installedVersion
    && isNewerVersion(installedVersion, currentVersion)
    && state.last_result === "updated",
  );
  const effectiveVersion = restartRequired ? installedVersion : currentVersion;
  const updateAvailable = latestVersion
    ? isNewerVersion(latestVersion, effectiveVersion)
    : false;
  return {
    current_version: currentVersion,
    effective_version: effectiveVersion,
    installed_version: installedVersion,
    restart_required: restartRequired,
    latest_version: latestVersion,
    update_available: updateAvailable,
    mode: updateModeFromConfig(config),
    channel: "stable",
    last_checked_at: state.last_checked_at || null,
    last_check_attempt_at: state.last_check_attempt_at || null,
    last_check_error: state.last_check_error || null,
    dismissed_version: state.dismissed_version || null,
    last_attempt_at: state.last_attempt_at || null,
    last_result: state.last_result || null,
    last_update_error: state.last_error || null,
    last_failure_kind: state.last_failure_kind || null,
    install_method: installContext?.method || null,
    install_command: installContext?.command_string || null,
    can_install: Boolean(installContext?.command),
    can_auto_update: Boolean(installContext?.command && installContext?.writable),
    blocked_reason: installContext?.command
      ? (installContext.writable ? null : "install_directory_not_writable")
      : "unsupported_install_method",
  };
}

export async function checkForUpdate({
  stateDir,
  config = {},
  currentVersion = VERSION,
  fetchFn = globalThis.fetch,
  now = new Date(),
  timeoutMs = 5_000,
  force = false,
  installContext = null,
} = {}) {
  const current = readUpdateState(stateDir);
  if (!force && !updateCheckIsDue(current, { now })) {
    return buildUpdateStatus({ config, state: current, currentVersion, installContext });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchFn(NPM_LATEST_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
    const payload = await response.json();
    const latestVersion = String(payload?.version || "").trim();
    if (!parseSemver(latestVersion)) throw new Error("npm registry returned an invalid version");
    const next = writeUpdateState(stateDir, {
      latest_version: latestVersion,
      last_checked_at: now.toISOString(),
      last_check_error: null,
    });
    return buildUpdateStatus({ config, state: next, currentVersion, installContext });
  } catch (error) {
    const next = writeUpdateState(stateDir, {
      last_check_attempt_at: now.toISOString(),
      last_check_error: error?.name === "AbortError" ? "update check timed out" : String(error?.message || error),
    });
    const wrapped = new Error(next.last_check_error);
    wrapped.code = "UPDATE_CHECK_FAILED";
    wrapped.status = buildUpdateStatus({ config, state: next, currentVersion, installContext });
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}

export function cachedUpdateStatus({ stateDir, config, currentVersion = VERSION, installContext }) {
  return buildUpdateStatus({
    config,
    state: readUpdateState(stateDir),
    currentVersion,
    installContext,
  });
}
