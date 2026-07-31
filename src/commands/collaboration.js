import { readFileSync } from "node:fs";
import { cwd, stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { BUILTIN_COLLABORATION_TEMPLATES } from "../collaboration/adaptivePlan.js";
import { readApiToken } from "../persistence/authToken.js";
import { ensureStateDir, readDaemonState } from "../persistence/state.js";

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
    throw new Error("OriginRouter daemon is not running. Start it with `originrouter service start` or `originrouter daemon`, then try again.");
  }
  const bind = state.localApiBindAddress || "127.0.0.1";
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return { baseUrl: `http://${urlHost}:${state.localApiPort}`, token };
}

async function request(path, { method = "GET", body } = {}) {
  const api = localApi();
  const response = await fetch(`${api.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${api.token}`,
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error?.message || payload.message || `Local collaboration request failed (${response.status})`);
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

function createPayload(args) {
  const specPath = value(args, "spec");
  if (specPath) {
    const parsed = JSON.parse(readFileSync(specPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--spec must contain one JSON object");
    return parsed;
  }
  const objective = value(args, "objective");
  if (!objective) throw new Error("Missing --objective. Use --spec <file.json> for a reusable or more detailed collaboration definition.");
  const hints = roleHints(args);
  const participants = values(args, "participant").map(parseParticipant).map((item, index) => ({
    ...item,
    role_hint: hints.get(item.participant_id) || "",
    planner: index === 0,
  }));
  if (participants.length === 0) {
    throw new Error("Add at least one --participant id:runtime:device:workspace.");
  }
  const tokenLimit = value(args, "token-limit");
  const amountLimitMicros = value(args, "amount-limit-micros");
  const concurrency = value(args, "concurrency");
  return {
    objective,
    participants,
    preferences: value(args, "preference") || "",
    workflow_template_id: value(args, "template") || "adaptive",
    coordination_prompt: value(args, "coordination-prompt") || "",
    budget: {
      ...(tokenLimit == null ? {} : { token_limit: Number(tokenLimit) }),
      ...(amountLimitMicros == null ? {} : { amount_limit_micros: Number(amountLimitMicros) }),
      ...(concurrency == null ? {} : { max_concurrency: Number(concurrency) }),
    },
  };
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

async function waitForPlan(runId, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let run;
  while (Date.now() < deadline) {
    run = (await request(`/collaboration/local/runs/${encodeURIComponent(runId)}`)).run;
    if (["awaiting_plan_confirmation", "failed", "cancelled", "expired"].includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return run;
}

async function confirmInteractively(run, args) {
  if (has(args, "yes")) return true;
  if (!input.isTTY || !output.isTTY) return false;
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question("Run this plan? [y/N] ");
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    prompt.close();
  }
}

export async function handleCollaborationCommand(args) {
  const [action = "list", ...rest] = args;
  const json = has(args, "json");
  if (action === "templates") {
    if (json) console.log(JSON.stringify(BUILTIN_COLLABORATION_TEMPLATES, null, 2));
    else for (const item of BUILTIN_COLLABORATION_TEMPLATES) console.log(`${item.id}\n  ${item.description}`);
    return;
  }
  if (action === "list") {
    const data = await request("/collaboration/local/runs");
    if (json) console.log(JSON.stringify(data.runs || [], null, 2));
    else if (!(data.runs || []).length) console.log("No Agent collaborations yet.");
    else for (const run of data.runs) printRun(run);
    return;
  }
  if (action === "show") {
    const runId = rest[0];
    if (!runId) throw new Error("Usage: originrouter collaboration show <run-id> [--json]");
    printRun((await request(`/collaboration/local/runs/${encodeURIComponent(runId)}`)).run, { json });
    return;
  }
  if (["start", "confirm", "cancel"].includes(action)) {
    const runId = rest[0];
    if (!runId) throw new Error(`Usage: originrouter collaboration ${action} <run-id>`);
    const run = (await request(`/collaboration/local/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST", body: {} })).run;
    printRun(run, { json });
    return;
  }
  if (action === "create") {
    const payload = createPayload(args);
    let run = (await request("/collaboration/local/runs", { method: "POST", body: payload })).run;
    run = (await request(`/collaboration/local/runs/${encodeURIComponent(run.run_id)}/start`, { method: "POST", body: {} })).run;
    if (has(args, "no-wait")) {
      printRun(run, { json });
      return;
    }
    const timeout = Math.max(30, Math.min(900, Number(value(args, "timeout") || 300)));
    console.log(`Planner is preparing a collaboration plan (${run.run_id})…`);
    run = await waitForPlan(run.run_id, timeout);
    if (!run || run.state !== "awaiting_plan_confirmation") {
      printRun(run || { run_id: payload.run_id || "", state: "unknown", objective: payload.objective }, { json });
      if (run?.state !== "failed") console.log(`\nThe Planner is still working. Check later with: originrouter collaboration show ${run?.run_id || "<run-id>"}`);
      return;
    }
    if (json) {
      if (has(args, "yes")) {
        const confirmed = (await request(`/collaboration/local/runs/${encodeURIComponent(run.run_id)}/confirm`, { method: "POST", body: {} })).run;
        printRun(confirmed, { json: true });
      } else {
        printRun(run, { json: true });
      }
      return;
    }
    printRun(run);
    if (await confirmInteractively(run, args)) {
      const confirmed = (await request(`/collaboration/local/runs/${encodeURIComponent(run.run_id)}/confirm`, { method: "POST", body: {} })).run;
      console.log(`\nCollaboration started: ${confirmed.run_id}`);
    } else {
      console.log(`\nThe plan has not started. Review it, then run: originrouter collaboration confirm ${run.run_id}`);
    }
    return;
  }
  throw new Error("Usage: originrouter collaboration templates|list|show|create|start|confirm|cancel");
}
