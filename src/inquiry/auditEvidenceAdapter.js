import {
  EVIDENCE_POLICY,
  assertNoSecretFields,
  contentHash,
  requireInquiryId,
  stableProtocolId,
} from "./evidenceBundle.js";

const DOMAINS = new Set(["approval", "change"]);
const RISK_ORDER = Object.freeze({ normal: 1, elevated: 2, high: 3, critical: 4 });
const MAX_AUDIT_SCAN = 5000;
const ACTION_SEARCH_ALIASES = Object.freeze({
  database_mutation: "database sql schema 数据库 数据表 迁移 修改",
  destructive_command: "destructive delete remove rollback reset 删除 破坏 回退",
  remote_mutation: "remote server ssh upload deploy 远程 服务器 部署",
  system_mutation: "system service permission config 系统 服务 权限 配置",
  potential_script_mutation: "script migration deploy repair 脚本 迁移 部署 修复",
  outside_workspace_change: "file outside workspace 文件 工作区外 修改",
  permission: "permission approval authorize 权限 审批 授权",
  "fs.read": "read file inspect credential secret 读取 文件 凭据 密钥",
  "fs.write": "write file overwrite change 写入 文件 覆盖 修改",
  "fs.patch": "patch edit file 修改 补丁 编辑",
  "fs.move": "move rename source destination 移动 重命名 源 目标",
  "fs.delete": "delete remove destructive 删除 移除 破坏",
  "network.transfer.upload": "upload exfiltration remote 上传 外传 远程",
});
const QUERY_ALIASES = Object.freeze({
  "谁": "who actor source user ai automatic 谁 用户 人工 自动",
  "批准": "approve approved allowed approval decision allow 批准 允许 审批",
  "授权": "authorization permission approval authorize 授权 权限 审批",
  "数据库": "database db sql mysql postgres sqlite 数据库 数据表",
  "修改": "change write update alter mutation 修改 写入 更新",
  "危险": "risk dangerous sensitive critical high 风险 危险 敏感",
  "读取": "read access inspect 读取 访问",
  "写入": "write update overwrite 写入 修改 覆盖",
  "移动": "move mv rename source destination 移动 重命名",
});

function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function boundedText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function boundedList(value, maxItems = 32, maxLength = 128) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => boundedText(item, maxLength)).filter(Boolean))]
    .slice(0, maxItems);
}

function parseDate(value, field) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw protocolError(`invalid_${field}`);
  return new Date(parsed);
}

function normalizeDomain(value) {
  const domain = boundedText(value, 32).toLowerCase();
  if (!DOMAINS.has(domain)) throw protocolError("invalid_inquiry_domain");
  return domain;
}

function normalizeRequest(sessionId, request = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw protocolError("invalid_inquiry_request");
  }
  if (request.protocol_version != null && request.protocol_version !== "1") {
    throw protocolError("unsupported_protocol_version");
  }
  const queryId = requireInquiryId(request.query_id, "query_id", "inq_");
  const domain = normalizeDomain(request.domain);
  const query = boundedText(request.query ?? request.question, 32_000);
  if (!query) throw protocolError("inquiry_query_required");
  const scope = request.scope && typeof request.scope === "object" && !Array.isArray(request.scope)
    ? request.scope
    : {};
  const scopedSessions = boundedList(scope.agent_session_ids, 32, 64);
  if (scopedSessions.length > 0 && !scopedSessions.includes(sessionId)) {
    throw protocolError("session_outside_inquiry_scope");
  }
  const since = parseDate(scope.since, "scope_since");
  const until = parseDate(scope.until, "scope_until");
  if (since && until && since > until) throw protocolError("invalid_scope_time_range");
  const risks = boundedList(scope.risks, 8, 16).map((item) => item.toLowerCase());
  if (risks.some((item) => !(item in RISK_ORDER))) throw protocolError("invalid_scope_risk");
  const tools = boundedList(scope.tools, 32, 128).map((item) => item.toLowerCase());
  const topK = Math.max(1, Math.min(20, Number(request.top_k ?? request.topK) || 12));
  const tokenBudget = Math.max(256, Math.min(8000, Number(request.token_budget ?? request.tokenBudget) || 4000));
  return {
    queryId,
    domain,
    query,
    queryPlan: request.query_plan && typeof request.query_plan === "object"
      ? request.query_plan
      : null,
    topK,
    tokenBudget,
    since,
    until,
    risks,
    tools,
    scope: {
      agent_session_ids: [sessionId],
      ...(since ? { since: since.toISOString() } : {}),
      ...(until ? { until: until.toISOString() } : {}),
      ...(risks.length > 0 ? { risks } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    },
  };
}

function searchTokens(value) {
  const original = boundedText(value, 32_000).toLowerCase();
  const expansions = Object.entries(QUERY_ALIASES)
    .filter(([term]) => original.includes(term))
    .map(([, aliases]) => aliases)
    .join(" ");
  const normalized = `${original} ${expansions}`;
  const tokens = new Set();
  for (const token of normalized.match(/[\p{L}\p{N}_-]+/gu) || []) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length >= 2) tokens.add(token);
      for (let index = 0; index < token.length - 1; index += 1) {
        tokens.add(token.slice(index, index + 2));
      }
    } else if (token.length >= 2) {
      tokens.add(token);
    }
  }
  return [...tokens].slice(0, 128);
}

function recordTime(record) {
  const raw = record.updatedAt || record.createdAt;
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function sourceType(domain, record) {
  if (domain === "approval") {
    if (
      record.phase === "auto_resolved"
      || record.decisionSource === "automatic"
      || record.decisionSource === "ai_reviewer"
    ) {
      return "approval_policy_evaluation";
    }
    if (record.outcome === "pending" || record.phase === "requested") return "approval_request";
    return "approval_decision";
  }
  if (record.actionKind === "database_mutation") return "database_change";
  if (["remote_mutation", "system_mutation"].includes(record.actionKind)) {
    return "infrastructure_change";
  }
  if (["destructive_command", "potential_script_mutation"].includes(record.actionKind)) {
    return "command_execution";
  }
  return "agent_audit";
}

function sensitivity(record) {
  if (["critical", "high"].includes(record.risk)) return "high";
  if (record.risk === "elevated") return "sensitive";
  return "normal";
}

function recordSearchText(record) {
  const operation = record.detail?.operation || {};
  const aiReview = record.detail?.aiReview || record.detail?.ai_review || {};
  return [
    record.title,
    record.summary,
    record.actionKind,
    ACTION_SEARCH_ALIASES[record.actionKind] || "",
    record.risk,
    record.outcome,
    record.decisionSource,
    record.tool,
    record.commandPreview,
    record.cwd,
    record.target,
    ...(operation.actions || []),
    ...(operation.actions || []).map((item) => ACTION_SEARCH_ALIASES[item] || ""),
    ...(operation.resources || []).flatMap((item) => [item.value, item.class, item.role]),
    operation.reason,
    aiReview.reason,
    ...(aiReview.signals || []),
    ...(aiReview.conditions || []),
  ].map((item) => boundedText(item, 4096)).filter(Boolean).join(" ").toLowerCase();
}

function keywordScore(query, record) {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return 0;
  const haystack = recordSearchText(record);
  let matches = 0;
  for (const token of tokens) if (haystack.includes(token)) matches += 1;
  const phraseBonus = haystack.includes(query.trim().toLowerCase()) ? 0.25 : 0;
  return Math.min(1, matches / Math.max(1, Math.min(tokens.length, 8)) + phraseBonus);
}

function exactTokens(value) {
  return [...new Set((boundedText(value, 32_000).match(
    /(?:https?:\/\/\S+|(?:[A-Za-z]:)?[/\\][^\s]+|[A-Za-z][A-Za-z0-9]*(?:[_./:-][A-Za-z0-9]+)+|\b(?:[A-Z]{2,}[A-Z0-9_]*|[45]\d\d)\b)/g,
  ) || []).map((item) => item.replace(/[.,;:!?\])}]+$/, "").toLowerCase()).filter((item) => item.length >= 3))].slice(0, 16);
}

function exactScore(query, record) {
  const tokens = exactTokens(query);
  if (tokens.length === 0) return 0;
  const haystack = recordSearchText(record);
  return tokens.filter((item) => haystack.includes(item)).length / tokens.length;
}

function temporalScore(record, now) {
  const occurredAt = recordTime(record);
  if (!occurredAt) return 0;
  const ageDays = Math.max(0, now.getTime() - occurredAt.getTime()) / 86_400_000;
  return Number((1 / (1 + ageDays / 30)).toFixed(6));
}

function evidenceSummary(record) {
  const parts = [boundedText(record.summary, 2048) || boundedText(record.title, 512)];
  if (record.outcome) parts.push(`outcome=${boundedText(record.outcome, 32)}`);
  if (record.risk) parts.push(`risk=${boundedText(record.risk, 16)}`);
  if (record.decisionSource) parts.push(`source=${boundedText(record.decisionSource, 32)}`);
  if (record.tool) parts.push(`tool=${boundedText(record.tool, 128)}`);
  const operation = record.detail?.operation || {};
  if (operation.reason) parts.push(`analysis=${boundedText(operation.reason, 1024)}`);
  const aiReview = record.detail?.aiReview || record.detail?.ai_review || {};
  if (aiReview.reason) parts.push(`ai=${boundedText(aiReview.reason, 1024)}`);
  return boundedText(parts.filter(Boolean).join("; "), 8000) || "Agent audit record";
}

function evidenceExcerpt(record) {
  const parts = [];
  if (record.commandPreview) parts.push(`command: ${boundedText(record.commandPreview, 1536)}`);
  if (record.target) parts.push(`target: ${boundedText(record.target, 2048)}`);
  if (record.cwd) parts.push(`cwd: ${boundedText(record.cwd, 2048)}`);
  const operation = record.detail?.operation || {};
  if (Array.isArray(operation.resources) && operation.resources.length > 0) {
    parts.push(`resources: ${boundedText(operation.resources.map((item) => `${item.role || "target"}:${item.value} (${item.class})`).join(", "), 4096)}`);
  }
  return parts.length > 0 ? boundedText(parts.join("\n"), 16_000) : null;
}

function buildEvidenceItem(sessionId, domain, ranked) {
  const { record, keyword, exact = 0, temporal, final } = ranked;
  const sourceId = boundedText(record.auditId, 191) || `audit-${record.sequence}`;
  const canonical = {
    domain,
    session_id: sessionId,
    source_id: sourceId,
    sequence: Number(record.sequence || 0),
    hash: boundedText(record.hash, 128),
  };
  const item = {
    evidence_id: stableProtocolId("ev_", JSON.stringify(canonical)),
    source_type: sourceType(domain, record),
    source_id: sourceId,
    title: boundedText(record.title, 256) || (domain === "approval" ? "Approval record" : "Change record"),
    summary: evidenceSummary(record),
    excerpt: evidenceExcerpt(record),
    occurred_at: recordTime(record)?.toISOString() || null,
    sensitivity: sensitivity(record),
    confidence: Number(final.toFixed(6)),
    content_hash: contentHash(canonical),
    locator: {
      session_id: sessionId,
      audit_id: sourceId,
      sequence: Number(record.sequence || 0),
      correlation_id: boundedText(record.correlationId, 191),
    },
    metadata: {
      category: domain,
      phase: boundedText(record.phase, 32),
      action_kind: boundedText(record.actionKind, 64),
      risk: boundedText(record.risk, 16),
      outcome: boundedText(record.outcome, 32),
      decision_source: boundedText(record.decisionSource, 32),
      tool: boundedText(record.tool, 128),
      record_hash: boundedText(record.hash, 128),
      analysis_source: boundedText(record.decisionSource, 32),
      operation_actions: Array.isArray(record.detail?.operation?.actions)
        ? record.detail.operation.actions.slice(0, 32)
        : [],
      analysis_confidence: Number(record.detail?.aiReview?.confidence ?? record.detail?.operation?.confidence ?? 0),
    },
    retrieval_signals: {
      exact: Number(exact.toFixed(6)),
      keyword: Number(keyword.toFixed(6)),
      temporal: Number(temporal.toFixed(6)),
      final: Number(final.toFixed(6)),
    },
  };
  assertNoSecretFields(item);
  return item;
}

function estimatedTokens(item) {
  return Math.max(1, Math.ceil(JSON.stringify(item).length / 4));
}

export function buildAuditEvidenceBundle({
  auditStore,
  sessionId,
  request,
  now = () => new Date(),
} = {}) {
  if (!auditStore || typeof auditStore.list !== "function") {
    throw protocolError("audit_store_unavailable");
  }
  const normalizedSessionId = boundedText(sessionId, 64);
  if (!normalizedSessionId) throw protocolError("invalid_agent_session_id");
  const input = normalizeRequest(normalizedSessionId, request);
  const records = [];
  let beforeCursor = null;
  let hasMore = false;
  do {
    const page = auditStore.list(normalizedSessionId, {
      category: input.domain,
      beforeCursor,
      limit: 100,
    });
    records.push(...page.records);
    hasMore = page.hasMore;
    beforeCursor = page.nextCursor;
  } while (hasMore && beforeCursor && records.length < MAX_AUDIT_SCAN);
  const nowValue = now();
  const currentTime = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const candidates = records.filter((record) => {
    const occurredAt = recordTime(record);
    if (input.since && (!occurredAt || occurredAt < input.since)) return false;
    if (input.until && (!occurredAt || occurredAt > input.until)) return false;
    if (input.risks.length > 0 && !input.risks.includes(String(record.risk || "").toLowerCase())) return false;
    if (input.tools.length > 0 && !input.tools.includes(String(record.tool || "").toLowerCase())) return false;
    return true;
  });
  const expandedTerms = Array.isArray(input.queryPlan?.terms)
    ? input.queryPlan.terms.map((item) => boundedText(item, 128)).filter(Boolean).slice(0, 24)
    : [];
  const expandedQuery = [input.query, ...expandedTerms].join(" ");
  const plannedActions = Array.isArray(input.queryPlan?.actions)
    ? input.queryPlan.actions.map((item) => String(item).toLowerCase()).slice(0, 12)
    : [];
  const plannedOutcomes = Array.isArray(input.queryPlan?.outcomes)
    ? input.queryPlan.outcomes.map((item) => String(item).toLowerCase()).slice(0, 8)
    : [];
  const ranked = candidates.map((record) => {
    const keyword = keywordScore(expandedQuery, record);
    const exact = exactScore(input.query, record);
    const structured = Math.max(
      plannedActions.some((item) => recordSearchText(record).includes(item)) ? 1 : 0,
      plannedOutcomes.includes(String(record.outcome || "").toLowerCase()) ? 1 : 0,
    );
    const temporal = temporalScore(record, currentTime);
    const final = exact > 0
      ? exact * 0.65 + keyword * 0.2 + structured * 0.1 + temporal * 0.05
      : keyword > 0 || structured > 0
        ? keyword * 0.78 + structured * 0.17 + temporal * 0.05
        : 0;
    return { record, keyword, exact, temporal, final };
  }).sort((left, right) => right.final - left.final || Number(right.record.sequence || 0) - Number(left.record.sequence || 0));

  const matched = ranked.some((item) => item.exact > 0 || item.keyword > 0);
  const selected = matched
    ? ranked.filter((item) => item.exact > 0 || item.keyword > 0)
    : [];

  const warnings = [];
  if (ranked.length > 0 && !matched) warnings.push("no_relevant_audit_evidence");
  const evidence = [];
  let usedTokens = 0;
  for (const candidate of selected.slice(0, input.topK)) {
    const item = buildEvidenceItem(normalizedSessionId, input.domain, candidate);
    const cost = estimatedTokens(item);
    if (evidence.length > 0 && usedTokens + cost > input.tokenBudget) {
      warnings.push("token_budget_truncated");
      break;
    }
    evidence.push(item);
    usedTokens += cost;
  }
  if (evidence.length === 0) warnings.push("no_matching_evidence");
  if (hasMore) warnings.push("audit_scan_limited");

  const bundle = {
    protocol_version: "1",
    bundle_id: stableProtocolId(
      "evb_",
      `${input.queryId}:${input.domain}:${evidence.map((item) => item.evidence_id).join(":")}`,
    ),
    query_id: input.queryId,
    domain: input.domain,
    scope: input.scope,
    generated_at: currentTime.toISOString(),
    expires_at: null,
    evidence,
    warnings: [...new Set(warnings)],
    policy: { ...EVIDENCE_POLICY },
    retrieval: {
      strategy: "audit_exact_structured_lexical_v2",
      candidate_count: candidates.length,
      returned_count: evidence.length,
      token_budget: input.tokenBudget,
      estimated_tokens: usedTokens,
      degraded: false,
      scan_count: records.length,
      exact_tokens: exactTokens(input.query),
      query_plan: input.queryPlan || null,
      abstained: evidence.length === 0,
    },
  };
  assertNoSecretFields(bundle);
  return bundle;
}
