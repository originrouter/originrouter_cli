const ALLOWED = Object.freeze({
  created: new Set(["designing", "researching", "cancelled"]),
  designing: new Set(["awaiting_plan_confirmation", "waiting_input", "cancelled", "failed"]),
  awaiting_plan_confirmation: new Set(["executing", "cancelled", "failed"]),
  executing: new Set(["completed", "waiting_approval", "waiting_input", "waiting_device", "blocked", "cancelled", "failed"]),
  researching: new Set(["decomposing", "planning", "waiting_input", "cancelled", "failed"]),
  decomposing: new Set(["planning", "waiting_input", "cancelled", "failed"]),
  planning: new Set(["awaiting_plan_review", "waiting_input", "cancelled", "failed"]),
  awaiting_plan_review: new Set(["revision_requested", "plan_approved", "cancelled", "failed"]),
  revision_requested: new Set(["planning", "blocked", "cancelled", "failed"]),
  plan_approved: new Set(["implementing", "cancelled", "failed"]),
  implementing: new Set(["awaiting_verification", "waiting_approval", "waiting_input", "cancelled", "failed"]),
  awaiting_verification: new Set(["rework_requested", "completed", "cancelled", "failed"]),
  rework_requested: new Set(["implementing", "blocked", "cancelled", "failed"]),
  waiting_approval: new Set(["implementing", "cancelled", "failed"]),
  waiting_input: new Set(["researching", "planning", "implementing", "cancelled", "failed"]),
});

export class PlanImplementVerifyCoordinator {
  constructor({ store }) { this.store = store; }

  create(input) { return this.store.createRun(input); }

  move(runId, nextState, options = {}) {
    const run = this.store.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    if (!ALLOWED[run.state]?.has(nextState)) {
      const error = new Error(`invalid collaboration transition: ${run.state} -> ${nextState}`);
      error.code = "invalid_collaboration_transition";
      throw error;
    }
    return this.store.transition(runId, nextState, options);
  }

  start(runId) {
    const run = this.store.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    if (run.template_id === "adaptive_collaboration") {
      return this.move(runId, "designing", { taskState: "active", taskPhase: "plan_design" });
    }
    return this.move(runId, "researching", { taskState: "active", taskPhase: "research" });
  }
  confirm(runId) { return this.store.confirmAdaptivePlan(runId); }
  beginPlanning(runId) { return this.move(runId, "planning", { taskState: "active", taskPhase: "planning" }); }
  beginImplementation(runId) { return this.move(runId, "implementing", { taskState: "active", taskPhase: "implementation" }); }

  receive(runId, message) {
    const appended = this.store.appendMessage(runId, message);
    if (appended.duplicate) return { ...appended, run: this.store.getRun(runId) };
    const run = this.store.getRun(runId, { includeMessages: false });
    switch (appended.message.type) {
      case "plan.submitted":
        return { ...appended, run: this.move(runId, "awaiting_plan_review", { taskPhase: "plan_review" }) };
      case "review.revision_requested": {
        if (Number(run.counters.plan_revisions || 0) >= Number(run.gates.max_plan_revisions || 0)) {
          return { ...appended, run: this.move(runId, "failed", { taskState: "failed" }) };
        }
        return { ...appended, run: this.move(runId, "revision_requested", { counter: "plan_revisions", taskPhase: "planning" }) };
      }
      case "review.approved":
        return { ...appended, run: this.move(runId, "plan_approved", { taskPhase: "implementation" }) };
      case "implementation.completed":
        return { ...appended, run: this.move(runId, "awaiting_verification", { taskPhase: "verification" }) };
      case "verification.failed":
      case "rework.requested": {
        if (Number(run.counters.rework_rounds || 0) >= Number(run.gates.max_rework_rounds || 0)) {
          return { ...appended, run: this.move(runId, "failed", { taskState: "failed" }) };
        }
        return { ...appended, run: this.move(runId, "rework_requested", { counter: "rework_rounds", taskPhase: "implementation" }) };
      }
      case "verification.passed":
        return { ...appended, run: this.move(runId, "completed", { taskState: "completed", taskPhase: "completed" }) };
      case "task.blocked":
        return { ...appended, run: this.store.transition(runId, "blocked", { taskState: "blocked" }) };
      case "task.failed":
        return { ...appended, run: this.store.transition(runId, "failed", { taskState: "failed" }) };
      default:
        return { ...appended, run: this.store.getRun(runId) };
    }
  }

  cancel(runId) {
    const run = this.store.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    if (["completed", "failed", "cancelled", "expired"].includes(run.state)) return this.store.getRun(runId);
    return this.store.transition(runId, "cancelled", { taskState: "cancelled" });
  }
}
