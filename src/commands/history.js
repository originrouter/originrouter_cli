import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { ensureStateDir } from "../persistence/state.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";
import { accessTokenFor, OAUTH_RESOURCES } from "../runtime/authContract.js";

const DEFAULT_MEMORY_BASE_URL = "https://memory.easytransnote.com";

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args, name) {
  return args.includes(`--${name}`);
}

function positionalQuery(args) {
  const parts = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item.startsWith("--")) {
      if (!["--json", "--archived"].includes(item)) index += 1;
      continue;
    }
    parts.push(item);
  }
  return parts.join(" ").trim();
}

function normalizedTopK(value) {
  const parsed = Number(value ?? 8);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error("--limit must be an integer between 1 and 20");
  }
  return parsed;
}

function scopeFromArgs(args) {
  const scope = {};
  const mapping = [
    ["device", "device_ids"],
    ["workspace", "workspace_ids"],
    ["conversation", "conversation_ids"],
    ["agent", "agent_types"],
  ];
  for (const [option, field] of mapping) {
    const value = optionValue(args, `--${option}`)?.trim();
    if (value) scope[field] = [value];
  }
  const since = optionValue(args, "--since")?.trim();
  const until = optionValue(args, "--until")?.trim();
  if (since) scope.since = since;
  if (until) scope.until = until;
  if (has(args, "archived")) scope.include_archived = true;
  return scope;
}

function queryId() {
  return `inq_history_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function memoryBaseUrl() {
  return String(process.env.ORIGINROUTER_MEMORY_BASE_URL || DEFAULT_MEMORY_BASE_URL)
    .replace(/\/+$/, "");
}

export async function queryAccountHistory({
  query,
  scope = {},
  topK = 8,
  context = null,
  stateDir = ensureStateDir(),
  fetchFn = globalThis.fetch,
} = {}) {
  const normalized = String(query || "").trim();
  if (!normalized) throw new Error("History query must not be empty");
  const credential = await ensureFreshAccessToken({
    stateDir,
    resource: OAUTH_RESOURCES.MEMORY,
    fetchFn,
  });
  const token = accessTokenFor(credential, OAUTH_RESOURCES.MEMORY)?.token;
  if (!token) {
    const error = new Error("OriginRouter Memory access is unavailable. Sign in again with `originrouter login`.");
    error.code = "HISTORY_MEMORY_AUTH_UNAVAILABLE";
    throw error;
  }
  const response = await fetchFn(`${memoryBaseUrl()}/v2/inquiries/agent-activity/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query_id: queryId(),
      query: normalized,
      scope,
      top_k: topK,
      token_budget: 4000,
      ...(context ? { context } : {}),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== "ok") {
    const reason = payload?.details?.reason || payload?.code || `http_${response.status}`;
    const error = new Error(payload?.message || `History query failed (${response.status})`);
    error.code = String(reason).toUpperCase();
    throw error;
  }
  return payload.data?.evidence_bundle || payload.evidence_bundle;
}

function confidenceLabel(item) {
  const level = item?.metadata?.confidence_level;
  if (level === "high") return "high confidence";
  if (level === "medium") return "possible match";
  return "low confidence";
}

function dateTime(value) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown time";
}

function renderEvidence(item, index) {
  const metadata = item.metadata || {};
  const locator = item.locator || {};
  const reasons = metadata.match_reasons || metadata.why_matched || [];
  const excerpt = metadata.matched_excerpt || item.summary || "";
  const identity = [metadata.agent_type, metadata.device_name, metadata.workspace_name]
    .filter(Boolean).join(" · ");
  console.log(`\n${index + 1}. ${item.title || "Agent conversation"}  ${confidenceLabel(item)}`);
  if (identity) console.log(`   ${identity}`);
  console.log(`   ${dateTime(item.occurred_at)}${metadata.status ? ` · ${metadata.status}` : ""}`);
  if (reasons.length) console.log(`   Match: ${reasons.join(", ")}`);
  if (excerpt) console.log(`   “${String(excerpt).replace(/\s+/g, " ").slice(0, 300)}”`);
  console.log(`   ID: ${locator.conversation_id || item.source_id}`);
}

export function printHistoryResult(query, bundle) {
  const evidence = bundle?.evidence || [];
  console.log(`Query: ${query}`);
  if (!evidence.length) {
    console.log("\nNo matching Agent conversations were found in the account history.");
    return;
  }
  const first = evidence[0];
  const firstMeta = first.metadata || {};
  console.log(`\nMost likely: ${first.title || "Agent conversation"}${firstMeta.device_name ? ` on ${firstMeta.device_name}` : ""}.`);
  console.log(`Found ${evidence.length} relevant conversation${evidence.length === 1 ? "" : "s"}.`);
  console.log("\nRelated conversations");
  evidence.forEach(renderEvidence);
  console.log("\nUse `originrouter agent history show <conversation-id>` on the owning device to inspect a local conversation.");
}

async function runOne(query, args, context = null) {
  const bundle = await queryAccountHistory({
    query,
    scope: scopeFromArgs(args),
    topK: normalizedTopK(optionValue(args, "--limit")),
    context,
  });
  if (has(args, "json")) console.log(JSON.stringify(bundle, null, 2));
  else printHistoryResult(query, bundle);
  return bundle;
}

async function interactiveHistory(args) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Usage: originrouter history \"what do you remember?\" [options]");
  }
  const prompt = createInterface({ input, output });
  let previousQuery = "";
  let previousConversationIds = [];
  console.log("Search Agent history across Claude, Codex, and signed-in devices. Enter /quit to leave.\n");
  try {
    while (true) {
      const query = (await prompt.question("History › ")).trim();
      if (!query) continue;
      if (["/quit", "/exit", "quit", "exit"].includes(query.toLowerCase())) return;
      const bundle = await runOne(query, args, previousQuery ? {
        previous_query: previousQuery,
        previous_conversation_ids: previousConversationIds,
      } : null);
      previousQuery = query;
      previousConversationIds = (bundle?.evidence || [])
        .map((item) => item.locator?.conversation_id || item.source_id)
        .filter(Boolean).slice(0, 20);
      console.log();
    }
  } finally {
    prompt.close();
  }
}

export async function handleHistoryCommand(args = []) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: originrouter history [question] [--agent claude|codex] [--device <id>] [--workspace <id>] [--since <ISO>] [--until <ISO>] [--limit 1-20] [--archived] [--json]");
    return;
  }
  const query = positionalQuery(args);
  if (!query) return interactiveHistory(args);
  return runOne(query, args);
}
