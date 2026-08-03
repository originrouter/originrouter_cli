import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { addProvider, normalizeProviderForRead } from "../config/providers.js";
import {
  ROUTE_AGENTS,
  ROUTE_DEFS,
  getAgentRoutes,
  replaceAgentRoutes,
} from "../config/routes.js";
import { readConfig, writeConfig } from "../persistence/state.js";
import { loadCloudModels } from "./routeSources.js";

export const ORIGINROUTER_CLOUD_PROVIDER = "originrouter-cloud";

// These are ordered preferences, not hard requirements. The catalogue is
// authoritative: setup picks the first available preferred model and falls
// back to a compatible family when a recommendation has been retired.
export const RECOMMENDED_CLOUD_MODELS = Object.freeze({
  claudeMain: Object.freeze([
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-opus-5",
  ]),
  claudeSmall: Object.freeze([
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
  ]),
  codexMain: Object.freeze([
    "gpt-5.6-sol",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-2026-03-05",
  ]),
});

function firstAvailable(models, preferences, family, fallback = null) {
  for (const id of preferences) {
    const match = models.find((model) => model.id === id);
    if (match) return match;
  }
  return models.find((model) => family(model.id)) || fallback;
}

export function recommendedCloudRouteModels(models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("No OriginRouter Cloud coding models are available for this account.");
  }
  const claudeMain = firstAvailable(
    models,
    RECOMMENDED_CLOUD_MODELS.claudeMain,
    (id) => id.startsWith("claude-"),
  );
  const claudeSmall = firstAvailable(
    models,
    RECOMMENDED_CLOUD_MODELS.claudeSmall,
    (id) => id.includes("haiku"),
    claudeMain,
  );
  const codexMain = firstAvailable(
    models,
    RECOMMENDED_CLOUD_MODELS.codexMain,
    (id) => id.startsWith("gpt-") || id.includes("codex"),
  );
  if (!claudeMain || !codexMain) {
    throw new Error(
      "The OriginRouter Cloud catalogue does not contain compatible Claude Code and Codex models.",
    );
  }
  return { claudeMain, claudeSmall, codexMain };
}

export function originrouterCloudProviderNames(config) {
  return new Set(
    Object.entries(config?.providers || {})
      .filter(([, provider]) => normalizeProviderForRead(provider)?.type === "originrouter")
      .map(([name]) => name),
  );
}

export function hasAnyAgentRoutes(config) {
  return ROUTE_AGENTS.some((agent) =>
    ROUTE_DEFS[agent].slots.some((slot) => getAgentRoutes(config, agent)[slot]),
  );
}

export function applyRecommendedCloudRoutes(config, models) {
  const selected = recommendedCloudRouteModels(models);
  const existingCloudNames = originrouterCloudProviderNames(config);
  const existingCloudName = [...existingCloudNames][0] || null;
  const providerName = existingCloudName || ORIGINROUTER_CLOUD_PROVIDER;
  let next = config || {};
  const existing = existingCloudName ? next.providers?.[providerName] : null;
  if (!existing) {
    if (next.providers?.[ORIGINROUTER_CLOUD_PROVIDER]) {
      throw new Error(
        `Provider name '${ORIGINROUTER_CLOUD_PROVIDER}' is reserved for the login-backed Cloud route source.`,
      );
    }
    next = addProvider(next, {
      name: providerName,
      type: "originrouter",
      model: selected.claudeMain.id,
      auth: { type: "oauth" },
    });
  } else {
    next = {
      ...next,
      providers: {
        ...next.providers,
        [providerName]: { ...existing, model: selected.claudeMain.id },
      },
    };
  }
  next = replaceAgentRoutes(next, "claude", {
    main: { provider: providerName, model: selected.claudeMain.id },
    small: { provider: providerName, model: selected.claudeSmall.id },
  });
  next = replaceAgentRoutes(next, "codex", {
    main: { provider: providerName, model: selected.codexMain.id },
  });
  return { config: next, providerName, selected };
}

export function clearOriginrouterCloudRoutes(config) {
  const cloudNames = originrouterCloudProviderNames(config);
  if (cloudNames.size === 0) return { config, clearedAgents: [], changed: false };
  let next = config || {};
  const clearedAgents = [];
  for (const agent of ROUTE_AGENTS) {
    const current = getAgentRoutes(next, agent);
    const retained = {};
    let cleared = false;
    for (const slot of ROUTE_DEFS[agent].slots) {
      const entry = current[slot];
      if (!entry) continue;
      if (cloudNames.has(entry.provider)) cleared = true;
      else retained[slot] = entry;
    }
    if (cleared) {
      next = replaceAgentRoutes(next, agent, retained);
      clearedAgents.push(agent);
    }
  }
  const providers = { ...(next.providers || {}) };
  for (const name of cloudNames) delete providers[name];
  next = { ...next };
  if (Object.keys(providers).length === 0) delete next.providers;
  else next.providers = providers;
  return { config: next, clearedAgents, changed: true };
}

async function confirm(question, {
  defaultYes,
  inputStream = input,
  outputStream = output,
} = {}) {
  const readline = createInterface({ input: inputStream, output: outputStream });
  try {
    const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
    const answer = (await readline.question(`${question}${suffix}`)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

function printSelectedModels(selected, printFn) {
  printFn("OriginRouter Cloud Agent routes configured:");
  printFn(`  Claude Code core: ${selected.claudeMain.id}`);
  printFn(`  Claude Code fast: ${selected.claudeSmall.id}`);
  printFn(`  Codex:            ${selected.codexMain.id}`);
}

export async function configureRecommendedCloudRoutes({
  stateDir,
  loadCloudModelsFn = loadCloudModels,
  readConfigFn = readConfig,
  writeConfigFn = writeConfig,
  printFn = console.log,
} = {}) {
  const models = await loadCloudModelsFn({ stateDir });
  const result = applyRecommendedCloudRoutes(readConfigFn(), models);
  writeConfigFn(result.config);
  printSelectedModels(result.selected, printFn);
  return result;
}

export async function maybeConfigureAgentRoutesAfterLogin({
  args = [],
  stateDir,
  inputStream = input,
  outputStream = output,
  loadCloudModelsFn = loadCloudModels,
  readConfigFn = readConfig,
  writeConfigFn = writeConfig,
  printFn = console.log,
  warnFn = console.warn,
  confirmFn = confirm,
} = {}) {
  const keepNative = args.includes("--keep-agent-routes") || args.includes("--no-agent-setup");
  const force = args.includes("--configure-agents");
  if (keepNative && force) {
    throw new Error("Choose either --configure-agents or --keep-agent-routes, not both.");
  }
  if (keepNative) {
    printFn("Agent routes unchanged. OriginRouter will not override the existing Claude Code or Codex environment.");
    return { status: "kept" };
  }
  const config = readConfigFn();
  const hasRoutes = hasAnyAgentRoutes(config);
  if (!force && (!inputStream.isTTY || !outputStream.isTTY)) {
    printFn("Agent routes unchanged. Run `originrouter agent setup` to configure them later.");
    return { status: "non_interactive" };
  }
  if (!force) {
    outputStream.write("\nAgent model routing\n");
    if (hasRoutes) {
      outputStream.write("Existing Agent routes were detected and will be preserved unless you explicitly replace them.\n");
    } else {
      outputStream.write("OriginRouter currently does not override Claude Code or Codex.\n");
    }
    const accepted = await confirmFn(
      hasRoutes
        ? "Replace the existing Agent routes with OriginRouter Cloud recommended models?"
        : "Configure OriginRouter Cloud recommended models for Claude Code and Codex?",
      { defaultYes: !hasRoutes, inputStream, outputStream },
    );
    if (!accepted) {
      printFn("Agent routes unchanged. Existing CLI logins, environment variables, and private Providers remain in use.");
      return { status: "declined" };
    }
  }
  try {
    const result = await configureRecommendedCloudRoutes({
      stateDir,
      loadCloudModelsFn,
      readConfigFn,
      writeConfigFn,
      printFn,
    });
    return { status: "configured", ...result };
  } catch (error) {
    warnFn(`Agent route setup was not completed: ${error?.message || error}`);
    warnFn("Your OriginRouter login is active and existing Agent routes were not changed.");
    warnFn("Run `originrouter agent setup` to try again.");
    return { status: "failed", error };
  }
}

export function resetCloudRoutesOnLogout({
  readConfigFn = readConfig,
  writeConfigFn = writeConfig,
  printFn = console.log,
} = {}) {
  const result = clearOriginrouterCloudRoutes(readConfigFn());
  if (!result.changed) return result;
  writeConfigFn(result.config);
  if (result.clearedAgents.length === 0) return result;
  const labels = result.clearedAgents.map((agent) =>
    agent === "claude" ? "Claude Code" : "Codex",
  );
  printFn(
    `${labels.join(" and ")} OriginRouter Cloud routes were reset to None. ` +
    "OriginRouter will no longer override their environment or official CLI configuration.",
  );
  return result;
}

export async function handleAgentRouteSetup(args = [], options = {}) {
  const native = args.includes("--native") || args.includes("--none");
  const cloud = args.includes("--cloud");
  if (native && cloud) {
    throw new Error("Choose either --cloud or --native, not both.");
  }
  if (native) {
    let next = options.readConfigFn?.() ?? readConfig();
    for (const agent of ROUTE_AGENTS) next = replaceAgentRoutes(next, agent, {});
    (options.writeConfigFn || writeConfig)(next);
    (options.printFn || console.log)(
      "Agent routes set to None. OriginRouter will not override Claude Code or Codex.",
    );
    return { status: "native", config: next };
  }
  return maybeConfigureAgentRoutesAfterLogin({
    ...options,
    args: cloud ? ["--configure-agents"] : [],
    stateDir: options.stateDir,
  });
}
