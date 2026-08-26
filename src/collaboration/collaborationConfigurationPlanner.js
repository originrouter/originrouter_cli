import {
  attachCollaborationConfigurationEditor,
  publicCapabilitySnapshot,
  validateAndNormalizeAutoConfiguration,
} from "./collaborationAutoConfig.js";
import { CollaborationConfigurationClient } from "./collaborationConfigurationClient.js";
import { normalizeCollaborationCreateRequest } from "./createRunRequest.js";
import { normalizeCoordinator } from "./workspaceModes.js";

const POLICY = Object.freeze({
  server_plans_only: true,
  target_cli_validates_and_creates_run: true,
  read_only_tools_only: true,
  no_secrets: true,
});
const READY_STATES = new Set(["proposal_ready"]);
const ALLOWED_TOOLS = new Set(["get_device_capabilities", "get_workspace_details", "get_budget_status"]);

function text(value, maximum = 16_000) { return String(value ?? "").trim().slice(0, maximum); }
function configurationError(code, message) { return Object.assign(new Error(message), { code }); }

// The server owns multi-turn model context. This target CLI retains the only
// authority to inspect local facts, run read-only probes, validate, and create a Run.
export class CollaborationConfigurationPlanner {
  constructor({
    store,
    coordinator,
    capabilitiesForDevice,
    listDevices = async () => [],
    deviceId = "local",
    stateDir,
    serverClient,
  } = {}) {
    this.store = store;
    this.coordinator = coordinator;
    this.capabilitiesForDevice = capabilitiesForDevice;
    this.listDevices = listDevices;
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
        request: session.request,
        capability_snapshot: session.capability_snapshot,
        policy: POLICY,
      });
      await this.consumeRemote(session.configuration_id, remote, devices);
    } catch (error) {
      await this.fail(session.configuration_id, error);
    }
    return this.local(session.configuration_id);
  }

  async get(configurationId, { refresh = true } = {}) {
    let session = this.local(configurationId);
    if (!refresh || !session.server_configuration_id || ["fallback_ready", "failed", "consumed", "cancelled"].includes(session.state)) return session;
    try {
      await this.consumeRemote(configurationId, await this.serverClient.get(session.server_configuration_id));
    } catch (error) {
      if (["planning", "awaiting_tool"].includes(session.state)) await this.fail(configurationId, error);
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
      await this.fail(configurationId, error);
    }
    return this.local(configurationId);
  }

  async accept(configurationId) {
    const session = await this.get(configurationId);
    if (!READY_STATES.has(session.state) || !session.proposal) {
      throw configurationError("CONFIGURATION_NOT_READY", "The collaboration configuration is not ready for confirmation.");
    }
    const proposal = await this.validateServerProposal(session, session.server_proposal);
    const continuation = await this.validateContinuation(session);
    const run = this.coordinator.create(normalizeCollaborationCreateRequest({
      ...proposal,
      ...continuation,
      workspace_mode: "auto",
      planning_source: "server_model",
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
      // Kept locally with the configuration session. The server's allowlist
      // intentionally drops these identifiers; they only tell the target CLI
      // that acceptance is a continuation and which Session it must recheck.
      workspace_session_id: text(input.workspace_session_id || input.workspaceSessionId, 195),
      continued_from_run_id: text(input.continued_from_run_id || input.continuedFromRunId, 195),
      session_continuation: input.session_continuation === true || input.sessionContinuation === true,
    };
  }

  async validateContinuation(session) {
    const request = session.request || {};
    const workspaceSessionId = text(request.workspace_session_id, 195);
    const continuedFromRunId = text(request.continued_from_run_id, 195);
    const continuation = request.session_continuation === true;
    if (!continuation) return {};
    if (!workspaceSessionId || !continuedFromRunId) {
      throw configurationError(
        "CONFIGURATION_CONTINUATION_INVALID",
        "A continued collaboration must identify its Workspace Session and previous Run.",
      );
    }
    const workspaceSession = this.store.getWorkspaceSession(workspaceSessionId);
    if (!workspaceSession?.team) {
      throw configurationError(
        "CONFIGURATION_WORKSPACE_SESSION_NOT_FOUND",
        "The Workspace Session to continue is no longer available on this CLI.",
      );
    }
    if (workspaceSession.latest_run_id !== continuedFromRunId) {
      throw configurationError(
        "CONFIGURATION_CONTINUATION_NOT_LATEST",
        "Only the latest Run in a Workspace Session can be continued.",
      );
    }
    const team = workspaceSession.team;
    const teamPlannerId = (team.participants || []).find(
      (participant) => participant.planner === true,
    )?.participant_id;
    const participants = (team.participants || []).map((participant) => ({
      participant_id: participant.participant_id,
      display_name: participant.display_name || participant.participant_id,
      runtime: participant.runtime,
      device_id: participant.device_id,
      workspace_id: participant.workspace_id || "",
      role_hint: participant.role_hint || "Existing Session participant",
      permission_profile: participant.permission_profile || "",
      provider: participant.provider || null,
      model: participant.model || null,
    }));
    const planner = participants.find((participant) => participant.participant_id === teamPlannerId)
      || participants[0];
    // Reuse the same live capability and least-privilege validator used for a
    // new model proposal. A durable Session identity never authorizes stale
    // workspaces, runtimes, models, or permission profiles.
    validateAndNormalizeAutoConfiguration({
      participants,
      planner: planner?.participant_id || "",
      workflow_template_id: team.workflow_template_id || "adaptive",
      collaboration_preferences: team.preferences || "",
      max_concurrency: Number(team.budget?.max_concurrency) || 1,
      independent_review: false,
      budget: {
        token_limit: team.budget?.token_limit ?? null,
        amount_limit_micros: team.budget?.amount_limit_micros ?? null,
        currency: team.budget?.currency ?? null,
      },
    }, {
      objective: session.objective,
      devices: await this.liveDevices(session),
    });
    return {
      workspace_session_id: workspaceSessionId,
      continued_from_run_id: continuedFromRunId,
      session_continuation: true,
    };
  }

  async collectDevices(input) {
    let directory = [];
    try {
      const listed = await this.listDevices();
      if (Array.isArray(listed)) directory = listed;
    } catch {
      // The local capability remains enough for a local-only planning session.
    }
    const explicitIds = [
      ...(Array.isArray(input.candidate_device_ids) ? input.candidate_device_ids : []),
      ...(Array.isArray(input.participants) ? input.participants.map((item) => item?.device_id ?? item?.deviceId) : []),
    ].map((value) => text(value, 191)).filter(Boolean);
    const trustedDirectory = directory.filter((item) => (
      item?.deviceId === this.deviceId
      || item?.device_id === this.deviceId
      || item?.isSelf === true
      || item?.trustStatus === "trusted"
      || item?.trust_status === "trusted"
    ));
    const descriptors = new Map();
    descriptors.set(this.deviceId, {
      deviceId: this.deviceId,
      deviceName: "This device",
      local: true,
      online: true,
      trustStatus: "trusted",
    });
    for (const item of trustedDirectory) {
      const id = text(item?.deviceId ?? item?.device_id, 191);
      if (!id) continue;
      descriptors.set(id, {
        deviceId: id,
        deviceName: text(item?.deviceName ?? item?.device_name, 191) || id,
        local: id === this.deviceId || item?.isSelf === true,
        online: item?.online !== false,
        trustStatus: "trusted",
      });
    }
    for (const id of explicitIds) {
      if (!descriptors.has(id)) {
        descriptors.set(id, {
          deviceId: id,
          deviceName: id,
          local: id === this.deviceId,
          online: true,
          trustStatus: "trusted",
        });
      }
    }
    const devices = (await Promise.all([...descriptors.values()].map(async (descriptor) => {
      if (!descriptor.local && descriptor.online === false) {
        return { ...descriptor, capabilities: null };
      }
      try {
        const capabilities = await this.capabilitiesForDevice(descriptor.deviceId);
        return {
          ...descriptor,
          deviceName: text(capabilities?.device?.name, 191) || descriptor.deviceName,
          capabilities: capabilities || null,
        };
      } catch {
        return descriptor.local ? null : { ...descriptor, capabilities: null };
      }
    }))).filter(Boolean);
    if (!devices.some((item) => item.local && item.capabilities)) {
      throw configurationError("CONFIGURATION_CAPABILITIES_UNAVAILABLE", "The target CLI could not read its collaboration capabilities.");
    }
    return devices.map((item) => item.deviceId === "local" ? { ...item, deviceId: this.deviceId, local: true } : item);
  }

  async liveDevices(session) {
    const snapshots = session.capability_snapshot?.devices || [];
    const ids = [...new Set(snapshots
      .filter((item) => item.online !== false && item.capability_available !== false)
      .map((item) => item.device_id)
      .filter(Boolean))];
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
      const devices = knownDevices || await this.liveDevices(session);
      const proposal = await this.validateServerProposal(session, session.proposal, devices);
      attachCollaborationConfigurationEditor(proposal, devices, { enumerable: true });
      this.store.updateConfigurationSession(configurationId, {
        proposal,
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
    // Preserve the request identity exactly. The server currently treats the
    // optional workspace ID as part of that identity, even for device- and
    // budget-level probes where the CLI does not otherwise need it.
    if (name === "get_device_capabilities") return { name, device_id: deviceId, workspace_id: workspaceId, result: device };
    if (name === "get_budget_status") return { name, device_id: deviceId, workspace_id: workspaceId, result: device.budget_policy || null };
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

  async fail(configurationId, error) {
    const session = this.local(configurationId);
    if (["failed", "consumed", "cancelled"].includes(session.state)) return session;
    this.store.updateConfigurationSession(configurationId, {
      state: "failed",
      fallback_reason: text(error?.code, 512) || "configuration_server_planner_failed",
      model_error: text(error?.message, 4096) || "The server collaboration planner failed.",
    });
    return this.local(configurationId);
  }
}
