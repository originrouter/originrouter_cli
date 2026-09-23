import { redactDisplayText } from "../security/displayRedaction.js";
import { workspaceModeDefinition } from "../collaboration/workspaceModes.js";

export function autoConfigurationView(payload) {
  return {
    objective: payload.objective,
    supervisor_permission_profile: payload.supervisor_permission_profile || "guarded",
    supervisor_policy_id: payload.supervisor_policy_id || null,
    participants: payload.participants.map((participant) => ({
      participant_id: participant.participant_id,
      display_name: participant.display_name,
      runtime: participant.runtime,
      device_id: participant.device_id,
      workspace_id: participant.workspace_id,
      role_hint: participant.role_hint,
      permission_profile: participant.permission_profile,
      approval_policy_id: participant.approval_policy_id || null,
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

export function printAutoConfiguration(payload) {
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

export function printRun(run, { json = false } = {}) {
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

export const TERMINAL_VIEW_STATES = new Set(["completed", "failed", "cancelled", "expired"]);

function compactNumber(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}k`;
  return String(number);
}

export function printAttachSnapshot(snapshot, { participantId = "", taskId = "" } = {}) {
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

export function printAttachEvent(event, { raw = false, verbose = false, plain = false } = {}) {
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

export function printFinalReport(report, { participantId = "", taskId = "" } = {}) {
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
