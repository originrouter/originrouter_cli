import { VERSION } from "../constants.js";
import { getStateDir, readConfig } from "../persistence/state.js";
import { cachedUpdateStatus, checkForUpdate, updateCheckIsDue } from "../update/checker.js";
import { installLatestVersion } from "../update/coordinator.js";
import { detectInstallContext } from "../update/installContext.js";
import { dismissUpdateVersion, readUpdateState } from "../update/state.js";
import { promptForUpdate } from "../update/prompt.js";
import { updateModeFromConfig } from "../update/settings.js";

function printStatus(status, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`Current version: ${status.current_version}`);
  if (status.restart_required) {
    console.log(`Installed version: ${status.installed_version} (restart required)`);
  }
  console.log(`Latest version:  ${status.latest_version || "not checked"}`);
  console.log(`Update mode:     ${status.mode}`);
  console.log(`Install method:  ${status.install_method || "unknown"}`);
  console.log(`Last checked:    ${status.last_checked_at || "never"}`);
  if (status.last_check_error) console.log(`Last check error: ${status.last_check_error}`);
  if (status.last_failure_kind) console.log(`Last update failure: ${status.last_failure_kind}`);
  if (status.last_update_error) console.log(`Last update error: ${status.last_update_error}`);
  if (status.dismissed_version) console.log(`Skipped version: ${status.dismissed_version}`);
  console.log(`Update available: ${status.update_available ? "yes" : "no"}`);
  if (status.blocked_reason) console.log(`Automatic update unavailable: ${status.blocked_reason}`);
}

function printUpdatedResult(result) {
  console.log(`OriginRouter CLI updated: ${result.from_version} → ${result.to_version}.`);
  if (result.service_restarted) console.log("OriginRouter service restarted.");
  else if (result.service_restart_error) {
    console.log(`OriginRouter was updated, but the managed service could not restart: ${result.service_restart_error}`);
  }
  else if (result.daemon_was_running) {
    console.log("A manually started daemon is still using the previous version; restart it when safe.");
  }
  console.log("Restart OriginRouter to use the new version.");
}

export async function handleUpdateCommand(args, dependencies = {}) {
  const action = args.find((arg) => !arg.startsWith("-")) || "install";
  const json = args.includes("--json");
  const stateDir = dependencies.stateDir || getStateDir();
  const config = dependencies.config || readConfig();
  const installContext = dependencies.installContext || detectInstallContext();
  if (action === "status") {
    printStatus(cachedUpdateStatus({ stateDir, config, installContext }), { json });
    return;
  }
  if (action === "check") {
    const status = await checkForUpdate({
      stateDir,
      config,
      installContext,
      force: true,
      fetchFn: dependencies.fetchFn,
    });
    printStatus(status, { json });
    return;
  }
  if (action === "install" || action === "now") {
    const result = await installLatestVersion({
      stateDir,
      config,
      installContext,
      fetchFn: dependencies.fetchFn,
      spawnFn: dependencies.spawnFn,
      restartServiceFn: dependencies.restartServiceFn,
      serviceInstalledFn: dependencies.serviceInstalledFn,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.updated) {
      printUpdatedResult(result);
    } else if (result.reason === "already_current") {
      console.log(`OriginRouter CLI ${VERSION} is current.`);
    } else {
      console.log(`Update deferred: ${result.reason}.`);
    }
    return result;
  }
  throw new Error("Usage: originrouter update [status|check|install] [--json]");
}

export async function handleStartupUpdate({
  stateDir = getStateDir(),
  config = readConfig(),
  installContext = detectInstallContext(),
  fetchFn = globalThis.fetch,
  promptFn = promptForUpdate,
  installFn = installLatestVersion,
  interactivePrompt = true,
} = {}) {
  const mode = updateModeFromConfig(config);
  if (mode === "off" || process.env.ORIGINROUTER_DISABLE_UPDATE_CHECK === "1") {
    return { continue: true, mode };
  }
  const cached = cachedUpdateStatus({ stateDir, config, installContext });
  if (updateCheckIsDue(readUpdateState(stateDir))) {
    void checkForUpdate({ stateDir, config, installContext, fetchFn })
      .catch(() => {});
  }
  if (!interactivePrompt) return { continue: true, mode, status: cached };
  if (!cached.update_available) return { continue: true, mode, status: cached };
  if (!installContext.command) return { continue: true, mode, status: cached };

  if (mode === "auto") {
    let result;
    try {
      result = await installFn({
        stateDir,
        config,
        installContext,
        fetchFn,
        forceCheck: false,
        automatic: true,
      });
    } catch (error) {
      console.log(`Automatic update failed: ${error?.message || error}. Continuing with ${VERSION}.`);
      return { continue: true, mode, error };
    }
    if (result.updated) {
      printUpdatedResult(result);
      return { continue: false, mode, result };
    }
    if (result.reason && result.reason !== "already_current") {
      console.log(`Automatic update deferred: ${result.reason}.`);
    }
    return { continue: true, mode, result };
  }

  if (cached.dismissed_version === cached.latest_version) {
    return { continue: true, mode, status: cached };
  }
  const selection = await promptFn({
    currentVersion: cached.current_version,
    latestVersion: cached.latest_version,
  });
  if (selection === "dismiss") {
    dismissUpdateVersion(stateDir, cached.latest_version);
    return { continue: true, mode, selection };
  }
  if (selection === "skip") return { continue: true, mode, selection };
  let result;
  try {
    result = await installFn({
      stateDir,
      config,
      installContext,
      fetchFn,
      forceCheck: false,
    });
  } catch (error) {
    console.log(`Update failed: ${error?.message || error}. Continuing with ${VERSION}.`);
    return { continue: true, mode, selection, error };
  }
  if (result.updated) {
    printUpdatedResult(result);
    return { continue: false, mode, selection, result };
  }
  console.log(result.reason === "already_current"
    ? `OriginRouter CLI ${VERSION} is current.`
    : `Update deferred: ${result.reason}.`);
  return { continue: true, mode, selection, result };
}
