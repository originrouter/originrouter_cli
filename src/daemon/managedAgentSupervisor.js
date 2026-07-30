import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureStateDir } from "../persistence/state.js";
import {
  deployApprovalPolicyBundle,
  readApprovalPolicy,
} from "../runtime/approvalPolicyStore.js";
import {
  aiReviewPolicyFromPayload,
  encodeAiReviewPolicyEnvironment,
} from "../runtime/aiReviewPolicy.js";

const AGENTS = new Set(["claude", "codex"]);
const PERMISSION_PROFILES = new Set([
  "manual",
  "guarded",
  "ai_review",
  "custom",
  "unrestricted",
]);

function safeText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function launchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class ManagedAgentSupervisor {
  constructor({
    catalog,
    deviceId,
    relayUrl,
    spawnFn = spawn,
    nodePath = process.execPath,
    binPath = fileURLToPath(new URL("../../bin/originrouter.js", import.meta.url)),
  }) {
    this.catalog = catalog;
    this.deviceId = deviceId;
    this.relayUrl = relayUrl;
    this.spawnFn = spawnFn;
    this.nodePath = nodePath;
    this.binPath = binPath;
    this.launches = new Map();
  }

  async start(payload = {}) {
    const launchId = safeText(payload.launchId || payload.launch_id, 96);
    const sessionId = safeText(payload.sessionId || payload.session_id, 64);
    let conversationId = safeText(
      payload.conversationId || payload.conversation_id || sessionId,
      96,
    );
    const runId = safeText(payload.runId || payload.run_id || sessionId, 96);
    const agent = safeText(payload.agentType || payload.agent_type, 32).toLowerCase();
    const workspaceReference = safeText(
      payload.workspaceId || payload.workspace_id || payload.cwd,
      4096,
    );
    const initialMessage = safeText(
      payload.initialMessage || payload.initial_message,
      8192,
    );
    const permissionProfile = safeText(
      payload.permissionProfile || payload.permission_profile || "manual",
      32,
    ).toLowerCase();
    let approvalPolicy = null;
    let aiReviewPolicy = null;
    const resumeConversationId = safeText(
      payload.resumeConversationId || payload.resume_conversation_id,
      96,
    );
    const nativeSessionId = safeText(
      payload.nativeSessionId || payload.native_session_id,
      191,
    );
    if (!launchId || !sessionId || !conversationId || !runId) {
      throw launchError("INVALID_LAUNCH_REQUEST", "Launch identifiers are required.");
    }
    if (!AGENTS.has(agent)) {
      throw launchError("UNSUPPORTED_AGENT", `Unsupported Agent: ${agent || "unknown"}`);
    }
    if (!PERMISSION_PROFILES.has(permissionProfile)) {
      throw launchError(
        "INVALID_PERMISSION_PROFILE",
        `Unsupported permission profile: ${permissionProfile}`,
      );
    }
    if (permissionProfile === "custom") {
      try {
        const bundle = payload.policyBundle || payload.policy_bundle;
        const policyId = safeText(payload.policyId || payload.policy_id, 64);
        approvalPolicy = bundle
          ? deployApprovalPolicyBundle(bundle, { stateDir: ensureStateDir() })
          : policyId
            ? readApprovalPolicy(policyId, { stateDir: ensureStateDir() })
            : null;
        const expectedRevision = safeText(
          payload.policyRevision || payload.policy_revision,
          128,
        ).replace(/^sha256:/, "");
        if (approvalPolicy && expectedRevision && approvalPolicy.revision !== expectedRevision) {
          throw launchError(
            "APPROVAL_POLICY_REVISION_NOT_FOUND",
            "The selected approval policy revision is not installed on this device.",
          );
        }
      } catch (error) {
        if (error?.code === "APPROVAL_POLICY_REVISION_NOT_FOUND") throw error;
        throw launchError(
          error?.code || "APPROVAL_POLICY_INVALID",
          error?.message || "The approval policy could not be deployed.",
        );
      }
    }
    if (permissionProfile === "ai_review") {
      aiReviewPolicy = aiReviewPolicyFromPayload(payload);
    }
    if (!workspaceReference) {
      throw launchError("WORKSPACE_REQUIRED", "A trusted workspace is required.");
    }
    if (Boolean(resumeConversationId) !== Boolean(nativeSessionId)) {
      throw launchError(
        "INVALID_RESUME_REQUEST",
        "Both the OriginRouter conversation id and native Agent session id are required to resume.",
      );
    }
    const existing = this.launches.get(launchId);
    if (existing) return { ...existing, duplicate: true };
    const persisted = this.catalog?.getLaunchReceipt?.(launchId);
    if (persisted) {
      if (persisted.sessionId !== sessionId || persisted.agentType !== agent) {
        throw launchError(
          "LAUNCH_ID_CONFLICT",
          "This launch id is already associated with a different Agent request.",
        );
      }
      return { ...persisted, duplicate: true };
    }
    const workspace = this.catalog?.getWorkspace(workspaceReference, {
      deviceId: this.deviceId,
    });
    if (!workspace) {
      throw launchError(
        "WORKSPACE_NOT_FOUND",
        "The requested workspace is not registered on this device.",
      );
    }
    if (!workspace.trusted) {
      throw launchError(
        "WORKSPACE_NOT_TRUSTED",
        "The requested workspace has not been trusted for remote Agent launches.",
      );
    }
    let resumeConversation = null;
    if (resumeConversationId) {
      resumeConversation = this.catalog?.getConversation(resumeConversationId);
      if (!resumeConversation) {
        throw launchError(
          "RESUME_CONVERSATION_NOT_FOUND",
          "The requested Agent conversation is not recorded on this device.",
        );
      }
      if (resumeConversation.agent_type !== agent) {
        throw launchError(
          "RESUME_AGENT_MISMATCH",
          "The requested conversation belongs to a different Agent.",
        );
      }
      if (resumeConversation.native_session_id !== nativeSessionId) {
        throw launchError(
          "RESUME_SESSION_MISMATCH",
          "The native Agent session id does not match the local Catalog.",
        );
      }
      if (resumeConversation.workspace_id !== workspace.workspace_id) {
        throw launchError(
          "RESUME_WORKSPACE_MISMATCH",
          "The requested conversation belongs to a different workspace.",
        );
      }
      conversationId = resumeConversationId;
    }

    const command = agent === "claude" ? "claude-sdk" : "codex-app-server";
    const args = [
      this.binPath,
      command,
      "--originrouter-session",
      sessionId,
      "--originrouter-conversation",
      conversationId,
      "--originrouter-run",
      runId,
      "--originrouter-device",
      this.deviceId,
      "--originrouter-relay",
      this.relayUrl,
      "--originrouter-autonomy",
      permissionProfile,
      "--originrouter-workspace",
      workspace.workspace_id,
    ];
    const provider = safeText(payload.provider, 191);
    const model = safeText(payload.model, 191);
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);
    if (initialMessage) args.push("--prompt", initialMessage);
    const title = safeText(payload.title, 256) || resumeConversation?.title || `${agent} session`;
    if (title) args.push("--originrouter-title", title);
    if (nativeSessionId) args.push("--resume", nativeSessionId);
    if (permissionProfile === "custom") {
      if (approvalPolicy) {
        args.push("--originrouter-policy", approvalPolicy.policy.id);
      }
      const scopes = Array.isArray(payload.allowedScopes || payload.allowed_scopes)
        ? (payload.allowedScopes || payload.allowed_scopes)
            .map((item) => safeText(item, 64))
            .filter(Boolean)
        : [];
      if (!approvalPolicy && scopes.length) args.push("--originrouter-auto-allow", scopes.join(","));
    }

    const child = this.spawnFn(this.nodePath, args, {
      cwd: workspace.canonical_path,
      env: {
        ...process.env,
        ...(aiReviewPolicy
          ? {
              ORIGINROUTER_AI_REVIEW_POLICY_B64:
                encodeAiReviewPolicyEnvironment(aiReviewPolicy),
            }
          : {}),
      },
      detached: false,
      stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref?.();
    const result = {
      launchId,
      sessionId,
      conversationId,
      runId,
      agentType: agent,
      workspaceId: workspace.workspace_id,
      workspacePath: workspace.canonical_path,
      pid: Number(child.pid) || null,
      accepted: true,
      duplicate: false,
    };
    this.launches.set(launchId, result);
    this.catalog?.upsertSession({
      sessionId,
      conversationId,
      runId,
      agent,
      title,
      deviceId: this.deviceId,
      workspaceId: workspace.workspace_id,
      workspaceName: workspace.display_name,
      workspaceTrusted: true,
      cwd: workspace.canonical_path,
      pid: child.pid,
      runtime: agent === "claude" ? "claude-sdk" : "codex-app-server",
      provider,
      model,
      permissionProfile,
      startedBy: nativeSessionId
        ? "app-resume"
        : safeText(payload.startedBy || payload.started_by, 64) || "app-remote",
      status: "starting",
    });
    this.catalog?.recordLaunchReceipt?.(result);
    child.once("error", () => {
      this.catalog?.finishSession(sessionId, { status: "failed" });
      this.launches.delete(launchId);
    });
    child.once("exit", (code, signal) => {
      this.catalog?.finishSession(sessionId, {
        status: code === 0 && !signal ? "completed" : "failed",
        exitCode: code,
        exitSignal: signal,
      });
      this.launches.delete(launchId);
    });
    return result;
  }
}
