import { resolveWithAutonomy } from "../runtime/agentAutonomyPolicy.js";
import { aiReviewPolicyFromEnvironment } from "../runtime/aiReviewPolicy.js";
import { readApprovalPolicy } from "../runtime/approvalPolicyStore.js";

const ASK = Symbol("originrouter-supervisor-ask");

function text(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function evidence(name, profile, result) {
  const effect = result === ASK ? "ask" : result?.action === "deny" ? "deny" : "allow";
  return {
    name,
    profile,
    effect,
    reason: result === ASK ? "user_confirmation_required" : text(result?.reason, 256),
    scope: text(result?.scope, 64) || null,
    decision_source: text(result?.decisionSource, 64) || null,
  };
}

export class CollaborationApprovalSupervisor {
  constructor({ stateDir = "", aiReviewer = null } = {}) {
    this.stateDir = stateDir;
    this.aiReviewer = aiReviewer;
  }

  async evaluateLayer({ request, profile, policyId, workspaceRoot, runtime }) {
    return resolveWithAutonomy({
      request,
      profile,
      workspaceRoot,
      runtime,
      stateDir: this.stateDir,
      approvalPolicy: profile === "custom" && policyId
        ? readApprovalPolicy(policyId, { stateDir: this.stateDir })
        : null,
      aiReviewer: this.aiReviewer,
      aiReviewPolicy: profile === "ai_review" ? aiReviewPolicyFromEnvironment() : null,
      requestInteraction: async () => ASK,
    });
  }

  async evaluate({ request, agent, run, workspaceRoot }) {
    const agentProfile = text(agent?.permission_profile, 64) || "manual";
    const sessionProfile = text(run?.supervisor_permission_profile, 64) || "guarded";
    const common = { request, workspaceRoot, runtime: agent?.runtime };
    const samePolicy = agentProfile === sessionProfile
      && text(agent?.approval_policy_id, 64) === text(run?.supervisor_policy_id, 64);
    const agentResult = await this.evaluateLayer({
      ...common,
      profile: agentProfile,
      policyId: agent?.approval_policy_id,
    });
    const sessionResult = samePolicy ? agentResult : await this.evaluateLayer({
      ...common,
      profile: sessionProfile,
      policyId: run?.supervisor_policy_id,
    });
    const layers = [
      evidence("agent", agentProfile, agentResult),
      evidence("session", sessionProfile, sessionResult),
    ];
    const denied = layers.find((layer) => layer.effect === "deny");
    const asks = layers.some((layer) => layer.effect === "ask");
    const effect = denied ? "deny" : asks ? "ask" : "allow";
    const sourceResult = layers[0].effect === effect ? agentResult : sessionResult;
    return {
      effect,
      layers,
      action: effect === "ask" ? null : effect,
      response: effect === "ask" ? null : {
        ...(sourceResult?.response || {}),
        remember_for_session: false,
        originrouter_supervised: true,
      },
      reason: denied?.reason || (asks ? "user_confirmation_required" : "agent_and_session_policy_allow"),
    };
  }
}
