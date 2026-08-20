import { readFileSync } from "node:fs";
import { cwd, stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { BUILTIN_COLLABORATION_TEMPLATES } from "../collaboration/adaptivePlan.js";
import {
  autoConfigureCollaboration,
  validateAndNormalizeAutoConfiguration,
} from "../collaboration/collaborationAutoConfig.js";
import {
  cacheCollaborationCapabilities,
  getCachedCollaborationCapabilities,
} from "../collaboration/collaborationCapabilityCache.js";
import {
  deleteCollaborationDraft,
  getCollaborationDraft,
  listCollaborationDrafts,
  saveCollaborationDraft,
} from "../collaboration/collaborationDraftStore.js";
import { loadCliDeviceDirectory } from "./routeSources.js";
import { handleServiceCommand } from "./service.js";
import { readApiToken } from "../persistence/authToken.js";
import { ensureStateDir, readDaemonState } from "../persistence/state.js";
import { redactDisplayText, redactDisplayValue } from "../security/displayRedaction.js";
import {
  buildLocalWorkspaceConfiguration,
  normalizeCoordinator,
  normalizeWorkspaceMode,
  objectiveMentionsRemoteTarget,
  workspaceModeDefinition,
} from "../collaboration/workspaceModes.js";
import { requestCollaborationAdvice } from "../collaboration/collaborationAdviceClient.js";

class CollaborationCliError extends Error {
  constructor(message, {
    exitCode = 1,
    diagnosticCode = "COLLABORATION_COMMAND_FAILED",
    impact = "The requested collaboration operation did not complete.",
    action = "Run `originrouter collaboration doctor <run-id>` when a Run ID is available.",
    cause = null,
  } = {}) {
    super([
      message,
      `Impact: ${impact}`,
      `Action: ${action}`,
      `Diagnostic code: ${diagnosticCode}`,
    ].join("\n"), cause ? { cause } : undefined);
    this.exitCode = exitCode;
    this.diagnosticCode = diagnosticCode;
  }
}

function collaborationErrorDetails(status, reason) {
  const code = String(reason || "COLLABORATION_REQUEST_FAILED").toUpperCase();
  if (status === 401 || status === 403 || /AUTH|LOGIN|TRUST|E2EE|IDENTITY/.test(code)) {
    return {
      exitCode: 4,
      action: "Check `originrouter login status`, device trust, and the selected workspace permission.",
    };
  }
  if (/BUDGET|POLICY/.test(code)) {
    return {
      exitCode: 7,
      action: "Review the Run, device, and Agent budget or organization policy before resuming.",
    };
  }
  if (/CAPABILIT|RUNTIME|PROVIDER|MODEL|ROUTE/.test(code)) {
    return {
      exitCode: 5,
      action: "Check the selected device with `originrouter doctor`, then configure its Agent route or runtime.",
    };
  }
  if (status === 503 || /TIMEOUT|OFFLINE|UNAVAILABLE|CONNECTION|RELAY/.test(code)) {
    return {
      exitCode: 10,
      action: "Check device connectivity and retry. The Daemon-owned Run may still be active.",
    };
  }
  return { exitCode: 1 };
}

function values(args, name) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && index + 1 < args.length) out.push(args[index + 1]);
    else if (args[index].startsWith(`--${name}=`)) out.push(args[index].slice(name.length + 3));
  }
  return out;
}

function value(args, name) {
  return values(args, name).at(-1);
}

function has(args, name) {
  return args.includes(`--${name}`);
}

function localApi() {
  const stateDir = ensureStateDir();
  const state = readDaemonState();
  const token = readApiToken(stateDir);
  if (!state?.localApiPort || !token) {
    throw new CollaborationCliError(
      "OriginRouter daemon is not running.",
      {
        exitCode: 3,
        diagnosticCode: "LOCAL_DAEMON_UNAVAILABLE",
        impact: "No collaboration can be created or controlled until the local service is available.",
        action: "Run `originrouter service start` or `originrouter daemon`, then try again.",
      },
    );
  }
  const bind = state.localApiBindAddress || "127.0.0.1";
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return { baseUrl: `http://${urlHost}:${state.localApiPort}`, token };
}

function interruptedError(message = "Operation interrupted.") {
  const error = new Error(message);
  error.code = "ORIGINROUTER_INTERRUPTED";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw interruptedError();
}

async function request(path, { method = "GET", body, signal } = {}) {
  const api = localApi();
  let response;
  try {
    throwIfAborted(signal);
    response = await fetch(`${api.baseUrl}${path}`, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${api.token}`,
        ...(body == null ? {} : { "Content-Type": "application/json" }),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw interruptedError();
    throw new CollaborationCliError(
      "Could not connect to the local OriginRouter service.",
      {
        exitCode: 3,
        diagnosticCode: "LOCAL_API_CONNECTION_FAILED",
        impact: "The requested operation was not sent. Existing Daemon-owned Runs may still be active.",
        action: "Run `originrouter service status`, then restart the service if necessary.",
        cause: error,
      },
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const message = typeof payload.error === "string"
      ? payload.error
      : payload.error?.message || payload.message
        || `Local collaboration request failed (${response.status})`;
    const diagnosticCode = String(
      payload.reason || payload.error?.code || "COLLABORATION_REQUEST_FAILED",
    ).toUpperCase();
    throw new CollaborationCliError(message, {
      diagnosticCode,
      ...collaborationErrorDetails(response.status, diagnosticCode),
    });
  }
  return payload.data || payload;
}

function parseParticipant(raw) {
  const parts = String(raw || "").split(":");
  const participantId = parts.shift()?.trim();
  const runtime = parts.shift()?.trim();
  const deviceId = parts.shift()?.trim();
  const workspaceId = parts.join(":").trim();
  if (!participantId || !runtime || !deviceId) {
    throw new Error("--participant must use id:runtime:device:workspace, for example builder:claude:local:/project");
  }
  return {
    participant_id: participantId,
    runtime,
    device_id: deviceId,
    workspace_id: workspaceId || cwd(),
  };
}

function roleHints(args) {
  const result = new Map();
  for (const raw of values(args, "role")) {
    const index = raw.indexOf("=");
    if (index <= 0) throw new Error("--role must use participant_id=natural language responsibility");
    result.set(raw.slice(0, index).trim(), raw.slice(index + 1).trim());
  }
  return result;
}

function participantAssignments(args, name, usage) {
  const result = new Map();
  for (const raw of values(args, name)) {
    const index = String(raw).indexOf("=");
    if (index <= 0 || index === String(raw).length - 1) throw new Error(usage);
    result.set(String(raw).slice(0, index).trim(), String(raw).slice(index + 1).trim());
  }
  return result;
}

function positiveIntegerOption(raw, name, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw == null) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`--${name} must be a positive integer${Number.isFinite(max) ? ` no greater than ${max}` : ""}.`);
  }
  return parsed;
}

function amountMicrosOption(args) {
  const micros = value(args, "amount-limit-micros");
  const amount = value(args, "amount-limit");
  if (micros != null && amount != null) {
    throw new Error("Use either --amount-limit or --amount-limit-micros, not both.");
  }
  if (micros != null) return positiveIntegerOption(micros, "amount-limit-micros");
  if (amount == null) return null;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--amount-limit must be a positive decimal amount.");
  }
  const converted = Math.round(parsed * 1_000_000);
  if (!Number.isSafeInteger(converted) || converted <= 0) {
    throw new Error("--amount-limit is outside the supported range.");
  }
  return converted;
}

export function createPayload(args) {
  const specPath = value(args, "spec");
  if (specPath) {
    const parsed = JSON.parse(readFileSync(specPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--spec must contain one JSON object");
    return parsed;
  }
  const objective = value(args, "objective");
  if (!objective) throw new Error("Missing --objective. Use --spec <file.json> for a reusable or more detailed collaboration definition.");
  const hints = roleHints(args);
  const routes = participantAssignments(
    args,
    "route",
    "--route must use participant_id=provider:model",
  );
  const permissions = participantAssignments(
    args,
    "permission",
    "--permission must use participant_id=permission_profile",
  );
  const participants = values(args, "participant").map(parseParticipant).map((item, index) => ({
    ...item,
    role_hint: hints.get(item.participant_id) || "",
    permission_profile: permissions.get(item.participant_id) || undefined,
    ...(routes.has(item.participant_id) ? (() => {
      const [provider, ...modelParts] = routes.get(item.participant_id).split(":");
      const model = modelParts.join(":").trim();
      if (!provider.trim() || !model) {
        throw new Error("--route must use participant_id=provider:model");
      }
      return { provider: provider.trim(), model };
    })() : {}),
    planner: index === 0,
  }));
  if (participants.length === 0) {
    throw new Error("Add at least one --participant id:runtime:device:workspace.");
  }
  if (participants.length > 16) throw new Error("A collaboration supports at most 16 participants.");
  const ids = participants.map((participant) => participant.participant_id);
  if (new Set(ids).size !== ids.length) throw new Error("Participant ids must be unique.");
  for (const id of ids) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
      throw new Error(`Invalid participant id '${id}'. Use lowercase letters, numbers, _ or -.`);
    }
  }
  for (const key of [...routes.keys(), ...permissions.keys(), ...hints.keys()]) {
    if (!ids.includes(key)) throw new Error(`Participant option references unknown id '${key}'.`);
  }
  const tokenLimit = positiveIntegerOption(value(args, "token-limit"), "token-limit");
  const amountLimitMicros = amountMicrosOption(args);
  const concurrency = positiveIntegerOption(value(args, "concurrency"), "concurrency", {
    max: participants.length,
  });
  const currency = String(value(args, "currency") || "USD").trim().toUpperCase();
  if (amountLimitMicros != null && !/^[A-Z]{3}$/.test(currency)) {
    throw new Error("--currency must be a 3-letter ISO currency code.");
  }
  return {
    objective,
    participants,
    preferences: value(args, "preference") || "",
    workflow_template_id: value(args, "template") || "adaptive",
    coordination_prompt: value(args, "coordination-prompt") || "",
    budget: {
      ...(tokenLimit == null ? {} : { token_limit: tokenLimit }),
      ...(amountLimitMicros == null ? {} : {
        amount_limit_micros: amountLimitMicros,
        currency,
      }),
      ...(concurrency == null ? {} : { max_concurrency: concurrency }),
    },
  };
}

function parseInteger(value, { min, max, fallback }) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

class WizardBack extends Error {
  constructor(step) {
    super("Return to the previous wizard step.");
    this.step = step;
  }
}

function maybeBack(answer, backStep, { text = false } = {}) {
  if (!backStep) return;
  const normalized = String(answer || "").trim().toLowerCase();
  const matches = text
    ? normalized === ":back"
    : ["b", "back", ":back"].includes(normalized);
  if (matches) throw new WizardBack(backStep);
}

async function askRequired(
  prompt,
  question,
  defaultValue = "",
  { backStep = null } = {},
) {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await prompt.question(`${question}${suffix}: `)).trim();
    maybeBack(answer, backStep, { text: true });
    if (answer) return answer;
    if (defaultValue) return defaultValue;
    console.log("A value is required.");
  }
}

async function askOptional(
  prompt,
  question,
  defaultValue = "",
  { backStep = null } = {},
) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await prompt.question(`${question}${suffix}: `)).trim();
  maybeBack(answer, backStep, { text: true });
  return answer || defaultValue;
}

async function choose(
  prompt,
  question,
  options,
  { defaultIndex = 0, backStep = null } = {},
) {
  if (!options.length) throw new Error(`No available choices for: ${question}`);
  const firstAvailable = options.findIndex((option) => !option.disabledReason);
  if (firstAvailable < 0) {
    throw new Error(`No available choices for: ${question}. ${options.map((option) => option.disabledReason).filter(Boolean).join(" ")}`);
  }
  const safeDefault = options[defaultIndex]?.disabledReason ? firstAvailable : defaultIndex;
  console.log(`\n${question}`);
  for (const [index, option] of options.entries()) {
    const detail = option.disabledReason
      ? `unavailable: ${option.disabledReason}`
      : option.description;
    console.log(`  ${index + 1}. ${option.label}${detail ? ` — ${detail}` : ""}`);
  }
  if (backStep) console.log("  B. Return to the previous step");
  while (true) {
    const answer = (await prompt.question(`Choose [${safeDefault + 1}]: `)).trim();
    maybeBack(answer, backStep);
    const selected = answer ? Number(answer) - 1 : safeDefault;
    if (Number.isInteger(selected) && selected >= 0 && selected < options.length) {
      if (options[selected].disabledReason) {
        console.log(`That option is unavailable: ${options[selected].disabledReason}`);
        continue;
      }
      return options[selected];
    }
    console.log(`Enter a number from 1 to ${options.length}.`);
  }
}

async function confirm(prompt, question, defaultYes = false) {
  const answer = (await prompt.question(`${question} [${defaultYes ? "Y/n" : "y/N"}] `))
    .trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function confirmWithBack(
  prompt,
  question,
  defaultYes = false,
  backStep = null,
) {
  while (true) {
    const answer = (await prompt.question(
      `${question} [${defaultYes ? "Y/n" : "y/N"}${backStep ? "/B" : ""}] `,
    )).trim().toLowerCase();
    maybeBack(answer, backStep);
    if (!answer) return defaultYes;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
    console.log("Enter Y or N.");
  }
}

function composeCollaborationPreference({
  style,
  independentReview,
  parallelTasks,
  analyzeBeforeRetry,
  additional,
}) {
  return [
    style.preference,
    independentReview
      ? "Have another Agent independently verify completed implementation."
      : "Independent Agent review is not required unless the Planner identifies a risk.",
    parallelTasks
      ? "Run independent tasks in parallel when device capacity permits."
      : "Prefer a clear sequential execution order unless parallel work is necessary.",
    analyzeBeforeRetry
      ? "When work fails, analyze the cause and wait for an explicit retry instead of repeating automatically."
      : "A failed task may use the configured retry policy.",
    additional,
  ].map((item) => String(item || "").trim()).filter(Boolean).join("\n");
}

function capabilityCompatibilityIssue(capabilities) {
  const versions = capabilities?.protocol_versions || {};
  if (Number(versions.collaboration_snapshot) < 2) {
    return "device collaboration snapshot protocol is older than V2";
  }
  if (Number(versions.collaboration_event) < 2) {
    return "device collaboration event protocol is older than V2";
  }
  return null;
}

function assertCompatibleCapabilities(capabilities) {
  const issue = capabilityCompatibilityIssue(capabilities);
  if (!issue) return capabilities;
  const error = new Error(
    `The selected device is not compatible: ${issue}. Update OriginRouter CLI on that device and restart its service.`,
  );
  error.code = "COLLABORATION_PROTOCOL_INCOMPATIBLE";
  throw error;
}

export async function deviceDirectory(
  localCapabilities,
  loadDirectory = (options) => loadCliDeviceDirectory(options),
  getCachedCapabilities = getCachedCollaborationCapabilities,
) {
  const local = {
    deviceId: localCapabilities.device.device_id,
    deviceName: localCapabilities.device.name || "This device",
    online: true,
    trustStatus: "trusted",
    local: true,
    capabilities: localCapabilities,
  };
  let remote = [];
  try {
    remote = await loadDirectory({ stateDir: ensureStateDir() });
  } catch {
    // Login is optional. A local-only user still gets the full wizard.
  }
  return [
    local,
    ...remote.filter((device) => device.deviceId !== local.deviceId)
      .map((device) => {
        const cachedCapabilities = getCachedCapabilities(device.deviceId);
        const compatibilityIssue = cachedCapabilities
          ? capabilityCompatibilityIssue(cachedCapabilities)
          : null;
        return {
          ...device,
          local: false,
          cachedCapabilities,
          unavailableReason: device.trustStatus !== "trusted"
            ? "E2EE device identity is not trusted"
            : compatibilityIssue
              ? `${compatibilityIssue}; update the CLI on this device`
              : !device.online && !cachedCapabilities
                ? "device is offline and has no cached capability snapshot"
                : null,
        };
      }),
  ];
}

export async function capabilitiesForWizardDevice(
  device,
  requestFn = request,
  cacheCapabilities = cacheCollaborationCapabilities,
  getCachedCapabilities = getCachedCollaborationCapabilities,
) {
  if (device.capabilities) return assertCompatibleCapabilities(device.capabilities);
  if (device.online !== false) {
    try {
      const data = await requestFn(
        `/collaboration/devices/${encodeURIComponent(device.deviceId)}/capabilities`,
      );
      cacheCapabilities(data.capabilities);
      return assertCompatibleCapabilities(data.capabilities);
    } catch (error) {
      const cached = device.cachedCapabilities || getCachedCapabilities(device.deviceId);
      if (cached) return assertCompatibleCapabilities(cached);
      throw error;
    }
  }
  const cached = device.cachedCapabilities || getCachedCapabilities(device.deviceId);
  if (cached) return assertCompatibleCapabilities(cached);
  throw new Error("The selected device is offline and has no cached capability snapshot.");
}

async function chooseWorkspace(
  prompt,
  device,
  capabilities,
  requestFn = request,
  preferredWorkspaceId = "",
  backStep = null,
) {
  const workspaces = capabilities.trusted_workspaces || [];
  const options = [
    ...workspaces.map((workspace) => ({
      label: workspace.display_name || workspace.canonical_path,
      description: workspace.canonical_path,
      workspace,
    })),
    { label: "Enter another folder path", custom: true },
  ];
  const preferredIndex = workspaces.findIndex((workspace) => (
    workspace.workspace_id === preferredWorkspaceId
    || workspace.canonical_path === preferredWorkspaceId
  ));
  const selected = await choose(prompt, "Workspace", options, {
    defaultIndex: preferredIndex >= 0 ? preferredIndex : 0,
    backStep,
  });
  if (!selected.custom) return selected.workspace.workspace_id || selected.workspace.canonical_path;
  const defaultPath = capabilities.device?.default_workspace_path || cwd();
  const path = await askRequired(prompt, "Folder path on the selected device", defaultPath);
  const approved = await confirm(
    prompt,
    `Trust this workspace for Agent execution?\n  ${path}`,
    false,
  );
  if (!approved) throw new Error("Workspace trust was not granted; collaboration creation stopped.");
  const data = await requestFn(
    `/collaboration/devices/${encodeURIComponent(device.deviceId)}/workspaces/trust`,
    { method: "POST", body: { path } },
  );
  return data.workspace.workspace_id || data.workspace.canonical_path;
}

async function chooseRoute(
  prompt,
  runtime,
  capabilities,
  preferred = {},
  backStep = null,
) {
  const configured = capabilities.resolved_routes?.[runtime]?.main || null;
  const providers = (capabilities.providers || []).filter((provider) => provider.models?.length);
  const options = [{
    label: configured
      ? `Use configured ${runtime} route (${configured.provider}/${configured.model})`
      : `Use ${runtime} native/default configuration`,
    description: "Recommended; keeps routing managed on the selected device.",
    route: null,
  }, ...providers.map((provider) => ({
    label: provider.name,
    description: `${provider.models.length} enabled model${provider.models.length === 1 ? "" : "s"}`,
    provider,
  }))];
  const preferredProviderIndex = providers.findIndex(
    (provider) => provider.name === preferred.provider,
  );
  const providerChoice = await choose(prompt, "Model route", options, {
    defaultIndex: preferredProviderIndex >= 0 ? preferredProviderIndex + 1 : 0,
    backStep,
  });
  if (!providerChoice.provider) return {};
  const models = providerChoice.provider.models;
  const preferredModelIndex = models.findIndex(
    (model) => model.id === preferred.model,
  );
  const modelChoice = await choose(
    prompt,
    `Model from ${providerChoice.provider.name}`,
    models.map((model) => ({
      label: model.id,
      description: model.priced ? "pricing configured" : "pricing unavailable",
      model,
    })),
    {
      defaultIndex: preferredModelIndex >= 0 ? preferredModelIndex : 0,
      backStep,
    },
  );
  return { provider: providerChoice.provider.name, model: modelChoice.model.id };
}

const WIZARD_WORKING_STYLES = Object.freeze([
  {
    id: "implement_review",
    label: "Implement and review",
    description: "Recommended for everyday development, documentation, and configuration work.",
    templateId: "adaptive",
    participantCount: 2,
    preference: "Assign the main implementation to one participant and an independent review to another.",
  },
  {
    id: "plan_implement_verify",
    label: "Plan, implement, verify",
    description: "Use separate planning, implementation, and verification stages for complex or high-risk work.",
    templateId: "plan_implement_verify",
    participantCount: 3,
    preference: "",
  },
  {
    id: "single_agent",
    label: "Single Agent",
    description: "One Agent with durable execution, approvals, history, and recovery.",
    templateId: "adaptive",
    participantCount: 1,
    preference: "Use one participant and keep the execution plan as small as possible.",
  },
  {
    id: "parallel_research",
    label: "Parallel research",
    description: "Investigate independent directions in parallel, then synthesize the result.",
    templateId: "parallel_research",
    participantCount: 3,
    preference: "",
  },
  {
    id: "review_panel",
    label: "Team review",
    description: "Challenge a proposal from several perspectives before execution.",
    templateId: "review_panel",
    participantCount: 3,
    preference: "",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Configure 1 to 16 participants and give the Planner your own coordination preference.",
    templateId: "adaptive",
    participantCount: 2,
    preference: "",
  },
]);

export async function interactiveCreatePayload({
  prompt: suppliedPrompt = null,
  requestFn = request,
  loadDeviceDirectoryFn = (options) => loadCliDeviceDirectory(options),
  initialDraft = null,
  saveDraftFn = saveCollaborationDraft,
  deleteDraftFn = deleteCollaborationDraft,
  cacheCapabilitiesFn = cacheCollaborationCapabilities,
  getCachedCapabilitiesFn = getCachedCollaborationCapabilities,
} = {}) {
  if (!suppliedPrompt && (!input.isTTY || !output.isTTY)) {
    throw new Error("Interactive collaboration setup requires a terminal. Use --spec or --objective with --participant in automation.");
  }
  const prompt = suppliedPrompt || createInterface({ input, output });
  const ownsPrompt = !suppliedPrompt;
  let draft = initialDraft ? { ...initialDraft } : {};
  if (initialDraft && Number(initialDraft.wizard_sequence_version) !== 2) {
    // Older drafts used resources as step 5 and preferences as step 6. Reopen
    // both stages so a resumed draft cannot silently skip a newly reordered
    // product decision.
    draft.step = Math.min(Number(draft.step) || 1, 5);
  }
  const persistDraft = (patch) => {
    draft = saveDraftFn({ ...draft, wizard_sequence_version: 2, ...patch });
    return draft;
  };
  if (!draft.draft_id) persistDraft({ step: 1 });
  try {
    if (requestFn === request) {
      try {
        localApi();
      } catch (error) {
        console.log(`OriginRouter service check: ${error.message}`);
        if (!(await confirm(prompt, "Start the OriginRouter background service now?", true))) {
          throw new Error(
            "The collaboration was not created because its background service is unavailable.",
          );
        }
        await handleServiceCommand(["start"]);
        localApi();
      }
    }
    console.log("\nCreate Agent collaboration");
    console.log("The OriginRouter service will own the task. Closing this terminal will not stop it.");
    console.log("Use B in selection screens or :back in text fields to return to the previous step.\n");

    while (true) {
      let currentStep = Math.max(1, Math.min(7, Number(draft.step) || 1));
      try {
        let objective = draft.objective || "";
        if (currentStep <= 1) {
          console.log("Step 1 of 7 · Objective");
          objective = await askRequired(
            prompt,
            "What should the team accomplish?",
            objective,
          );
          persistDraft({ step: 2, objective });
          currentStep = 2;
        }

        let style = WIZARD_WORKING_STYLES.find(
          (item) => item.id === draft.style_id,
        ) || WIZARD_WORKING_STYLES[0];
        let participantCount = draft.participant_count || style.participantCount;
        if (currentStep <= 2) {
          console.log("\nStep 2 of 7 · Working style");
          style = await choose(prompt, "Working style", WIZARD_WORKING_STYLES, {
            defaultIndex: Math.max(
              0,
              WIZARD_WORKING_STYLES.findIndex((item) => item.id === draft.style_id),
            ),
            backStep: 1,
          });
          const countAnswer = await askOptional(
            prompt,
            "Team size (1-16; press Enter for the recommended setup)",
            String(draft.participant_count || style.participantCount),
            { backStep: 1 },
          );
          participantCount = parseInteger(countAnswer, {
            min: 1,
            max: 16,
            fallback: null,
          });
          if (!participantCount) {
            throw new Error("Team size must be between 1 and 16.");
          }
          persistDraft({
            step: 3,
            style_id: style.id,
            participant_count: participantCount,
            participants: draft.style_id === style.id
              ? draft.participants
              : [],
          });
          currentStep = 3;
        }

        const localCapabilities = (
          await requestFn("/collaboration/local/capabilities")
        ).capabilities;
        cacheCapabilitiesFn(localCapabilities);
        const devices = await deviceDirectory(
          localCapabilities,
          loadDeviceDirectoryFn,
          getCachedCapabilitiesFn,
        );
        let participants = Array.isArray(draft.participants)
          ? draft.participants.slice(0, participantCount)
          : [];
        const participantReview = [];
        const defaults = [
          {
            id: "planner",
            name: "Planner",
            hint: "Own the overall plan, coordinate the team, and review the final result.",
          },
          {
            id: "builder",
            name: "Builder",
            hint: "Implement the main body of work and report concrete results.",
          },
          {
            id: "reviewer",
            name: "Reviewer",
            hint: "Independently verify quality, risks, and acceptance criteria.",
          },
        ];

        if (currentStep <= 4) {
          participants = [];
          for (let index = 0; index < participantCount; index += 1) {
            const restored = draft.participants?.[index] || {};
            if (index === 0) {
              console.log("\nStep 3 of 7 · Coordinator");
              console.log("The coordinator reads the objective and proposes a plan. It cannot modify the workspace before you confirm that plan.");
            } else if (index === 1) {
              console.log("\nStep 4 of 7 · Participants");
            }
            const preset = defaults[index] || {
              id: `agent_${index + 1}`,
              name: `Agent ${index + 1}`,
              hint: "Complete tasks assigned by the Planner and return evidence-backed results.",
            };
            console.log(`\nAgent ${index + 1} of ${participantCount}`);
            const participantId = await askRequired(
              prompt,
              "Stable id",
              restored.participant_id || preset.id,
              { backStep: 2 },
            );
            if (!/^[a-z][a-z0-9_-]{0,31}$/.test(participantId)) {
              throw new Error("Agent id must start with a lowercase letter and contain only lowercase letters, numbers, _ or -.");
            }
            if (participants.some((item) => item.participant_id === participantId)) {
              throw new Error(`Duplicate Agent id: ${participantId}`);
            }
            const displayName = await askRequired(
              prompt,
              "Display name",
              restored.display_name || preset.name,
              { backStep: 2 },
            );
            const preferredDeviceIndex = devices.findIndex(
              (item) => item.deviceId === restored.device_id,
            );
            const device = await choose(
              prompt,
              "Execution device",
              devices.map((item) => ({
                label: item.deviceName || item.deviceId,
                description: item.local
                  ? "this device"
                  : item.online
                    ? "online · trusted E2EE device"
                    : `offline · will wait for this device · cached ${item.cachedCapabilities?.captured_at || "previously"}`,
                disabledReason: item.unavailableReason,
                device: item,
              })),
              {
                defaultIndex: preferredDeviceIndex >= 0 ? preferredDeviceIndex : 0,
                backStep: 2,
              },
            ).then((choice) => choice.device);
            const capabilities = await capabilitiesForWizardDevice(
              device,
              requestFn,
              cacheCapabilitiesFn,
              getCachedCapabilitiesFn,
            );
            const runtimes = capabilities.runtimes || [];
            const preferredRuntimeIndex = runtimes.findIndex(
              (item) => item.id === restored.runtime,
            );
            const runtime = await choose(
              prompt,
              "Agent runtime",
              runtimes.map((item) => ({
                label: item.id === "claude" ? "Claude Code" : "Codex",
                runtime: item.id,
                disabledReason: item.available
                  ? null
                  : `${item.id} CLI is not installed on this device`,
              })),
              {
                defaultIndex:
                  preferredRuntimeIndex >= 0 ? preferredRuntimeIndex : 0,
                backStep: 2,
              },
            ).then((choice) => choice.runtime);
            const route = await chooseRoute(
              prompt,
              runtime,
              capabilities,
              restored,
              2,
            );
            const workspaceId = await chooseWorkspace(
              prompt,
              device,
              capabilities,
              requestFn,
              restored.workspace_id,
              2,
            );
            const profiles = capabilities.permission_profiles || [];
            const restoredPermissionIndex = profiles.findIndex(
              (profile) => profile.id === restored.permission_profile,
            );
            const permission = await choose(
              prompt,
              "Permission profile",
              profiles.map((profile) => ({
                label: profile.label,
                description: profile.description,
                id: profile.id,
              })),
              {
                defaultIndex: restoredPermissionIndex >= 0
                  ? restoredPermissionIndex
                  : Math.max(
                      0,
                      profiles.findIndex((profile) => profile.id === "guarded"),
                    ),
                backStep: 2,
              },
            );
            const roleHint = await askRequired(
              prompt,
              "Responsibility",
              restored.role_hint || preset.hint,
              { backStep: 2 },
            );
            const participant = {
              participant_id: participantId,
              display_name: displayName,
              runtime,
              device_id: device.deviceId,
              workspace_id: workspaceId,
              permission_profile: permission.id,
              role_hint: roleHint,
              planner: index === 0,
              ...route,
            };
            participants.push(participant);
            persistDraft({
              step: index === 0 ? 4 : 5,
              participants,
            });
            const resolved = capabilities.resolved_routes?.[runtime]?.main;
            participantReview.push({
              participant,
              deviceName: device.deviceName || device.deviceId,
              routeLabel: route.provider && route.model
                ? `${route.provider}/${route.model}`
                : resolved?.provider && resolved?.model
                  ? `device default (${resolved.provider}/${resolved.model})`
                  : "Agent native/default configuration",
            });
          }
          if (participantCount === 1) {
            console.log("\nStep 4 of 7 · Participants");
            console.log("No additional participants are needed for the selected team size.");
          }
          persistDraft({ step: 5, participants });
          currentStep = 5;
        } else {
          for (const participant of participants) {
            const device = devices.find(
              (candidate) => candidate.deviceId === participant.device_id,
            );
            let resolved = null;
            try {
              const capabilities = await capabilitiesForWizardDevice(
                device || {
                  deviceId: participant.device_id,
                  online: false,
                },
                requestFn,
                cacheCapabilitiesFn,
                getCachedCapabilitiesFn,
              );
              resolved = capabilities.resolved_routes?.[participant.runtime]?.main;
            } catch {
              // The review remains usable with the explicit participant route.
              // If no explicit route exists, it truthfully reports that the
              // device default will be resolved when the device is available.
            }
            participantReview.push({
              participant,
              deviceName: device?.deviceName || participant.device_id,
              routeLabel: participant.provider && participant.model
                ? `${participant.provider}/${participant.model}`
                : resolved?.provider && resolved?.model
                  ? `device default (${resolved.provider}/${resolved.model})`
                  : "Device default route (resolved when available)",
            });
          }
        }

        let independentReview = draft.independent_review == null
          ? participantCount > 1
          : draft.independent_review;
        let parallelTasks = draft.parallel_tasks == null
          ? style.id === "parallel_research"
          : draft.parallel_tasks;
        let analyzeBeforeRetry = draft.analyze_before_retry == null
          ? true
          : draft.analyze_before_retry;
        let additionalPreference = draft.preference || "";
        if (currentStep <= 5) {
          console.log("\nStep 5 of 7 · Collaboration preference");
          independentReview = await confirmWithBack(
            prompt,
            "Have another Agent independently verify completed implementation?",
            independentReview,
            4,
          );
          parallelTasks = await confirmWithBack(
            prompt,
            "Run independent tasks in parallel when capacity permits?",
            parallelTasks,
            4,
          );
          analyzeBeforeRetry = await confirmWithBack(
            prompt,
            "Analyze failures before an explicit retry instead of repeating automatically?",
            analyzeBeforeRetry,
            4,
          );
          additionalPreference = await askOptional(
            prompt,
            "Additional collaboration preference (optional)",
            additionalPreference,
            { backStep: 4 },
          );
          persistDraft({
            step: 6,
            independent_review: independentReview,
            parallel_tasks: parallelTasks,
            analyze_before_retry: analyzeBeforeRetry,
            preference: additionalPreference,
          });
          currentStep = 6;
        }

        let concurrency = draft.concurrency || Math.min(4, participantCount);
        let tokenLimit = draft.token_limit ?? null;
        let amountLimitMicros = draft.amount_limit_micros ?? null;
        let currency = draft.currency || "USD";
        if (currentStep <= 6) {
          console.log("\nStep 6 of 7 · Resources and parallelism");
          const concurrencyAnswer = await askOptional(
            prompt,
            "Maximum Agents running at once",
            String(concurrency),
            { backStep: 5 },
          );
          concurrency = parseInteger(concurrencyAnswer, {
            min: 1,
            max: Math.min(16, participantCount),
            fallback: null,
          });
          if (!concurrency) {
            throw new Error(`Maximum concurrency must be between 1 and ${Math.min(16, participantCount)}.`);
          }
          const tokenLimitText = await askOptional(
            prompt,
            "Optional Token limit for this collaboration (blank to inherit device policies)",
            tokenLimit == null ? "" : String(tokenLimit),
            { backStep: 5 },
          );
          tokenLimit = tokenLimitText ? Number(tokenLimitText) : null;
          if (tokenLimitText && (!Number.isFinite(tokenLimit) || tokenLimit <= 0)) {
            throw new Error("Token limit must be a positive number.");
          }
          currency = (await askOptional(
            prompt,
            "Budget currency (3-letter code)",
            currency,
            { backStep: 5 },
          )).toUpperCase();
          if (!/^[A-Z]{3}$/.test(currency)) {
            throw new Error("Budget currency must be a 3-letter ISO code.");
          }
          const amountText = await askOptional(
            prompt,
            `Optional amount limit in ${currency} (blank to inherit device policies)`,
            amountLimitMicros == null
              ? ""
              : String(amountLimitMicros / 1_000_000).replace(/\.0+$/, ""),
            { backStep: 5 },
          );
          if (amountText) {
            const amount = Number(amountText);
            amountLimitMicros = Math.round(amount * 1_000_000);
            if (!Number.isFinite(amount) || amount <= 0
                || !Number.isSafeInteger(amountLimitMicros)) {
              throw new Error("Amount limit must be a positive decimal amount.");
            }
          } else {
            amountLimitMicros = null;
          }
          persistDraft({
            step: 7,
            concurrency,
            token_limit: tokenLimit,
            amount_limit_micros: amountLimitMicros,
            currency,
          });
        }

        const preference = composeCollaborationPreference({
          style,
          independentReview,
          parallelTasks,
          analyzeBeforeRetry,
          additional: additionalPreference,
        });

        console.log("\nStep 7 of 7 · Review");
        console.log(`  Objective: ${objective}`);
        console.log(`  Working style: ${style.label}`);
        for (const item of participantReview) {
          const participant = item.participant;
          console.log(`  ${participant.display_name}: ${participant.runtime} · ${item.deviceName}`);
          console.log(`    Route: ${item.routeLabel}`);
          console.log(`    Workspace: ${participant.workspace_id}`);
          console.log(`    Permission: ${participant.permission_profile}`);
          if (devices.find((device) => device.deviceId === participant.device_id)?.online === false) {
            console.log("    Start condition: wait until this device is online");
          }
        }
        console.log(`  Concurrency: ${concurrency}`);
        console.log(`  Run Token limit: ${tokenLimit == null ? "inherit device and account policies" : tokenLimit}`);
        console.log(`  Run amount limit: ${amountLimitMicros == null ? "inherit device and account policies" : `${amountLimitMicros / 1_000_000} ${currency}`}`);
        const answer = (await prompt.question(
          "Create this collaboration? [Y] create  [B] return to limits  [Q] save draft and quit: ",
        )).trim().toLowerCase();
        if (["b", "back"].includes(answer)) throw new WizardBack(6);
        if (["q", "quit", "n", "no"].includes(answer)) {
          throw new Error(`Collaboration creation stopped. Draft saved as ${draft.draft_id}.`);
        }
        if (!["", "y", "yes"].includes(answer)) {
          console.log("Enter Y to create, B to return, or Q to save and quit.");
          continue;
        }
        const payload = {
          objective,
          participants,
          preferences: preference,
          workflow_template_id: style.templateId,
          budget: {
            max_concurrency: concurrency,
            ...(tokenLimit == null ? {} : { token_limit: tokenLimit }),
            ...(amountLimitMicros == null ? {} : {
              amount_limit_micros: amountLimitMicros,
              currency,
            }),
          },
        };
        deleteDraftFn(draft.draft_id);
        return payload;
      } catch (error) {
        if (error instanceof WizardBack) {
          persistDraft({ step: error.step });
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (draft.draft_id) {
      persistDraft({});
      const message = String(error?.message || error || "Collaboration setup failed.");
      if (!message.includes("Draft saved as")) {
        const wrapped = new Error(`${message} Draft saved as ${draft.draft_id}.`);
        wrapped.cause = error;
        throw wrapped;
      }
    }
    throw error;
  } finally {
    if (ownsPrompt) prompt.close();
  }
}

function positionalObjective(rest) {
  const beforeOption = [];
  for (const item of rest) {
    if (String(item).startsWith("--")) break;
    beforeOption.push(item);
  }
  return beforeOption.join(" ").trim();
}

async function collectAutoConfigurationDevices({
  requestFn = request,
  loadDeviceDirectoryFn = (options) => loadCliDeviceDirectory(options),
  cacheCapabilitiesFn = cacheCollaborationCapabilities,
  getCachedCapabilitiesFn = getCachedCollaborationCapabilities,
} = {}) {
  const localCapabilities = (await requestFn("/collaboration/local/capabilities")).capabilities;
  cacheCapabilitiesFn(localCapabilities);
  const devices = await deviceDirectory(
    localCapabilities,
    loadDeviceDirectoryFn,
    getCachedCapabilitiesFn,
  );
  for (const device of devices) {
    if (device.unavailableReason || (device.trustStatus !== "trusted" && !device.local)) continue;
    try {
      device.capabilities = await capabilitiesForWizardDevice(
        device,
        requestFn,
        cacheCapabilitiesFn,
        getCachedCapabilitiesFn,
      );
    } catch {
      // A device without a usable snapshot is omitted from the model's
      // capability whitelist and can never pass deterministic validation.
    }
  }
  return devices.filter((device) => device.capabilities || device.cachedCapabilities);
}

async function resolveAutoConfigurationAmbiguity(error, {
  prompt,
  objective,
  devices,
}) {
  if (error?.code !== "AUTO_CONFIG_WORKSPACE_AMBIGUOUS" || !error.proposal) throw error;
  if (!prompt) throw error;
  const ambiguity = error.ambiguity;
  const selected = await choose(
    prompt,
    `Workspace for ${ambiguity.participant_id}`,
    ambiguity.workspaces.map((workspace) => ({
      label: workspace.display_name || workspace.workspace_id,
      description: workspace.canonical_path,
      workspace_id: workspace.workspace_id,
    })),
  );
  const proposal = structuredClone(error.proposal);
  const participant = proposal.participants.find(
    (item) => item.participant_id === ambiguity.participant_id,
  );
  participant.workspace_id = selected.workspace_id;
  return validateAndNormalizeAutoConfiguration(proposal, { objective, devices });
}

export async function automaticCreatePayload({
  objective,
  prompt = null,
  workspaceMode = null,
  coordinator = "codex",
  currentDirectory = cwd(),
  cloudAdvice = false,
  requestFn = request,
  loadDeviceDirectoryFn = (options) => loadCliDeviceDirectory(options),
  cacheCapabilitiesFn = cacheCollaborationCapabilities,
  getCachedCapabilitiesFn = getCachedCollaborationCapabilities,
  modelFn,
  adviceFn = requestCollaborationAdvice,
  modelOptions = {},
  workspaceSelections = {},
} = {}) {
  const devices = await collectAutoConfigurationDevices({
    requestFn,
    loadDeviceDirectoryFn,
    cacheCapabilitiesFn,
    getCachedCapabilitiesFn,
  });
  if (!devices.length) {
    throw Object.assign(new Error("No trusted device has a usable collaboration capability snapshot."), { code: "AUTO_CONFIG_CAPABILITIES_UNAVAILABLE" });
  }
  if (workspaceMode) {
    let advisedMode = workspaceMode;
    let advice = null;
    if (cloudAdvice) {
      try {
        advice = await adviceFn({
          objective,
          requestedMode: workspaceMode,
          coordinator,
          devices,
        }, { stateDir: ensureStateDir() });
        if (workspaceMode === "auto") advisedMode = advice.recommended_mode;
      } catch (error) {
        advice = { error_code: error.code || "COLLABORATION_ADVICE_FAILED" };
      }
    }
    const configured = buildLocalWorkspaceConfiguration({
      objective,
      mode: advisedMode,
      coordinator,
      devices,
      currentDirectory,
      workspaceSelections,
    });
    if (workspaceMode === "auto") {
      configured.workspace_mode = "auto";
      configured.auto_configuration.workspace_mode = "auto";
    }
    if (advice && !advice.error_code) {
      const ranks = { green: 0, yellow: 1, red: 2 };
      if (ranks[advice.risk_tier] > ranks[configured.risk_tier]) {
        configured.risk_tier = advice.risk_tier;
        configured.auto_configuration.risk_tier = advice.risk_tier;
        configured.auto_configuration.safe_to_skip_confirmation = false;
        configured.auto_configuration.requires_explicit_confirmation = true;
      }
      configured.planning_source = "cloud_advice";
      configured.auto_configuration.advice = {
        reason: String(advice.reason || "").slice(0, 2000),
        planning_notes: Array.isArray(advice.planning_notes)
          ? advice.planning_notes.map((item) => String(item).slice(0, 500)).slice(0, 12)
          : [],
        system_model: String(advice.system_model || "").slice(0, 191),
      };
    } else if (cloudAdvice) {
      configured.planning_source = "local_fallback";
      configured.auto_configuration.advice_error = advice?.error_code || "COLLABORATION_ADVICE_FAILED";
      configured.auto_configuration.safe_to_skip_confirmation = false;
      configured.auto_configuration.requires_explicit_confirmation = true;
      if (workspaceMode === "auto" && objectiveMentionsRemoteTarget(objective)) {
        const error = new Error(
          "Auto could not safely choose a remote team because the advisory model is unavailable. Retry, or select Remote Ops with Shift+Tab.",
        );
        error.code = "AUTO_CONFIG_REMOTE_ADVICE_REQUIRED";
        error.cause = advice?.error_code;
        throw error;
      }
    }
    return configured;
  }
  try {
    return await autoConfigureCollaboration({
      objective,
      devices,
      ...(modelFn ? { modelFn } : {}),
      modelOptions: { stateDir: ensureStateDir(), ...modelOptions },
    });
  } catch (error) {
    if (error?.code === "AUTO_CONFIG_CLOUD_QUESTION" && prompt) {
      const question = error.question;
      const selected = await choose(
        prompt,
        question.prompt,
        question.options.map((option) => ({
          label: option.label,
          id: option.id,
        })),
      );
      return autoConfigureCollaboration({
        objective,
        devices,
        modelOptions: {
          stateDir: ensureStateDir(),
          ...modelOptions,
          answer: { [question.id]: selected.id },
        },
      });
    }
    return resolveAutoConfigurationAmbiguity(error, { prompt, objective, devices });
  }
}

export function autoConfigurationView(payload) {
  return {
    objective: payload.objective,
    participants: payload.participants.map((participant) => ({
      participant_id: participant.participant_id,
      display_name: participant.display_name,
      runtime: participant.runtime,
      device_id: participant.device_id,
      workspace_id: participant.workspace_id,
      role_hint: participant.role_hint,
      permission_profile: participant.permission_profile,
      planner: participant.planner,
      waiting_for_device: participant.waiting_for_device === true,
      route: participant.provider
        ? { provider: participant.provider, model: participant.model }
        : null,
    })),
    workflow_template_id: payload.workflow_template_id,
    preferences: payload.preferences,
    independent_review: payload.auto_configuration?.independent_review === true,
    max_concurrency: payload.budget.max_concurrency,
    budget: {
      token_limit: payload.budget.token_limit ?? null,
      amount_limit_micros: payload.budget.amount_limit_micros ?? null,
      currency: payload.budget.currency ?? null,
      inherited: payload.auto_configuration?.inherited_budget === true,
    },
  };
}

function printAutoConfiguration(payload) {
  console.log("\nCollaboration team configured\n");
  for (const participant of payload.participants) {
    const runtime = participant.runtime === "claude" ? "Claude Code" : "Codex";
    const wait = participant.waiting_for_device ? " · waiting for device" : "";
    console.log(`  ${participant.display_name.padEnd(12)} ${runtime.padEnd(12)} ${participant.device_id} · ${participant.workspace_id}${wait}`);
  }
  const requestedMode = payload.auto_configuration?.workspace_mode;
  const resolvedMode = payload.auto_configuration?.resolved_workspace_mode;
  const modeLabel = requestedMode
    ? workspaceModeDefinition(resolvedMode || requestedMode).label
    : payload.auto_configuration?.independent_review
      ? "implementation with independent review"
      : "adaptive collaboration";
  console.log(`\n  Method: ${requestedMode === "auto" ? `Auto → ${modeLabel}` : modeLabel}`);
  console.log(`  Permission: ${[...new Set(payload.participants.map((item) => item.permission_profile))].join(", ")}`);
  console.log(`  Concurrency: ${payload.budget.max_concurrency}`);
  console.log(`  Model: ${payload.participants.some((item) => item.provider) ? "selected routes shown above" : "use each device's default route"}`);
  console.log(`  Budget: ${payload.auto_configuration?.inherited_budget ? "inherit account and device policies" : "explicit limits within account and device policies"}`);
}

function printPlan(run) {
  console.log(`\n${run.plan?.title || "Proposed collaboration plan"}`);
  if (run.plan?.summary) console.log(run.plan.summary);
  for (const [index, task] of (run.plan?.tasks || []).entries()) {
    const dependencies = task.depends_on?.length ? ` after ${task.depends_on.join(", ")}` : "";
    console.log(`  ${index + 1}. [${task.participant_id}] ${task.title} (${task.mode}${dependencies})`);
  }
}

function printRun(run, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  console.log(`${run.run_id}  ${run.state}`);
  console.log(`  ${run.objective || run.plan?.title || "Agent collaboration"}`);
  const tasks = (run.tasks || []).filter((task) => task.task_key !== "__planner__");
  if (tasks.length) {
    const completed = tasks.filter((task) => task.state === "completed").length;
    console.log(`  progress: ${completed}/${tasks.length}`);
  }
  if (run.plan) printPlan(run);
}

const TERMINAL_VIEW_STATES = new Set(["completed", "failed", "cancelled", "expired"]);

function compactNumber(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}k`;
  return String(number);
}

function printAttachSnapshot(snapshot, { participantId = "", taskId = "" } = {}) {
  const run = snapshot.run || {};
  const tasks = (snapshot.tasks || []).filter((task) => (
    task.task_key !== "__planner__"
    && (!participantId || task.participant_id === participantId)
    && (!taskId || task.task_id === taskId || task.task_key === taskId)
  ));
  const completed = tasks.filter((task) => task.state === "completed").length;
  const attention = (snapshot.attention || []).filter((entry) => (
    (!participantId || entry.participant_id === participantId)
    && (!taskId || entry.task_id === taskId)
  ));
  console.log(`\nAgent collaboration · ${run.plan?.title || run.objective || run.run_id}`);
  console.log(`${run.state} · ${completed}/${tasks.length} tasks · ${compactNumber(snapshot.usage?.sampled_tokens)} tokens`);
  if (attention.length) {
    console.log(`Needs attention: ${attention.length}`);
    for (const item of attention) {
      console.log(`  ! ${item.title}`);
      if (item.summary) console.log(`    ${item.summary}`);
      console.log(`    ${item.attention_id} · actions: ${(item.actions || []).join(", ") || "view only"}`);
    }
    console.log(`  Resolve with: originrouter collaboration resolve ${run.run_id} <attention-id> --action <action>`);
  }
  if (tasks.length) {
    console.log("\nTasks");
    for (const task of tasks) {
      const marker = task.state === "completed" ? "✓"
        : task.state === "running" ? "●"
          : task.state === "failed" ? "×"
            : "○";
      console.log(`  ${marker} ${task.title}  [${task.participant_id || "unassigned"}]  ${task.state}`);
    }
  }
}

function printAttachEvent(event, { raw = false, verbose = false, plain = false } = {}) {
  if (raw) {
    console.log(JSON.stringify(event));
    return;
  }
  const created = event.created_at ? new Date(event.created_at) : null;
  const time = created && Number.isFinite(created.getTime())
    ? (plain ? created.toISOString() : created.toLocaleTimeString())
    : "";
  const owner = event.participant_id || event.task_id
    ? ` [${event.participant_id || "run"}${event.task_id ? `/${event.task_id}` : ""}]`
    : "";
  const summary = event.summary || event.type.replaceAll(".", " ");
  if (plain) {
    console.log(`${time} ${String(event.severity || "info").toUpperCase().padEnd(5)} ${String(event.type || "agent.activity").padEnd(24)}${owner} ${summary}`.trimEnd());
  } else {
    console.log(`${time} ${String(event.severity || "info").toUpperCase().padEnd(7)}${owner} ${summary}`.trimEnd());
  }
  if (event.detail && (verbose || event.visibility === "summary")) console.log(`  ${event.detail}`);
}

function printFinalReport(report, { participantId = "", taskId = "" } = {}) {
  if (!report) return;
  const started = report.duration?.started_at ? new Date(report.duration.started_at) : null;
  const finished = report.duration?.finished_at ? new Date(report.duration.finished_at) : null;
  const durationMs = started && finished
    && Number.isFinite(started.getTime()) && Number.isFinite(finished.getTime())
    ? Math.max(0, finished.getTime() - started.getTime())
    : null;
  const durationText = durationMs == null
    ? ""
    : `${Math.floor(durationMs / 60_000)}m ${Math.floor((durationMs % 60_000) / 1000)}s`;
  console.log(`\nCollaboration ${report.outcome || "finished"}${durationText ? ` · ${durationText}` : ""}`);
  if (report.summary) console.log(report.summary);
  console.log("\nResult");
  const completedTasks = (report.completed_tasks || []).filter((task) => (
    (!participantId || task.participant_id === participantId)
    && (!taskId || task.task_id === taskId || task.task_key === taskId)
  ));
  const incompleteTasks = (report.failed_or_skipped_tasks || []).filter((task) => (
    (!participantId || task.participant_id === participantId)
    && (!taskId || task.task_id === taskId || task.task_key === taskId)
  ));
  const contributions = (report.participant_contributions || []).filter((item) => (
    !participantId || item.participant_id === participantId
  ));
  console.log(`  ${completedTasks.length} completed · ${incompleteTasks.length} incomplete`);
  console.log(`  ${contributions.length} Agent${contributions.length === 1 ? "" : "s"}`);
  console.log(`  ${compactNumber(report.usage?.sampled_tokens)} tokens`);
  if (completedTasks.length) {
    console.log("\nMain work completed");
    for (const task of completedTasks) {
      console.log(`  • ${task.title}${task.result ? ` — ${redactDisplayText(task.result, 512).replaceAll("\n", " ")}` : ""}`);
    }
  }
  if (incompleteTasks.length) {
    console.log("\nNot completed");
    for (const task of incompleteTasks) console.log(`  × ${task.title} (${task.state})`);
  }
  if (report.artifacts?.length) {
    console.log("\nArtifacts");
    for (const artifact of report.artifacts) {
      const locator = artifact.locator
        ? redactDisplayText(artifact.locator, 4096).replaceAll("\n", " ")
        : "";
      console.log(`  • ${artifact.display_name || artifact.kind}${locator ? ` — ${locator}` : ""}`);
    }
  }
  if (report.workspace_change_warning) console.log(`\nWarning: ${report.workspace_change_warning}`);
  if (report.recommended_next_actions?.length) {
    console.log("\nRecommended next actions");
    for (const action of report.recommended_next_actions) console.log(`  • ${action}`);
  }
}

async function attachRun(runId, args = [], { signal } = {}) {
  if (!runId) throw new Error("Usage: originrouter collaboration attach <run-id> [--plain|--verbose|--raw] [--participant <id>] [--task <id>]");
  const raw = has(args, "raw");
  const verbose = raw || has(args, "verbose");
  const json = has(args, "json");
  const plain = has(args, "plain") || !output.isTTY;
  const participantId = String(value(args, "participant") || "").trim();
  const taskId = String(value(args, "task") || "").trim();
  if (participantId && !/^[a-z][a-z0-9_-]{0,31}$/.test(participantId)) {
    throw new Error("--participant must be a valid participant id.");
  }
  if (taskId.length > 195) throw new Error("--task is too long.");
  const eventQuery = (cursor) => {
    const query = new URLSearchParams({
      after_sequence: String(cursor),
      limit: "200",
      ...(participantId ? { participant_id: participantId } : {}),
      ...(taskId ? { task_id: taskId } : {}),
    });
    return `/collaboration/local/runs/${encodeURIComponent(runId)}/events?${query}`;
  };
  const interval = Math.max(250, Math.min(10_000, Number(value(args, "interval") || 1000)));
  let stopped = false;
  let connectionFailures = 0;
  let commandInterface = null;
  let commandQueue = Promise.resolve();
  const onInterrupt = () => {
    stopped = true;
    if (!json) console.log("\nDetached. The collaboration continues in the OriginRouter service.");
  };
  const onAbort = () => {
    stopped = true;
    if (!json) console.log("\nInterrupted. Leaving follow mode.");
  };
  if (!signal) process.once("SIGINT", onInterrupt);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    let data = await request(`/collaboration/local/runs/${encodeURIComponent(runId)}/snapshot`, { signal });
    let snapshot = data.snapshot;
    if (json) console.log(JSON.stringify({ type: "snapshot", snapshot }));
    else if (!raw) printAttachSnapshot(snapshot, { participantId, taskId });
    // Render a bounded recent history, then continue from the exact consumed
    // cursor. Never jump straight to the snapshot cursor: events created in
    // the snapshot/page race would otherwise become invisible.
    let cursor = Math.max(0, Number(snapshot.last_sequence || 0) - 50);
    if (TERMINAL_VIEW_STATES.has(snapshot.run?.state)) {
      if (!json && !raw) printFinalReport(snapshot.final_report, { participantId, taskId });
      return snapshot;
    }
    if (!json) {
      console.log("\nFollowing activity. Press Ctrl+C or enter `detach` to leave; the task will keep running.");
      if (input.isTTY && output.isTTY && !raw && !plain) {
        console.log("Enter `help` for pause, resume, retry, attention, and cancel controls.\n");
        commandInterface = createInterface({ input, output });
        commandInterface.on("line", (line) => {
          commandQueue = commandQueue
            .then(async () => {
              const text = String(line || "").trim();
              const [command, ...parts] = text.split(/\s+/);
              if (!command) return;
              if (["q", "quit", "detach"].includes(command)) {
                stopped = true;
                console.log("Detached. The collaboration continues in the OriginRouter service.");
                return;
              }
              if (command === "help") {
                console.log("Controls: attention · pause · resume · retry [task-id] · resolve <attention-id> <action> [reply] · cancel · detach");
                return;
              }
              if (command === "attention") {
                const current = await request(`/collaboration/local/runs/${encodeURIComponent(runId)}/snapshot`);
                printAttachSnapshot(current.snapshot, { participantId, taskId });
                return;
              }
              if (["pause", "resume"].includes(command)) {
                const result = await request(
                  `/collaboration/local/runs/${encodeURIComponent(runId)}/${command}`,
                  { method: "POST", body: {} },
                );
                console.log(`Collaboration ${result.run.state}.`);
                return;
              }
              if (command === "retry") {
                const result = await request(
                  `/collaboration/local/runs/${encodeURIComponent(runId)}/retry`,
                  { method: "POST", body: { task_id: parts[0] || null } },
                );
                console.log(`Retry created: ${result.run.run_id}`);
                return;
              }
              if (command === "resolve") {
                const [attentionId, action, ...replyParts] = parts;
                if (!attentionId || !action) {
                  console.log("Usage: resolve <attention-id> <action> [reply]");
                  return;
                }
                await resolveAttentionCommand(runId, attentionId, [
                  "--action", action,
                  ...(replyParts.length ? ["--text", replyParts.join(" ")] : []),
                ]);
                console.log(`Attention resolved with '${action}'.`);
                return;
              }
              if (command === "cancel") {
                if (parts[0] !== runId) {
                  const current = await request(
                    `/collaboration/local/runs/${encodeURIComponent(runId)}/snapshot`,
                  );
                  const activeTasks = (current.snapshot.tasks || [])
                    .filter((task) => ["running", "dispatching", "active"].includes(task.state));
                  console.log(
                    activeTasks.length
                      ? `Cancellation will request a stop for ${activeTasks.length} active task${activeTasks.length === 1 ? "" : "s"}. Workspace changes already made are not rolled back automatically.`
                      : "Cancellation stops future work. Workspace changes already made are not rolled back automatically.",
                  );
                  console.log(`Cancellation requires confirmation. Enter: cancel ${runId}`);
                  return;
                }
                const result = await request(
                  `/collaboration/local/runs/${encodeURIComponent(runId)}/cancel`,
                  { method: "POST", body: {} },
                );
                console.log(`Collaboration ${result.run.state}.`);
                return;
              }
              console.log(`Unknown control '${command}'. Enter \`help\` to list controls.`);
            })
            .catch((error) => console.error(`Control failed: ${error.message}`));
        });
      } else {
        console.log();
      }
    }
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (stopped) break;
      throwIfAborted(signal);
      try {
        const eventData = await request(
          eventQuery(cursor),
          { signal },
        );
        for (const event of eventData.events || []) {
          cursor = Math.max(cursor, Number(event.sequence || 0));
          const visible = raw
            || event.visibility === "summary"
            || (verbose && event.visibility === "detail");
          if (!visible) continue;
          if (json) console.log(JSON.stringify({ type: "event", event }));
          else printAttachEvent(event, { raw, verbose, plain });
        }
        data = await request(`/collaboration/local/runs/${encodeURIComponent(runId)}/snapshot`, { signal });
        snapshot = data.snapshot;
        if (connectionFailures > 0 && !json) {
          console.log("Connection restored. Snapshot and event cursor are synchronized.");
        }
        connectionFailures = 0;
        if (TERMINAL_VIEW_STATES.has(snapshot.run?.state)) {
          if (json) console.log(JSON.stringify({ type: "final", snapshot }));
          else if (!raw) printFinalReport(snapshot.final_report, { participantId, taskId });
          return snapshot;
        }
      } catch (error) {
        connectionFailures += 1;
        if (connectionFailures === 1 && !json) {
          console.error(`Connection to the local OriginRouter service was interrupted: ${error.message}`);
        }
        if (connectionFailures >= 30) {
          throw new Error("Could not reconnect to the local OriginRouter service after 30 attempts. The collaboration may still be running.");
        }
      }
    }
    return snapshot;
  } finally {
    commandInterface?.close();
    await commandQueue.catch(() => {});
    if (!signal) process.removeListener("SIGINT", onInterrupt);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function waitForPlan(runId, timeoutSeconds, { signal } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let run;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    run = (await request(`/collaboration/local/runs/${encodeURIComponent(runId)}`, { signal })).run;
    if (!["created", "designing", "researching", "decomposing", "planning"].includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return run;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(interruptedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(interruptedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function trustCollaborationWorkspace(deviceId, path, {
  signal,
  requestFn = request,
} = {}) {
  const data = await requestFn(
    `/collaboration/devices/${encodeURIComponent(deviceId)}/workspaces/trust`,
    { method: "POST", body: { path }, signal },
  );
  return data.workspace;
}

export async function browseCollaborationWorkspaces(deviceId, path, {
  signal,
  limit = 8,
  requestFn = request,
} = {}) {
  const query = new URLSearchParams({
    path: String(path || ""),
    limit: String(Math.max(1, Math.min(20, Number(limit) || 8))),
  });
  return requestFn(
    `/collaboration/devices/${encodeURIComponent(deviceId)}/workspaces/browse?${query}`,
    { signal },
  );
}

function isRetryableCollaborationReadError(error) {
  const code = String(error?.diagnosticCode || error?.code || "").toUpperCase();
  const message = String(error?.message || "").toUpperCase();
  return /LOCAL_API_CONNECTION_FAILED|TIMEOUT|CONNECTION|RELAY|UNAVAILABLE|ECONN|ETIMEDOUT/.test(`${code} ${message}`);
}

export async function controlCollaborationRun(runId, action, { signal, body = {} } = {}) {
  if (!new Set(["start", "confirm", "pause", "resume", "cancel", "retry"]).has(action)) {
    throw new Error(`Unsupported collaboration control '${action}'.`);
  }
  return (await request(
    `/collaboration/local/runs/${encodeURIComponent(runId)}/${action}`,
    { method: "POST", body, signal },
  )).run;
}

async function followAgentWorkspaceCollaboration({
  run,
  payload = {},
  confirmation = "never",
  signal,
  onUpdate = () => {},
  onPlanConfirmation = async () => "leave",
  onAttention = async () => "leave",
  onPaused = async () => "leave",
  interval = 300,
  requestFn = request,
}) {
  let cursor = 0;
  let confirmationHandled = false;
  const handledAttention = new Set();
  let pauseHandledRevision = -1;
  let reconnectAttempts = 0;
  const readSnapshot = async (path) => {
    while (true) {
      throwIfAborted(signal);
      try {
        const result = await requestFn(path, { signal });
        if (reconnectAttempts > 0) {
          reconnectAttempts = 0;
          onUpdate({ type: "connection", connectionAttempts: 0, message: "" });
        }
        return result;
      } catch (error) {
        if (!isRetryableCollaborationReadError(error) || reconnectAttempts >= 30) throw error;
        reconnectAttempts += 1;
        onUpdate({ type: "connection", phase: "reconnecting", connectionAttempts: reconnectAttempts, message: `Connection interrupted; retry ${reconnectAttempts}/30` });
        await abortableDelay(Math.min(5000, 500 + reconnectAttempts * 250), signal);
      }
    }
  };
  while (true) {
    throwIfAborted(signal);
    const snapshot = (await readSnapshot(`/collaboration/local/runs/${encodeURIComponent(run.run_id)}/snapshot`)).snapshot;
    if (cursor === 0) cursor = Math.max(0, Number(snapshot.last_sequence || 0) - 30);
    const eventData = await readSnapshot(`/collaboration/local/runs/${encodeURIComponent(run.run_id)}/events?after_sequence=${cursor}&limit=200`);
    const events = eventData.events || [];
    for (const event of events) cursor = Math.max(cursor, Number(event.sequence || 0));
    onUpdate({ type: "snapshot", snapshot, events });
    const state = snapshot.run?.state;
    if (TERMINAL_VIEW_STATES.has(state)) return snapshot;
    if (state === "paused" && pauseHandledRevision !== Number(snapshot.revision || 0)) {
      pauseHandledRevision = Number(snapshot.revision || 0);
      const decision = await onPaused(snapshot);
      throwIfAborted(signal);
      if (decision === "resume") {
        run = (await requestFn(
          `/collaboration/local/runs/${encodeURIComponent(run.run_id)}/resume`,
          { method: "POST", body: {}, signal },
        )).run;
        onUpdate({ type: "phase", phase: "executing", run });
        continue;
      }
      return snapshot;
    }
    const attention = (snapshot.attention || []).find((item) => (
      item.status === "pending"
      && item.kind !== "plan_confirmation"
      && !handledAttention.has(`${item.attention_id}:${item.revision}`)
    ));
    if (attention) {
      const attentionKey = `${attention.attention_id}:${attention.revision}`;
      handledAttention.add(attentionKey);
      const decision = await onAttention(attention, snapshot);
      throwIfAborted(signal);
      if (!decision || decision === "leave") return snapshot;
      await requestFn(
        `/collaboration/local/runs/${encodeURIComponent(run.run_id)}/attention/${encodeURIComponent(attention.attention_id)}/resolve`,
        {
          method: "POST",
          body: {
            expected_revision: attention.revision,
            action: decision.action,
            response: decision.response || {},
          },
          signal,
        },
      );
      continue;
    }
    if (state === "awaiting_confirmation" && !confirmationHandled) {
      confirmationHandled = true;
      const safeToSkip = payload.auto_configuration?.safe_to_skip_confirmation === true;
      const decision = confirmation === "always" || (confirmation === "safe" && safeToSkip)
        ? "confirm"
        : await onPlanConfirmation(snapshot);
      throwIfAborted(signal);
      if (decision === "confirm") {
        run = (await requestFn(`/collaboration/local/runs/${encodeURIComponent(run.run_id)}/confirm`, { method: "POST", body: {}, signal })).run;
        onUpdate({ type: "phase", phase: "executing", run });
        continue;
      }
      if (decision?.action === "revise" && String(decision.feedback || "").trim()) {
        run = (await requestFn(`/collaboration/local/runs/${encodeURIComponent(run.run_id)}/replan`, { method: "POST", body: { feedback: String(decision.feedback).trim() }, signal })).run;
        confirmationHandled = false;
        onUpdate({ type: "phase", phase: "planning", run });
        continue;
      }
      return snapshot;
    }
    await abortableDelay(Math.max(250, Math.min(5000, Number(interval) || 750)), signal);
  }
}

export async function retryAgentWorkspaceCollaboration(runId, {
  signal,
  onUpdate = () => {},
  onPlanConfirmation = async () => "leave",
  onAttention = async () => "leave",
  onPaused = async () => "leave",
  interval = 300,
  requestFn = request,
} = {}) {
  const run = (await requestFn(
    `/collaboration/local/runs/${encodeURIComponent(runId)}/retry`,
    { method: "POST", body: {}, signal },
  )).run;
  onUpdate({ type: "phase", phase: "planning", run });
  return followAgentWorkspaceCollaboration({
    run,
    confirmation: "never",
    signal,
    onUpdate,
    onPlanConfirmation,
    onAttention,
    onPaused,
    interval,
    requestFn,
  });
}

export async function runAgentWorkspaceCollaboration({
  objective,
  workspaceMode = "auto",
  coordinator = "codex",
  cloudAdvice = true,
  confirmation = "safe",
  signal,
  onUpdate = () => {},
  onRunId = () => {},
  onConfigurationConfirmation = async () => "leave",
  onPlanConfirmation = async () => "leave",
  onAttention = async () => "leave",
  onPaused = async () => "leave",
  // Keep the interactive workspace responsive while still coalescing redraws
  // in the TUI frame scheduler. The local API remains cursor-based, so this
  // does not duplicate events.
  interval = 300,
  requestFn = request,
  automaticCreatePayloadFn = automaticCreatePayload,
  workspaceSelections = {},
} = {}) {
  throwIfAborted(signal);
  onUpdate({ type: "phase", phase: "configuring" });
  const payload = await automaticCreatePayloadFn({
    objective,
    workspaceMode,
    coordinator,
    cloudAdvice,
    requestFn,
    workspaceSelections,
  });
  throwIfAborted(signal);
  onUpdate({ type: "configuration", payload });
  const configurationSafe = payload.auto_configuration?.safe_to_skip_confirmation === true
    && payload.planning_source !== "local_fallback";
  if (confirmation !== "always" && (confirmation === "never" || !configurationSafe)) {
    const decision = await onConfigurationConfirmation(payload);
    throwIfAborted(signal);
    if (decision !== "confirm") {
      return {
        run: { state: "configuration_pending" },
        tasks: [],
        participants: payload.participants || [],
        configuration: payload,
      };
    }
  }

  let run = (await requestFn("/collaboration/local/runs", {
    method: "POST",
    body: payload,
    signal,
  })).run;
  onRunId(run.run_id);
  onUpdate({ type: "run", run });
  run = (await requestFn(
    `/collaboration/local/runs/${encodeURIComponent(run.run_id)}/start`,
    { method: "POST", body: {}, signal },
  )).run;
  onRunId(run.run_id);
  onUpdate({ type: "phase", phase: "planning", run });
  return followAgentWorkspaceCollaboration({
    run,
    payload,
    confirmation,
    signal,
    onUpdate,
    onPlanConfirmation,
    onAttention,
    onPaused,
    interval,
    requestFn,
  });
}

async function confirmInteractively(run, args) {
  if (has(args, "yes")) return { action: "confirm", feedback: "" };
  if (!input.isTTY || !output.isTTY) return { action: "leave", feedback: "" };
  const prompt = createInterface({ input, output });
  try {
    const answer = (await prompt.question(
      "Confirm this plan? [Y] start  [E] request changes  [N] leave pending: ",
    )).trim().toLowerCase();
    if (["", "y", "yes"].includes(answer)) return { action: "confirm", feedback: "" };
    if (["e", "edit", "revise"].includes(answer)) {
      return {
        action: "revise",
        feedback: await askRequired(prompt, "What should the Planner change?"),
      };
    }
    return { action: "leave", feedback: "" };
  } finally {
    prompt.close();
  }
}

async function exportRun(runId, format = "json") {
  const snapshot = (await request(
    `/collaboration/local/runs/${encodeURIComponent(runId)}/snapshot`,
  )).snapshot;
  const events = [];
  let cursor = 0;
  while (true) {
    const page = await request(
      `/collaboration/local/runs/${encodeURIComponent(runId)}/events?after_sequence=${cursor}&limit=200`,
    );
    events.push(...(page.events || []));
    const next = Number(page.next_sequence || cursor);
    if (!page.has_more || next <= cursor) break;
    cursor = next;
  }
  if (format === "json") {
    console.log(JSON.stringify(redactDisplayValue({
      schema_version: 1,
      snapshot,
      events,
    }, { maxStringLength: 16_384, maxArrayLength: 10_000, maxObjectEntries: 256 }), null, 2));
    return;
  }
  if (format !== "markdown") throw new Error("--format must be json or markdown");
  const run = snapshot.run || {};
  const lines = [
    `# ${run.plan?.title || run.objective || "Agent collaboration"}`,
    "",
    `- Run: \`${run.run_id}\``,
    `- State: ${run.state}`,
    `- Started: ${run.started_at || "Not started"}`,
    `- Finished: ${run.finished_at || "Not finished"}`,
    `- Tokens: ${snapshot.usage?.sampled_tokens || 0}`,
    "",
    "## Objective",
    "",
    redactDisplayText(run.objective || "", 16_384),
    "",
    "## Tasks",
    "",
    ...(snapshot.tasks || []).filter((task) => task.task_key !== "__planner__").map((task) => (
      `- **${redactDisplayText(task.title, 1024)}** — ${task.state} — ${task.participant_id || "unassigned"}${task.result_summary ? `\n  - ${redactDisplayText(task.result_summary, 16_384).replaceAll("\n", " ")}` : ""}`
    )),
    "",
    "## Timeline",
    "",
    ...events.filter((event) => event.visibility !== "audit_only").map((event) => (
      `- ${event.created_at || ""} — **${event.type}**${event.participant_id ? ` (${event.participant_id})` : ""}: ${redactDisplayText(event.summary || "", 4096)}`
    )),
  ];
  if (snapshot.final_report) {
    lines.push("", "## Final report", "", redactDisplayText(snapshot.final_report.summary || "", 16_384));
  }
  console.log(lines.join("\n"));
}

async function resolveAttentionCommand(runId, attentionId, args) {
  if (!runId || !attentionId) {
    throw new Error("Usage: originrouter collaboration resolve <run-id> <attention-id> --action <action> [--text <reply>]");
  }
  const snapshot = (await request(
    `/collaboration/local/runs/${encodeURIComponent(runId)}/snapshot`,
  )).snapshot;
  const item = (snapshot.attention || [])
    .find((candidate) => candidate.attention_id === attentionId);
  if (!item) throw new Error("The attention item is no longer pending. Refresh the collaboration.");
  const action = String(value(args, "action") || "").trim();
  if (!action) throw new Error(`Choose one action: ${(item.actions || []).join(", ")}`);
  if (!(item.actions || []).includes(action)) {
    throw new Error(`Unsupported action '${action}'. Choose: ${(item.actions || []).join(", ")}`);
  }
  if (String(attentionId).startsWith("derived:")) {
    if (item.kind === "plan_confirmation" && action === "confirm") {
      return (await request(
        `/collaboration/local/runs/${encodeURIComponent(runId)}/confirm`,
        { method: "POST", body: {} },
      )).run;
    }
    if (item.kind === "plan_confirmation" && action === "revise") {
      let feedback = String(value(args, "text") || value(args, "feedback") || "").trim();
      if (!feedback && input.isTTY && output.isTTY) {
        const prompt = createInterface({ input, output });
        try {
          feedback = await askRequired(prompt, "What should the Planner change?");
        } finally {
          prompt.close();
        }
      }
      if (!feedback) throw new Error("Plan revision requires --text <feedback>.");
      return (await request(
        `/collaboration/local/runs/${encodeURIComponent(runId)}/replan`,
        { method: "POST", body: { feedback } },
      )).run;
    }
    if (action === "cancel") {
      return (await request(
        `/collaboration/local/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST", body: {} },
      )).run;
    }
    throw new Error(
      action === "view_budget"
        ? `View or change this run's budget in the App, then run: originrouter collaboration resume ${runId}`
        : `The derived attention action '${action}' is not available from this CLI version.`,
    );
  }
  let reply = String(value(args, "text") || "").trim();
  if (item.kind === "input" && action === "submit" && !reply && input.isTTY && output.isTTY) {
    const prompt = createInterface({ input, output });
    try {
      reply = await askRequired(prompt, "Reply to the Agent");
    } finally {
      prompt.close();
    }
  }
  if (item.kind === "input" && action === "submit" && !reply) {
    throw new Error("This input request requires --text <reply>.");
  }
  await request(
    `/collaboration/local/runs/${encodeURIComponent(runId)}/attention/${encodeURIComponent(attentionId)}/resolve`,
    {
      method: "POST",
      body: {
        expected_revision: item.revision,
        action,
        response: reply ? { text: reply } : {},
      },
    },
  );
  return (await request(
    `/collaboration/local/runs/${encodeURIComponent(runId)}`,
  )).run;
}

async function printDiagnostics(runId, { json = false } = {}) {
  if (!runId) throw new Error("Usage: originrouter collaboration doctor <run-id> [--json]");
  const diagnostics = (await request(
    `/collaboration/local/runs/${encodeURIComponent(runId)}/diagnostics`,
  )).diagnostics;
  if (json) {
    console.log(JSON.stringify(diagnostics, null, 2));
    return;
  }
  const run = diagnostics.run || {};
  const counts = diagnostics.counts || {};
  console.log(`Collaboration diagnostics · ${run.run_id}`);
  console.log(`  state: ${run.state} · revision ${run.revision} · database ${diagnostics.database_integrity}`);
  console.log(`  participants: ${counts.participants || 0} · tasks: ${counts.tasks || 0} · pending attention: ${counts.pending_attention || 0}`);
  console.log(`  events: ${counts.events || 0} · artifacts: ${counts.artifacts || 0} · pending deliveries: ${counts.pending_outbox || 0}`);
  if ((diagnostics.recent_warnings_and_errors || []).length) {
    console.log("\nRecent warnings and errors");
    for (const event of diagnostics.recent_warnings_and_errors) {
      console.log(`  ${event.created_at} · ${event.type}${event.diagnostic_code ? ` · ${event.diagnostic_code}` : ""}`);
    }
  } else {
    console.log("\nNo warning or error events were recorded for this run.");
  }
  console.log("\nThis report excludes prompts, result content, credentials, and raw environment data.");
}

async function handleCollaborationCommandImpl(args, options = {}) {
  const [action = "list", ...rest] = args;
  const json = has(args, "json");
  if (action === "templates") {
    if (json) console.log(JSON.stringify(BUILTIN_COLLABORATION_TEMPLATES, null, 2));
    else for (const item of BUILTIN_COLLABORATION_TEMPLATES) console.log(`${item.id}\n  ${item.description}`);
    return;
  }
  if (action === "list") {
    const category = value(args, "category") || "all";
    if (!["all", "attention", "active", "recent"].includes(category)) {
      throw new Error("--category must be all, attention, active, or recent.");
    }
    const page = parseInteger(value(args, "page"), {
      min: 1,
      max: 1_000_000,
      fallback: 1,
    });
    const pageSize = parseInteger(value(args, "page-size"), {
      min: 1,
      max: 50,
      fallback: 5,
    });
    const query = new URLSearchParams({
      category,
      page: String(page),
      page_size: String(pageSize),
      ...(has(args, "archived") ? { archived: "true" } : {}),
    });
    const data = await request(`/collaboration/local/runs?${query}`);
    if (json) {
      console.log(JSON.stringify({
        schema_version: 2,
        category,
        page: data.page,
        page_size: data.page_size,
        total: data.total,
        total_pages: data.total_pages,
        runs: data.runs || [],
      }, null, 2));
    }
    else if (!(data.runs || []).length) console.log("No Agent collaborations yet.");
    else {
      console.log(`${category} collaborations · page ${data.page}/${data.total_pages} · ${data.total} total`);
      for (const run of data.runs) printRun(run);
      if (data.page < data.total_pages) {
        console.log(`\nNext page: originrouter collaboration list --category ${category} --page ${data.page + 1} --page-size ${data.page_size}`);
      }
    }
    return;
  }
  if (action === "drafts") {
    const drafts = listCollaborationDrafts();
    if (json) console.log(JSON.stringify(drafts, null, 2));
    else if (!drafts.length) console.log("No saved collaboration drafts.");
    else for (const draft of drafts) {
      console.log(`${draft.draft_id}  step ${draft.step}/7  ${draft.updated_at}`);
      console.log(`  ${draft.objective || "No objective entered yet"}`);
    }
    return;
  }
  if (action === "draft") {
    const [draftAction = "list", draftId, ...draftArgs] = rest;
    if (draftAction === "list") {
      return handleCollaborationCommand(["drafts", ...draftArgs]);
    }
    if (!draftId) {
      throw new Error("Usage: originrouter collaboration draft show|resume|delete <draft-id>");
    }
    const draft = getCollaborationDraft(draftId);
    if (!draft) throw new Error(`Collaboration draft '${draftId}' was not found.`);
    if (draftAction === "show") {
      if (json || has(draftArgs, "json")) console.log(JSON.stringify(draft, null, 2));
      else {
        console.log(`${draft.draft_id}  step ${draft.step}/7  ${draft.updated_at}`);
        console.log(`  ${draft.objective || "No objective entered yet"}`);
        console.log(`  ${draft.participants.length} configured participant${draft.participants.length === 1 ? "" : "s"}`);
      }
      return;
    }
    if (draftAction === "delete") {
      deleteCollaborationDraft(draftId);
      console.log(`Deleted collaboration draft ${draftId}.`);
      return;
    }
    if (draftAction === "resume") {
      return handleCollaborationCommand(["create", "--draft", draftId, ...draftArgs]);
    }
    throw new Error("Usage: originrouter collaboration draft show|resume|delete <draft-id>");
  }
  if (action === "show") {
    const runId = rest[0];
    if (!runId) throw new Error("Usage: originrouter collaboration show <run-id> [--json]");
    printRun((await request(`/collaboration/local/runs/${encodeURIComponent(runId)}`)).run, { json });
    return;
  }
  if (action === "attach") {
    const snapshot = await attachRun(rest[0], args, { signal: options.signal });
    if (snapshot?.run?.state === "failed") process.exitCode = 6;
    if (snapshot?.run?.state === "budget_exhausted") process.exitCode = 7;
    return;
  }
  if (action === "attention") {
    const runId = rest[0];
    if (!runId) throw new Error("Usage: originrouter collaboration attention <run-id>");
    const snapshot = (await request(
      `/collaboration/local/runs/${encodeURIComponent(runId)}/snapshot`,
    )).snapshot;
    printAttachSnapshot(snapshot);
    return;
  }
  if (action === "resolve") {
    const run = await resolveAttentionCommand(rest[0], rest[1], args);
    printRun(run, { json });
    return;
  }
  if (action === "doctor") {
    await printDiagnostics(rest[0], { json });
    return;
  }
  if (["start", "confirm", "pause", "resume", "cancel"].includes(action)) {
    const runId = rest[0];
    if (!runId) throw new Error(`Usage: originrouter collaboration ${action} <run-id>`);
    const run = (await request(`/collaboration/local/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST", body: {} })).run;
    printRun(run, { json });
    return;
  }
  if (action === "revise") {
    const runId = rest[0];
    if (!runId) throw new Error("Usage: originrouter collaboration revise <run-id> [--feedback <text>]");
    let feedback = value(args, "feedback") || "";
    if (!feedback && input.isTTY && output.isTTY) {
      const prompt = createInterface({ input, output });
      try {
        feedback = await askRequired(prompt, "What should the Planner change?");
      } finally {
        prompt.close();
      }
    }
    if (!feedback.trim()) {
      throw new Error("Plan revision feedback is required. Pass --feedback <text>.");
    }
    const run = (await request(
      `/collaboration/local/runs/${encodeURIComponent(runId)}/replan`,
      { method: "POST", body: { feedback: feedback.trim() } },
    )).run;
    printRun(run, { json });
    if (!has(args, "detach") && !json) await attachRun(run.run_id, args, { signal: options.signal });
    return;
  }
  if (action === "retry") {
    const runId = rest[0];
    if (!runId) throw new Error("Usage: originrouter collaboration retry <run-id> [--task <task-id>]");
    const run = (await request(
      `/collaboration/local/runs/${encodeURIComponent(runId)}/retry`,
      { method: "POST", body: { task_id: value(args, "task") || null } },
    )).run;
    printRun(run, { json });
    if (!has(args, "detach") && !json) await attachRun(run.run_id, args, { signal: options.signal });
    return;
  }
  if (action === "archive") {
    const runId = rest[0];
    if (!runId) throw new Error("Usage: originrouter collaboration archive <run-id>");
    const run = (await request(
      `/collaboration/local/runs/${encodeURIComponent(runId)}/archive`,
      { method: "POST", body: {} },
    )).run;
    printRun(run, { json });
    return;
  }
  if (action === "delete") {
    const runId = rest[0];
    if (!runId) throw new Error("Usage: originrouter collaboration delete <run-id> [--yes]");
    if (!has(args, "yes") && input.isTTY && output.isTTY) {
      const prompt = createInterface({ input, output });
      try {
        if (!(await confirm(prompt, `Permanently delete ${runId}?`, false))) {
          console.log("Delete cancelled.");
          return;
        }
      } finally {
        prompt.close();
      }
    } else if (!has(args, "yes")) {
      throw new Error("Non-interactive delete requires --yes.");
    }
    await request(`/collaboration/local/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    if (json) console.log(JSON.stringify({ deleted: true, run_id: runId }));
    else console.log(`Deleted ${runId}.`);
    return;
  }
  if (action === "export") {
    const runId = rest[0];
    if (!runId) throw new Error("Usage: originrouter collaboration export <run-id> [--format json|markdown]");
    await exportRun(runId, value(args, "format") || "json");
    return;
  }
  if (action === "create") {
    const draftId = value(args, "draft");
    const initialDraft = draftId ? getCollaborationDraft(draftId) : null;
    if (draftId && !initialDraft) {
      throw new Error(`Collaboration draft '${draftId}' was not found.`);
    }
    const objective = positionalObjective(rest) || value(args, "objective") || "";
    const workspaceMode = value(args, "workspace-mode");
    const cloudAdvice = has(args, "cloud-advice");
    const coordinator = value(args, "coordinator") || "codex";
    if (workspaceMode) normalizeWorkspaceMode(workspaceMode);
    normalizeCoordinator(coordinator);
    const scripted = value(args, "spec") || values(args, "participant").length > 0;
    let payload;
    if (scripted) {
      payload = createPayload(
        positionalObjective(rest) && !value(args, "objective")
          ? [...args, "--objective", positionalObjective(rest)]
          : args,
      );
    } else if (objective) {
      let prompt = null;
      const ownsPrompt = input.isTTY && output.isTTY;
      if (ownsPrompt) prompt = createInterface({ input, output });
      try {
        payload = await automaticCreatePayload({
          objective,
          prompt,
          workspaceMode,
          coordinator,
          cloudAdvice,
        });
        if (!json) printAutoConfiguration(payload);
        const configurationConfirmationRequired = has(args, "review")
          || (!workspaceMode && !payload.auto_configuration?.safe_to_skip_confirmation);
        if (configurationConfirmationRequired) {
          if (!prompt) {
            throw new Error("The generated configuration requires explicit interactive confirmation.");
          }
          if (!(await confirm(prompt, "Use this collaboration configuration?", true))) {
            console.log("Configuration not accepted. Opening the full setup wizard with the objective prefilled.");
            payload = await interactiveCreatePayload({
              prompt,
              initialDraft: { wizard_sequence_version: 2, step: 2, objective },
            });
          }
        }
      } catch (error) {
        if (error?.code === "AUTO_CONFIG_WORKSPACE_AMBIGUOUS" && !prompt) throw error;
        if (!ownsPrompt || json) {
          const wrapped = new Error(`${error.message} Automatic configuration stopped safely; run originrouter collaborate to use the full wizard.`);
          wrapped.code = error.code || "AUTO_CONFIG_FAILED";
          throw wrapped;
        }
        console.log(`\nAutomatic configuration unavailable: ${error.message}`);
        console.log("Opening the full setup wizard with the objective prefilled.\n");
        payload = await interactiveCreatePayload({
          prompt,
          initialDraft: { wizard_sequence_version: 2, step: 2, objective },
        });
      } finally {
        prompt?.close();
      }
    } else {
      payload = await interactiveCreatePayload({ initialDraft });
    }
    throwIfAborted(options.signal);
    let run = (await request("/collaboration/local/runs", { method: "POST", body: payload, signal: options.signal })).run;
    options.onRunId?.(run.run_id);
    run = (await request(`/collaboration/local/runs/${encodeURIComponent(run.run_id)}/start`, { method: "POST", body: {}, signal: options.signal })).run;
    options.onRunId?.(run.run_id);
    if (has(args, "no-wait")) {
      printRun(run, { json });
      return;
    }
    const timeout = Math.max(30, Math.min(900, Number(value(args, "timeout") || 300)));
    if (!json) console.log(`Planner is preparing a collaboration plan (${run.run_id})…`);
    run = await waitForPlan(run.run_id, timeout, { signal: options.signal });
    if (!run || run.state !== "awaiting_plan_confirmation") {
      printRun(run || { run_id: payload.run_id || "", state: "unknown", objective: payload.objective }, { json });
      if (run?.state === "failed") process.exitCode = 6;
      if (run?.state === "budget_exhausted") process.exitCode = 7;
      if (run?.state !== "failed" && !json) console.log(`\nThe Planner is still working. Check later with: originrouter collaboration show ${run?.run_id || "<run-id>"}`);
      return;
    }
    if (json) {
      if (has(args, "yes") && !has(args, "review")) {
        const confirmed = (await request(`/collaboration/local/runs/${encodeURIComponent(run.run_id)}/confirm`, { method: "POST", body: {}, signal: options.signal })).run;
        printRun(confirmed, { json: true });
      } else {
        printRun(run, { json: true });
        if (!input.isTTY || !output.isTTY) process.exitCode = 8;
      }
      return;
    }
    printRun(run);
    let decision = await confirmInteractively(run, args);
    while (decision.action === "revise") {
      run = (await request(
        `/collaboration/local/runs/${encodeURIComponent(run.run_id)}/replan`,
        { method: "POST", body: { feedback: decision.feedback } },
      )).run;
      console.log("\nPlanner is revising the collaboration plan…");
      run = await waitForPlan(run.run_id, timeout, { signal: options.signal });
      if (!run || run.state !== "awaiting_plan_confirmation") {
        printRun(run || { run_id: "", state: "unknown", objective: payload.objective });
        if (run?.state === "failed") process.exitCode = 6;
        if (run?.state === "budget_exhausted") process.exitCode = 7;
        console.log(`\nThe Planner is still working. Check later with: originrouter collaboration show ${run?.run_id || "<run-id>"}`);
        return;
      }
      printRun(run);
      decision = await confirmInteractively(run, args);
    }
    if (decision.action === "confirm") {
      const confirmed = (await request(`/collaboration/local/runs/${encodeURIComponent(run.run_id)}/confirm`, { method: "POST", body: {}, signal: options.signal })).run;
      console.log(`\nCollaboration started: ${confirmed.run_id}`);
      if (!has(args, "detach")) await attachRun(confirmed.run_id, args, { signal: options.signal });
    } else {
      console.log(`\nThe plan has not started. Review it, then run: originrouter collaboration confirm ${run.run_id}`);
      if (!input.isTTY || !output.isTTY) process.exitCode = 8;
    }
    return;
  }
  throw new Error("Usage: originrouter collaboration templates|list|drafts|draft|show|attach|attention|resolve|doctor|create|start|confirm|revise|pause|resume|retry|cancel|archive|delete|export");
}

export async function handleCollaborationCommand(args, options = {}) {
  try {
    return await handleCollaborationCommandImpl(args, options);
  } catch (error) {
    if (error?.code === "ORIGINROUTER_INTERRUPTED") throw error;
    if (error instanceof CollaborationCliError) throw error;
    const message = String(error?.message || error || "Collaboration command failed.");
    const invalidInput = /(^Usage:|missing |must |required|invalid|unsupported|duplicate|enter a |add at least|not found)/i.test(message);
    const trustIssue = /trust|permission|identity|E2EE/i.test(message);
    const capabilityIssue = /no available choices|runtime|provider|model|route/i.test(message);
    throw new CollaborationCliError(message, {
      exitCode: trustIssue ? 4 : capabilityIssue ? 5 : invalidInput ? 2 : 1,
      diagnosticCode: trustIssue
        ? "COLLABORATION_TRUST_OR_PERMISSION_REQUIRED"
        : capabilityIssue
          ? "COLLABORATION_CAPABILITY_UNAVAILABLE"
          : invalidInput
            ? "COLLABORATION_INVALID_INPUT"
            : "COLLABORATION_COMMAND_FAILED",
      impact: "The collaboration command stopped before completing the requested operation.",
      action: invalidInput
        ? "Review `originrouter --help` and correct the command or saved draft."
        : trustIssue
          ? "Verify device identity, workspace trust, and the selected permission profile."
          : capabilityIssue
            ? "Run `originrouter doctor` on the selected device and verify its Agent route."
            : "Run the collaboration doctor for an existing Run, or retry after checking the local service.",
      cause: error,
    });
  }
}
