import { compatibilityPatchById, compatibilityStatus } from "../compatibility/status.js";
import { rollbackCompatibilityPack } from "../compatibility/patchStore.js";
import { checkCompatibilityPack, refreshCompatibilityPack } from "../compatibility/updater.js";
import { ensureStateDir } from "../persistence/state.js";

export async function handleCompatibility(args) {
  const [action = "status", ...rest] = args;
  const stateDir = ensureStateDir();
  const json = rest.includes("--json");
  const printJson = (value) => console.log(JSON.stringify(value, null, 2));
  if (action === "status") {
    const status = compatibilityStatus(stateDir);
    if (json) return printJson(status);
    console.log(`Compatibility engine: ${status.engine_version}`);
    console.log(`Active bundle: ${status.bundle_id} revision ${status.revision} (${status.source})`);
    console.log(`Patches: ${status.patches.length}`);
    console.log(`Automatic updates: ${status.automatic_updates ? "enabled" : "disabled"}`);
    if (status.last_checked_at) console.log(`Last update check: ${status.last_checked_at}`);
    if (status.update_available) console.log(`Update available: revision ${status.latest_revision}`);
    return;
  }
  if (action === "list") {
    const status = compatibilityStatus(stateDir);
    if (json) return printJson(status.patches);
    if (status.patches.length === 0) {
      console.log("No compatibility patches are active.");
      return;
    }
    for (const patch of status.patches) {
      console.log(`${patch.id}  ${patch.version}  ${patch.phase}`);
      console.log(`  ${patch.name}`);
      if (patch.description) console.log(`  ${patch.description}`);
    }
    return;
  }
  if (action === "inspect") {
    const patchId = rest.find((item) => !item.startsWith("--"));
    if (!patchId) throw new Error("Usage: originrouter compatibility inspect <patch-id> [--json]");
    const patch = compatibilityPatchById(stateDir, patchId);
    if (!patch) throw new Error(`Compatibility patch '${patchId}' is not active.`);
    if (json) return printJson(patch);
    console.log(`${patch.name} (${patch.id})`);
    console.log(`Version: ${patch.version}`);
    console.log(`Phase: ${patch.phase}`);
    console.log(`Required: ${patch.required ? "yes" : "no"}`);
    console.log(`Failure mode: ${patch.failure_mode}`);
    if (patch.description) console.log(`Description: ${patch.description}`);
    console.log(`Match: ${JSON.stringify(patch.match)}`);
    return;
  }
  if (action === "check") {
    const result = await checkCompatibilityPack({ stateDir });
    const status = compatibilityStatus(stateDir);
    if (json) return printJson({ result: {
      update_available: result.update_available,
      latest_revision: result.latest_revision,
      reason: result.reason || null,
    }, status });
    console.log(result.update_available
      ? `Compatibility update available: revision ${result.latest_revision}.`
      : "Compatibility patches are current.");
    return;
  }
  if (action === "refresh" || action === "update") {
    const result = await refreshCompatibilityPack({ stateDir });
    if (result.skipped) {
      console.error("Compatibility update skipped: no trusted signing keys are configured for this CLI build.");
      process.exitCode = 1;
      return;
    }
    if (json) return printJson({ result: {
      installed: result.installed === true,
      reason: result.reason || null,
    }, status: compatibilityStatus(stateDir) });
    console.log(result.installed
      ? `Installed ${result.pack.bundle_id || result.pack.pack_id} revision ${result.pack.revision}. Running gateways reload it automatically.`
      : `Compatibility patches are current (${result.reason || "unchanged"}).`);
    return;
  }
  if (action === "rollback") {
    const result = rollbackCompatibilityPack(stateDir);
    if (!result.rolledBack) {
      console.error("No previous compatibility pack is available.");
      process.exitCode = 1;
      return;
    }
    if (json) return printJson({ rolled_back: true, status: compatibilityStatus(stateDir) });
    console.log(`Rolled back to ${result.pack.bundle_id || result.pack.pack_id} revision ${result.pack.revision}. Running gateways reload it automatically.`);
    return;
  }
  throw new Error("Usage: originrouter compatibility status|list|inspect|check|update|refresh|rollback");
}
