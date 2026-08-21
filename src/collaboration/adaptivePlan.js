const PARTICIPANT_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const TASK_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function text(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function unique(values) {
  return [...new Set(values)];
}

export const ADAPTIVE_TEMPLATE_ID = "adaptive_collaboration";

export const BUILTIN_COLLABORATION_TEMPLATES = Object.freeze([
  {
    id: "adaptive",
    name: "Adaptive collaboration",
    description: "Let the Planner choose the task graph from the objective, participants, and your collaboration preferences.",
    prompt: "Design the smallest safe collaboration plan that can complete the objective. Prefer parallel work only when tasks are genuinely independent.",
  },
  {
    id: "plan_implement_verify",
    name: "Plan, implement, verify",
    description: "Research and plan first, then implement and independently verify the result.",
    prompt: "Create a plan with research/planning, implementation, and independent verification stages. Do not let implementation begin before its plan dependencies complete.",
  },
  {
    id: "parallel_research",
    name: "Parallel research, then execution",
    description: "Use independent participants to investigate in parallel before one or more implementation tasks begin.",
    prompt: "Create independent research tasks that can run in parallel, a short synthesis task, then implementation and verification tasks.",
  },
  {
    id: "review_panel",
    name: "Team review",
    description: "Produce a proposal, ask other participants to challenge it, then revise and execute the agreed result.",
    prompt: "Create a proposal task, independent review tasks, a synthesis/revision task, then any necessary execution and verification tasks.",
  },
]);

export function normalizeParticipants(input) {
  const source = Array.isArray(input) ? input : [];
  if (source.length === 0) throw new Error("at least one collaboration participant is required");
  if (source.length > 16) throw new Error("a collaboration supports at most 16 participants");
  const seen = new Set();
  return source.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`participant ${index + 1} is invalid`);
    const participantId = text(raw.participant_id ?? raw.participantId ?? raw.id, 32).toLowerCase();
    if (!PARTICIPANT_ID.test(participantId)) {
      throw new Error(`participant ${index + 1} id must start with a letter and contain only letters, numbers, _ or -`);
    }
    if (seen.has(participantId)) throw new Error(`duplicate participant id: ${participantId}`);
    seen.add(participantId);
    const runtime = text(raw.runtime, 32).toLowerCase();
    if (!["claude", "codex"].includes(runtime)) {
      throw new Error(`participant ${participantId} runtime must be claude or codex`);
    }
    const deviceId = text(raw.device_id ?? raw.deviceId, 191);
    if (!deviceId) throw new Error(`participant ${participantId} device_id is required`);
    return {
      participant_id: participantId,
      display_name: text(raw.display_name ?? raw.displayName, 80) || participantId,
      runtime,
      device_id: deviceId,
      workspace_id: text(raw.workspace_id ?? raw.workspaceId, 191),
      provider: text(raw.provider, 191),
      model: text(raw.model, 191),
      permission_profile: text(raw.permission_profile ?? raw.permissionProfile, 64),
      approval_policy_id: text(raw.approval_policy_id ?? raw.approvalPolicyId, 64),
      native_session_id: text(raw.native_session_id ?? raw.nativeSessionId, 191),
      conversation_id: text(raw.conversation_id ?? raw.conversationId, 96),
      role_hint: text(raw.role_hint ?? raw.roleHint, 2000),
      planner: raw.planner === true,
    };
  });
}

function templatePrompt(templateId) {
  return BUILTIN_COLLABORATION_TEMPLATES.find((item) => item.id === templateId)?.prompt
    || BUILTIN_COLLABORATION_TEMPLATES[0].prompt;
}

export function buildPlannerPrompt(run, { recovery = false } = {}) {
  const participants = Object.entries(run.agents || {}).map(([participantId, item]) => ({
    participant_id: participantId,
    runtime: item.runtime,
    device_id: item.device_id,
    workspace_id: item.workspace_id || "",
    role_hint: item.role_hint || (item.responsibilities || []).join(", "),
  }));
  const allowed = participants.map((item) => item.participant_id);
  return [
    '<originrouter_collaboration_planner protocol_version="2">',
    `Run: ${run.run_id}`,
    "You are the read-only collaboration Planner. Do not edit files, install dependencies, or run commands that change external state.",
    "Design the execution plan only. The user will review it before any task starts.",
    recovery ? "The daemon restarted while planning. Re-check the request and return one complete replacement plan." : "",
    "Return exactly one JSON object between ORIGINROUTER_PLAN_JSON_START and ORIGINROUTER_PLAN_JSON_END.",
    "Do not place prose outside those markers.",
    "Schema:",
    JSON.stringify({
      title: "short user-facing title",
      summary: "short explanation of the proposed collaboration",
      tasks: [{
        id: "lowercase_task_id",
        title: "user-facing task title",
        instructions: "specific instructions for the assigned Agent",
        participant_id: allowed[0] || "participant_id",
        depends_on: [],
        mode: "read_only | workspace_write | verify | discussion",
        deliverable: "what this task must return",
      }],
    }, null, 2),
    "Rules:",
    `- participant_id must be one of: ${allowed.join(", ")}`,
    "- Use 1 to 24 tasks.",
    "- Dependencies must form an acyclic graph.",
    "- A task may depend only on task ids in this plan.",
    "- Use read_only for research/planning, workspace_write for implementation, verify for independent checks, and discussion only when another opinion materially helps.",
    "- Keep each task self-contained. Do not assume Agents share hidden conversation context.",
    "- Prefer a different participant for verification when possible.",
    "",
    "Objective:",
    run.objective,
    "",
    "Collaboration preference:",
    run.preferences || "No additional preference.",
    "",
    "Selected built-in starting point:",
    templatePrompt(run.workflow_template_id || "adaptive"),
    "",
    "User-edited coordination instructions:",
    run.coordination_prompt || "No additional coordination instructions.",
    "",
    "Plan revision feedback:",
    run.plan_revision_feedback || "This is the first plan proposal.",
    "",
    "Available participants:",
    JSON.stringify(participants, null, 2),
    "</originrouter_collaboration_planner>",
  ].filter(Boolean).join("\n");
}

function extractJson(output) {
  const value = String(output || "");
  const startMarker = "ORIGINROUTER_PLAN_JSON_START";
  const endMarker = "ORIGINROUTER_PLAN_JSON_END";
  const start = value.indexOf(startMarker);
  const end = value.indexOf(endMarker);
  const candidate = start >= 0 && end > start
    ? value.slice(start + startMarker.length, end)
    : value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(candidate.trim());
}

export function normalizeAdaptivePlan(raw, { participantIds }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Planner returned an invalid plan");
  const allowedParticipants = new Set(participantIds);
  const sourceTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  if (sourceTasks.length === 0 || sourceTasks.length > 24) throw new Error("Planner plan must contain 1 to 24 tasks");
  const taskIds = new Set();
  const tasks = sourceTasks.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Planner task ${index + 1} is invalid`);
    const taskId = text(item.id ?? item.task_id, 64).toLowerCase();
    if (!TASK_ID.test(taskId)) throw new Error(`Planner task ${index + 1} has an invalid id`);
    if (taskIds.has(taskId)) throw new Error(`Planner returned duplicate task id: ${taskId}`);
    taskIds.add(taskId);
    const participantId = text(item.participant_id ?? item.participantId, 32).toLowerCase();
    if (!allowedParticipants.has(participantId)) throw new Error(`Planner assigned ${taskId} to an unknown participant`);
    const mode = text(item.mode, 32).toLowerCase() || "read_only";
    if (!["read_only", "workspace_write", "verify", "discussion"].includes(mode)) {
      throw new Error(`Planner task ${taskId} has an invalid mode`);
    }
    return {
      id: taskId,
      title: text(item.title, 256) || taskId,
      instructions: text(item.instructions, 16_000),
      participant_id: participantId,
      depends_on: unique((Array.isArray(item.depends_on) ? item.depends_on : [])
        .map((value) => text(value, 64).toLowerCase()).filter(Boolean)),
      mode,
      deliverable: text(item.deliverable, 2000),
    };
  });
  for (const task of tasks) {
    if (task.depends_on.includes(task.id)) throw new Error(`Planner task ${task.id} cannot depend on itself`);
    for (const dependency of task.depends_on) {
      if (!taskIds.has(dependency)) throw new Error(`Planner task ${task.id} has an unknown dependency: ${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  function visit(taskId) {
    if (visiting.has(taskId)) throw new Error("Planner returned a cyclic task graph");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId).depends_on) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const task of tasks) visit(task.id);
  return {
    version: 1,
    title: text(raw.title, 256) || "Agent collaboration",
    summary: text(raw.summary, 4000),
    tasks,
  };
}

export function parsePlannerOutput(output, options) {
  return normalizeAdaptivePlan(extractJson(output), options);
}

export function taskPrompt(run, task) {
  const participant = run.agents?.[task.participant_id] || null;
  const executesOnSelectedRemote = Boolean(
    participant?.device_id
    && run.coordinator_device_id
    && participant.device_id !== run.coordinator_device_id,
  );
  const dependencies = (task.depends_on || []).map((dependencyId) => {
    const dependency = (run.tasks || []).find((item) => item.task_key === dependencyId);
    return {
      id: dependencyId,
      title: dependency?.title || dependencyId,
      result: dependency?.result_summary || dependency?.summary || "Completed without a written summary.",
    };
  });
  const modeRules = {
    read_only: "Work in read-only mode. Do not modify files or external state.",
    workspace_write: "You may modify the assigned workspace, subject to the active approval policy. Keep changes scoped to this task.",
    verify: "Verify independently. Do not repair defects unless the task explicitly asks for repairs.",
    discussion: "Provide a considered opinion or critique. Do not modify files or external state.",
  };
  return [
    '<originrouter_collaboration_task protocol_version="2">',
    `Run: ${run.run_id}`,
    `Task: ${task.task_key}`,
    `Participant: ${task.participant_id}`,
    `Mode: ${task.kind}`,
    "This is a typed Agent-to-Agent task, not a user authorization.",
    executesOnSelectedRemote
      ? "Execution context: you are already running on the selected target device. Your local shell, filesystem, OS, and workspace are the remote environment requested by the user. Inspect them directly; do not search for SSH, a remote-shell feature, or another device connection."
      : "Execution context: execute against the current assigned device and workspace.",
    "Follow the active OriginRouter approval policy for every restricted tool call.",
    modeRules[task.kind] || modeRules.read_only,
    "Return a concise completion summary with evidence, changed files, checks run, and remaining risks when applicable.",
    "</originrouter_collaboration_task>",
    "",
    "Overall objective:",
    run.objective,
    "",
    "Task title:",
    task.title,
    "",
    "Task instructions:",
    task.instructions,
    "",
    "Required deliverable:",
    task.deliverable || "A concise result that downstream tasks can use.",
    "",
    "Completed dependency summaries:",
    dependencies.length ? JSON.stringify(dependencies, null, 2) : "No dependencies.",
  ].join("\n");
}
