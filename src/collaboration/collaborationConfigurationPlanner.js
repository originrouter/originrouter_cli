import { publicCapabilitySnapshot, validateAndNormalizeAutoConfiguration } from "./collaborationAutoConfig.js";
import { CollaborationConfigurationClient } from "./collaborationConfigurationClient.js";
import { normalizeCollaborationCreateRequest } from "./createRunRequest.js";
import { buildLocalWorkspaceConfiguration, normalizeCoordinator } from "./workspaceModes.js";

const POLICY = Object.freeze({
  server_plans_only: true,
  target_cli_validates_and_creates_run: true,
  read_only_tools_only: true,
  no_secrets: true,
});
const READY_STATES = new Set(["proposal_ready", "fallback_ready"]);
const ALLOWED_TOOLS = new Set(["get_device_capabilities", "get_workspace_details", "get_budget_status"]);

function text(value, maximum = 16_000) { return String(value ?? "").trim().slice(0, maximum); }
function configurationError(code, message) { return Object.assign(new Error(message), { code }); }

// The server owns multi-turn model context. This target CLI retains the only
// authority to inspect local facts, run read-only probes, validate, and create a Run.
export class CollaborationConfigurationPlanner {
  constructor({ store, coordinator, capabilitiesForDevice, deviceId = "local", stateDir, serverClient } = {}) {
    this.store = store;
    this.coordinator = coordinator;
    this.capabilitiesForDevice = capabilitiesForDevice;
    this.deviceId = deviceId;
    this.serverClient = serverClient || new CollaborationConfigurationClient({ stateDir });
  }

  async create(input = {}) {
    const objective = text(input.objective);
    if (!objective) throw configurationError("CONFIGURATION_OBJECTIVE_REQUIRED", "A collaboration objective is required.");
    const runtime = normalizeCoordinator(input.coordinator_runtime || input.coordinatorRuntime || "codex");
    const devices = await this.collectDevices(input);
    const session = this.store.createConfigurationSession({
      objective,
      coordinator_device_id: this.deviceId,
      coordinator_runtime: runtime,
      request: this.safeHints(input),
      capability_snapshot: publicCapabilitySnapshot(devices),
    });
    try {
      const remote = await this.serverClient.create({
        protocol_version: "1",
        idempotency_key: session.configuration_id,
        objective,
        coordinator_runtime: runtime,
        request: this.safeHints(input),
        capability_snapshot: session.capability_snapshot,
        policy: POLICY,
      });
      await this.consumeRemote(session.configuration_id, remote, devices);
    } catch (error) {
      await this.fallback(session.configuration_id, devices, error);
    }
    return this.local(session.configuration_id);
  }

  async get(configurationId, { refresh = true } = {}) {
    let session = this.local(configurationId);
    if (!refresh || !session.server_configuration_id || ["fallback_ready", "failed", "consumed", "cancelled"].includes(session.state)) return session;
    try {
      await this.consumeRemote(configurationId, await this.serverClient.get(session.server_configuration_id));
    } catch (error) {
      if (["planning", "awaiting_tool"].includes(session.state)) await this.fallback(configurationId, await this.liveDevices(session), error);
    }
    return this.local(configurationId);
  }

  async answer(configurationId, answers = {}) {
    const session = await this.get(configurationId, { refresh: false });
    if (session.state !== "awaiting_input" || !session.server_configuration_id) {
      throw configurationError("CONFIGURATION_NOT_AWAITING_INPUT", "This configuration is not waiting for user input.");
    }
    try {
      const remote = await this.serverClient.answer(session.server_configuration_id, {
        expected_revision: session.server_revision,
        answers: this.validateAnswers(session, answers),
      });
      await this.consumeRemote(configurationId, remote);
    } catch (error) {
      await this.fallback(configurationId, await this.liveDevices(session), error);
    }
    return this.local(configurationId);
  }

  async accept(configurationId) {
    const session = await this.get(configurationId);
    if (!READY_STATES.has(session.state) || !session.proposal) {
      throw configurationError("CONFIGURATION_NOT_READY", "The collaboration configuration is not ready for confirmation.");
    }
    const proposal = session.state === "proposal_ready"
      ? await this.validateServerProposal(session, session.server_proposal)
      : session.proposal;
    const run = this.coordinator.create(normalizeCollaborationCreateRequest({
      ...proposal,
      workspace_mode: "auto",
      planning_source: session.state === "fallback_ready" ? "local_fallback" : "server_model",
      coordinator_runtime: session.coordinator_runtime,
    }, { coordinatorDeviceId: this.deviceId }));
    this.store.updateConfigurationSession(configurationId, { state: "consumed", proposal });
    return { run, configuration: this.local(configurationId) };
  }

  async cancel(configurationId) {
    const session = this.local(configurationId);
    if (session.server_configuration_id && !["consumed", "cancelled"].includes(session.state)) {
      try {
        this.applyRemote(configurationId, await this.serverClient.cancel(session.server_configuration_id, {
          expected_revision: session.server_revision,
        }));
      } catch { /* Local cancellation remains authoritative for this CLI. */ }
    }
    if (!["consumed", "cancelled"].includes(this.local(configurationId).state)) {
      this.store.updateConfigurationSession(configurationId, { state: "cancelled" });
    }
    return this.local(configurationId);
  }

  local(configurationId) {
    const session = this.store.getConfigurationSession(configurationId);
    if (!session) throw configurationError("CONFIGURATION_NOT_FOUND", "Collaboration configuration session was not found.");
    return session;
  }

  safeHints(input = {}) {
    return {
      workspace_mode: text(input.workspace_mode || input.workspaceMode || "auto", 32),
      collaboration_mode: text(input.collaboration_mode || input.collaborationMode, 32),
      language: text(input.language, 16),
      preferred_runtime: text(input.coordinator_runtime || input.coordinatorRuntime, 16),
      independent_review: input.independent_review === true,
      prefer_remote_ops: input.prefer_remote_ops === true,
    };
  }

  async collectDevices(input) {
    const ids = [...new Set([
      this.deviceId,
      ...(Array.isArray(input.candidate_device_ids) ? input.candidate_device_ids : []),
      ...(Array.isArray(input.participants) ? input.participants.map((item) => item?.device_id ?? item?.deviceId) : []),
    ].map((value) => text(value, 191)).filter(Boolean))];
    const devices = [];
    for (const id of ids) {
      try {
        const capabilities = await this.capabilitiesForDevice(id);
        if (capabilities) devices.push({ deviceId: id, local: id === this.deviceId || id === "local", online: true, trustStatus: "trusted", capabilities });
      } catch { /* unreachable candidates must not be sent as facts */ }
    }
    if (!devices.some((item) => item.local)) {
      throw configurationError("CONFIGURATION_CAPABILITIES_UNAVAILABLE", "The target CLI could not read its collaboration capabilities.");
    }
    return devices.map((item) => item.deviceId === "local" ? { ...item, deviceId: this.deviceId, local: true } : item);
  }

  async liveDevices(session) {
    const ids = [...new Set((session.capability_snapshot?.devices || []).map((item) => item.device_id).filter(Boolean))];
    const devices = [];
    for (const id of ids) {
      try {
        const capabilities = await this.capabilitiesForDevice(id);
        if (capabilities) devices.push({ deviceId: id, local: id === this.deviceId, online: true, trustStatus: "trusted", capabilities });
      } catch { /* disconnected devices cannot appear in a final validated proposal */ }
    }
    if (!devices.length) throw configurationError("CONFIGURATION_CAPABILITIES_UNAVAILABLE", "No trusted CLI capability snapshot is available.");
    return devices;
  }

  async consumeRemote(configurationId, remote, knownDevices = null) {
    this.applyRemote(configurationId, remote);
    let session = this.local(configurationId);
    for (let attempt = 0; attempt < 6 && session.state === "awaiting_tool"; attempt += 1) {
      const results = (session.tool_requests || []).map((request) => this.executeReadOnlyTool(session, request));
      remote = await this.serverClient.toolResults(session.server_configuration_id, {
        expected_revision: session.server_revision,
        tool_results: results,
      });
      this.applyRemote(configurationId, remote);
      session = this.local(configurationId);
    }
    if (session.state === "proposal_ready") {
      this.store.updateConfigurationSession(configurationId, {
        proposal: await this.validateServerProposal(session, session.proposal, knownDevices),
        planning_source: "server_model",
      });
    } else if (session.state === "failed") {
      throw configurationError(session.fallback_reason || "CONFIGURATION_SERVER_PLANNER_FAILED", session.model_error || "The server collaboration planner failed.");
    } else if (session.state === "awaiting_tool") {
      throw configurationError("CONFIGURATION_TOOL_TURN_LIMIT", "The server planner exceeded the bounded read-only tool loop.");
    }
  }

  applyRemote(configurationId, remote) {
    if (!remote?.configuration_id || !Number.isInteger(Number(remote.revision))) {
      throw configurationError("CONFIGURATION_SERVER_RESPONSE_INVALID", "The server returned an invalid configuration session.");
    }
    this.store.updateConfigurationSession(configurationId, {
      state: text(remote.state, 32) || "planning",
      server_configuration_id: text(remote.configuration_id, 195),
      server_revision: Number(remote.revision),
      questions: Array.isArray(remote.questions) ? remote.questions : [],
      tool_requests: Array.isArray(remote.tool_requests) ? remote.tool_requests : [],
      server_proposal: remote.proposal && typeof remote.proposal === "object" ? remote.proposal : {},
      proposal: remote.proposal && typeof remote.proposal === "object" ? remote.proposal : {},
      planning_source: "server_model",
      fallback_reason: text(remote.fallback_reason, 512),
      model_error: text(remote.model_error, 4096),
    });
  }

  executeReadOnlyTool(session, request = {}) {
    const name = text(request.name, 64);
    const deviceId = text(request.device_id, 191);
    const workspaceId = text(request.workspace_id, 191);
    if (!ALLOWED_TOOLS.has(name)) throw configurationError("CONFIGURATION_TOOL_NOT_ALLOWED", "The server requested a disallowed configuration tool.");
    const device = (session.capability_snapshot?.devices || []).find((item) => item.device_id === deviceId);
    if (!device) throw configurationError("CONFIGURATION_TOOL_DEVICE_UNKNOWN", "The server requested an unknown device.");
    if (name === "get_device_capabilities") return { name, device_id: deviceId, result: device };
    if (name === "get_budget_status") return { name, device_id: deviceId, result: device.budget_policy || null };
    const workspace = (device.trusted_workspaces || []).find((item) => item.workspace_id === workspaceId);
    if (!workspace) throw configurationError("CONFIGURATION_TOOL_WORKSPACE_UNKNOWN", "The server requested an unknown workspace.");
    return { name, device_id: deviceId, workspace_id: workspaceId, result: workspace };
  }

  async validateServerProposal(session, proposal, knownDevices = null) {
    const normalized = validateAndNormalizeAutoConfiguration(proposal, {
      objective: session.objective,
      devices: knownDevices || await this.liveDevices(session),
    });
    return {
      ...normalized,
      workspace_mode: "auto",
      resolved_workspace_mode: "auto",
      coordinator_runtime: session.coordinator_runtime,
      planning_source: "server_model",
      supervisor_permission_profile: "guarded",
      supervisor_policy_id: "",
    };
  }

  validateAnswers(session, answers) {
    const allowed = new Set((session.questions || []).map((item) => item.id));
    const result = {};
    for (const [key, value] of Object.entries(answers || {})) {
      if (!allowed.has(key)) continue;
      const values = (Array.isArray(value) ? value : [value]).map((item) => text(item, 1_024)).filter(Boolean).slice(0, 8);
      if (values.length) result[key] = values;
    }
    if (!Object.keys(result).length) throw configurationError("CONFIGURATION_ANSWER_REQUIRED", "Answer at least one configuration question.");
    return result;
  }

  async fallback(configurationId, devices, error) {
    const session = this.local(configurationId);
    // A raw server proposal reaches proposal_ready before CLI live validation.
    // Therefore a validator failure must be able to replace it with fallback.
    if (["fallback_ready", "consumed", "cancelled"].includes(session.state)) return session;
    let usable = devices;
    try { if (!usable?.length) usable = await this.liveDevices(session); } catch { /* retain primary error */ }
    try {
      const proposal = buildLocalWorkspaceConfiguration({ objective: session.objective, mode: "auto", coordinator: session.coordinator_runtime, devices: usable || [], currentDirectory: process.cwd() });
      this.store.updateConfigurationSession(configurationId, {
        state: "fallback_ready", proposal: { ...proposal, planning_source: "local_fallback" }, planning_source: "local_fallback",
        fallback_reason: text(error?.code, 512) || "configuration_server_planner_failed",
        model_error: text(error?.message, 4096) || "The server planner failed; a deterministic local proposal is available.",
      });
    } catch (fallbackError) {
      this.store.updateConfigurationSession(configurationId, {
        state: "failed", fallback_reason: text(error?.code, 512) || "configuration_server_planner_failed",
        model_error: `${text(error?.message, 2_000)}; fallback failed: ${text(fallbackError?.message, 2_000)}`,
      });
    }
    return this.local(configurationId);
  }
}
