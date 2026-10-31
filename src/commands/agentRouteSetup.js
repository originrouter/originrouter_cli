import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { addProvider, normalizeProviderForRead } from "../config/providers.js";
import {
  ROUTE_AGENTS,
  ROUTE_DEFS,
  getAgentRoutes,
  replaceAgentRoutes,
} from "../config/routes.js";
import {
  DEFAULT_CLOUD_ROUTE_MODELS,
  defaultRouteSlots,
} from "../config/deviceDefaults.js";
import { activeAccountStateDir } from "../persistence/accounts.js";
import { readCodingAuth } from "../persistence/codingAuth.js";
import { readConfig, writeConfig } from "../persistence/state.js";
import { loadCloudModels } from "./routeSources.js";

export const ORIGINROUTER_CLOUD_PROVIDER = "originrouter-cloud";

// How the device's agent routes are managed.
//
// `cloud` — OriginRouter owns them; the device default is theirs.
// `native` — the person asked for the agents' own environment
// (`originrouter agent setup --native`), and OriginRouter must not put a
// route back. This is the one setting the carry-over below must respect:
// without it, the next CLI run would undo the answer the person gave.
export const AGENT_ROUTE_MODE_CLOUD = "cloud";
export const AGENT_ROUTE_MODE_NATIVE = "native";

// The device-level default profile. It lives in `config/deviceDefaults.js`
// because the alias map reads it too — the same table cannot live in a
// command module that nothing else may import.
export { DEFAULT_CLOUD_ROUTE_MODELS };

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
  claudeHaiku: Object.freeze([
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

// Fresh installations use these exact route values. The ordered lists above
// are still used only by an explicit `agent setup --cloud`, which can adapt
// to models currently available to the signed-in account.

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
  // The auxiliary families inherit the primary model, except Haiku: it is the
  // cheap model a device answers its small tasks with, so it is resolved
  // separately and seeded as its own route slot.
  const claudeHaiku = firstAvailable(
    models,
    RECOMMENDED_CLOUD_MODELS.claudeHaiku,
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
  return { claudeMain, claudeHaiku, codexMain };
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

function applyCloudRoutes(config, selected) {
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
  // The primary route is pinned, and so is the Haiku family: it is the cheap
  // model the device answers its small tasks with. The remaining families
  // (opus/sonnet/fable) inherit the primary model, which is what an unset
  // slot means.
  next = replaceAgentRoutes(next, "claude", {
    main: { provider: providerName, model: selected.claudeMain.id },
    ...(selected.claudeHaiku
      ? { haiku: { provider: providerName, model: selected.claudeHaiku.id } }
      : {}),
  });
  next = replaceAgentRoutes(next, "codex", {
    main: { provider: providerName, model: selected.codexMain.id },
  });
  // The routes are managed from here on, so the device default no longer has
  // to be carried over on the next run.
  next = { ...next, agentRouteMode: AGENT_ROUTE_MODE_CLOUD };
  return { config: next, providerName, selected };
}

export function applyRecommendedCloudRoutes(config, models) {
  return applyCloudRoutes(config, recommendedCloudRouteModels(models));
}

export function applyDefaultCloudRoutes(config = {}) {
  return applyCloudRoutes(config, {
    claudeMain: { id: DEFAULT_CLOUD_ROUTE_MODELS.claudeMain },
    claudeHaiku: { id: DEFAULT_CLOUD_ROUTE_MODELS.claudeHaiku },
    codexMain: { id: DEFAULT_CLOUD_ROUTE_MODELS.codexMain },
  });
}

// Carry the device-level default over to an agent that has no route of its
// own.
//
// The default used to be the model id written into the agent's environment at
// launch, so it survived every upgrade by construction. Under the alias
// architecture the agent holds an alias instead, and the map that turns the
// alias into a model reads the route table — so the default has to live
// there, or the map has no initial value and the session has no model to
// start on.
//
// The rules:
//   - only an agent with no route at all is filled in. A route the person
//     set — even a partial one — is theirs.
//   - the Cloud has to be reachable. A device that never signed in keeps its
//     own agents' environment; a Cloud route it cannot use is worse than no
//     route at all.
//   - a device that asked for the native environment keeps that answer.
export function carryOverDefaultRoutes(config, { hasCredential = false } = {}) {
  const cfg = config || {};
  if (!hasCredential) return { config: cfg, changed: false };
  if (cfg.agentRouteMode === AGENT_ROUTE_MODE_NATIVE) {
    return { config: cfg, changed: false };
  }
  const missing = ROUTE_AGENTS.filter((agent) => {
    const routes = getAgentRoutes(cfg, agent);
    return !ROUTE_DEFS[agent].slots.some((slot) => routes[slot]);
  });
  if (missing.length === 0) return { config: cfg, changed: false };

  let next = cfg;
  const existingCloudName = [...originrouterCloudProviderNames(next)][0] || null;
  const providerName = existingCloudName || ORIGINROUTER_CLOUD_PROVIDER;
  if (!existingCloudName) {
    if (next.providers?.[ORIGINROUTER_CLOUD_PROVIDER]) {
      throw new Error(
        `Provider name '${ORIGINROUTER_CLOUD_PROVIDER}' is reserved for the login-backed Cloud route source.`,
      );
    }
    next = addProvider(next, {
      name: providerName,
      type: "originrouter",
      model: DEFAULT_CLOUD_ROUTE_MODELS.claudeMain,
      auth: { type: "oauth" },
    });
  }
  for (const agent of missing) {
    const slots = defaultRouteSlots(agent);
    if (!slots.main) continue;
    next = replaceAgentRoutes(next, agent, {
      main: { provider: providerName, model: slots.main },
      ...(slots.haiku ? { haiku: { provider: providerName, model: slots.haiku } } : {}),
    });
  }
  next = { ...next, agentRouteMode: AGENT_ROUTE_MODE_CLOUD };
  return { config: next, changed: true, carried: missing };
}

// A missing config.json is the first-install marker: the bundled defaults are
// written once. Once it exists, the person's routes are preserved — but an
// agent with no route at all still gets the device default, so an upgrade
// never leaves a device without a model to start on.
export function initializeDefaultCloudRoutes({
  stateDir,
  existsFn = existsSync,
  writeConfigFn = writeConfig,
  activeAccountStateDirFn = activeAccountStateDir,
  readConfigFn = readConfig,
  hasCredentialFn = readCodingAuth,
} = {}) {
  if (!stateDir) throw new Error("stateDir is required to initialize default Agent routes");
  // Route configuration is account-scoped after login. Checking only the
  // root ~/.originrouter/config.json makes every CLI invocation look like a
  // fresh installation and overwrites the active account's saved routes with
  // bundled defaults. Resolve the same account directory used by
  // readConfig()/writeConfig() before deciding whether initialization is
  // required. Before login, activeAccountStateDir() naturally resolves to the
  // root state directory, preserving first-install behaviour.
  const configStateDir = activeAccountStateDirFn(stateDir);
  if (!existsFn(join(configStateDir, "config.json"))) {
    const result = applyDefaultCloudRoutes();
    writeConfigFn(result.config);
    return { status: "initialized", ...result };
  }
  const carried = carryOverDefaultRoutes(readConfigFn(), {
    hasCredential: Boolean(hasCredentialFn(stateDir)),
  });
  if (!carried.changed) return { status: "existing" };
  writeConfigFn(carried.config);
  return { status: "carried", ...carried };
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
  printFn(`  Claude Code core:  ${selected.claudeMain.id}`);
  printFn(`  Claude Haiku:      ${selected.claudeHaiku?.id || "inherits the core model"}`);
  printFn(`  Claude Code aux:   inherits the core model (opus/sonnet/fable)`);
  printFn(`  Codex:             ${selected.codexMain.id}`);
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
  const force = args.includes("--cloud");
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
      // The person answered "do not override the agents". When there was no
      // route to preserve, that answer is the device's native environment, and
      // it is recorded so the device default is not carried over on the next
      // run and silently takes that answer back.
      if (!hasRoutes) {
        const declined = { ...config, agentRouteMode: AGENT_ROUTE_MODE_NATIVE };
        writeConfigFn(declined);
      }
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
    // The answer has to outlive this run: the device default is carried over
    // to any agent that has no route, and this one is the person saying that
    // OriginRouter does not speak for their agents.
    next = { ...next, agentRouteMode: AGENT_ROUTE_MODE_NATIVE };
    (options.writeConfigFn || writeConfig)(next);
    (options.printFn || console.log)(
      "Agent routes set to None. OriginRouter will not override Claude Code or Codex.",
    );
    return { status: "native", config: next };
  }
  return maybeConfigureAgentRoutesAfterLogin({
    ...options,
    args: cloud ? ["--cloud"] : [],
    stateDir: options.stateDir,
  });
}
