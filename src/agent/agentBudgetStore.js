import { chmodSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { ensureStateDir } from "../persistence/state.js";

const AGENTS = new Set(["claude", "codex"]);
const ENFORCEMENT = new Set(["block", "warn"]);

function integerOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("budget limits must be positive numbers");
  }
  return Math.floor(parsed);
}

function normalizePolicy(value = {}) {
  const currency = String(value.currency || "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("budget currency must be a 3-letter code");
  const enforcement = String(value.enforcement || "block").trim().toLowerCase();
  if (!ENFORCEMENT.has(enforcement)) throw new Error("budget enforcement must be block or warn");
  return {
    daily_token_limit: integerOrNull(value.daily_token_limit ?? value.dailyTokenLimit),
    weekly_token_limit: integerOrNull(value.weekly_token_limit ?? value.weeklyTokenLimit),
    daily_amount_limit_micros: integerOrNull(
      value.daily_amount_limit_micros ?? value.dailyAmountLimitMicros,
    ),
    weekly_amount_limit_micros: integerOrNull(
      value.weekly_amount_limit_micros ?? value.weeklyAmountLimitMicros,
    ),
    currency,
    enforcement,
  };
}

function periodStart(now, period) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  if (period === "weekly") {
    const day = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  }
  return date.toISOString();
}

function publicPolicy(row) {
  if (!row) return normalizePolicy();
  return {
    daily_token_limit: row.daily_token_limit,
    weekly_token_limit: row.weekly_token_limit,
    daily_amount_limit_micros: row.daily_amount_limit_micros,
    weekly_amount_limit_micros: row.weekly_amount_limit_micros,
    currency: row.currency,
    enforcement: row.enforcement,
  };
}

export class AgentBudgetStore {
  constructor({ stateDir = ensureStateDir(), now = () => new Date() } = {}) {
    this.now = now;
    this.dbPath = join(stateDir, "agent-budgets.sqlite3");
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.installSchema();
    try { chmodSync(this.dbPath, 0o600); } catch {}
  }

  installSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_budget_policies (
        scope TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT '',
        daily_token_limit INTEGER,
        weekly_token_limit INTEGER,
        daily_amount_limit_micros INTEGER,
        weekly_amount_limit_micros INTEGER,
        currency TEXT NOT NULL DEFAULT 'USD',
        enforcement TEXT NOT NULL DEFAULT 'block',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, agent)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_budget_receipts (
        event_id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        sampled_tokens INTEGER NOT NULL DEFAULT 0,
        amount_micros INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_agent_budget_receipts_created
        ON agent_budget_receipts(created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_budget_receipts_agent_created
        ON agent_budget_receipts(agent, created_at);
    `);
  }

  close() {
    if (this.db?.open) this.db.close();
  }

  setPolicies(input = {}) {
    const device = normalizePolicy(input.device || {});
    const agents = input.agents && typeof input.agents === "object" ? input.agents : {};
    const updatedAt = new Date(this.now()).toISOString();
    const upsert = this.db.prepare(`
      INSERT INTO agent_budget_policies(
        scope, agent, daily_token_limit, weekly_token_limit,
        daily_amount_limit_micros, weekly_amount_limit_micros,
        currency, enforcement, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, agent) DO UPDATE SET
        daily_token_limit = excluded.daily_token_limit,
        weekly_token_limit = excluded.weekly_token_limit,
        daily_amount_limit_micros = excluded.daily_amount_limit_micros,
        weekly_amount_limit_micros = excluded.weekly_amount_limit_micros,
        currency = excluded.currency,
        enforcement = excluded.enforcement,
        updated_at = excluded.updated_at
    `);
    this.db.transaction(() => {
      upsert.run(
        "device", "", device.daily_token_limit, device.weekly_token_limit,
        device.daily_amount_limit_micros, device.weekly_amount_limit_micros,
        device.currency, device.enforcement, updatedAt,
      );
      for (const agent of AGENTS) {
        const policy = normalizePolicy(agents[agent] || {});
        upsert.run(
          "agent", agent, policy.daily_token_limit, policy.weekly_token_limit,
          policy.daily_amount_limit_micros, policy.weekly_amount_limit_micros,
          policy.currency, policy.enforcement, updatedAt,
        );
      }
    })();
    return this.snapshot();
  }

  policy(scope, agent = "") {
    return publicPolicy(this.db.prepare(
      "SELECT * FROM agent_budget_policies WHERE scope = ? AND agent = ?",
    ).get(scope, agent));
  }

  usage({ agent = null, period = "daily" } = {}) {
    const start = periodStart(this.now(), period);
    const row = agent
      ? this.db.prepare(`
          SELECT COALESCE(SUM(sampled_tokens), 0) AS sampled_tokens,
                 COALESCE(SUM(amount_micros), 0) AS amount_micros
          FROM agent_budget_receipts WHERE agent = ? AND created_at >= ?
        `).get(agent, start)
      : this.db.prepare(`
          SELECT COALESCE(SUM(sampled_tokens), 0) AS sampled_tokens,
                 COALESCE(SUM(amount_micros), 0) AS amount_micros
          FROM agent_budget_receipts WHERE created_at >= ?
        `).get(start);
    return {
      sampled_tokens: Number(row?.sampled_tokens || 0),
      amount_micros: Number(row?.amount_micros || 0),
      starts_at: start,
    };
  }

  status(scope, agent = "") {
    const policy = this.policy(scope, agent);
    const daily = this.usage({ agent: scope === "agent" ? agent : null, period: "daily" });
    const weekly = this.usage({ agent: scope === "agent" ? agent : null, period: "weekly" });
    const ratios = [
      policy.daily_token_limit ? daily.sampled_tokens / policy.daily_token_limit : 0,
      policy.weekly_token_limit ? weekly.sampled_tokens / policy.weekly_token_limit : 0,
      policy.daily_amount_limit_micros
        ? daily.amount_micros / policy.daily_amount_limit_micros
        : 0,
      policy.weekly_amount_limit_micros
        ? weekly.amount_micros / policy.weekly_amount_limit_micros
        : 0,
    ].filter(Number.isFinite);
    const ratio = Math.max(0, ...ratios);
    return {
      policy,
      daily,
      weekly,
      ratio,
      warning: ratio >= 0.8,
      exhausted: ratio >= 1,
      blocked: policy.enforcement === "block" && ratio >= 1,
    };
  }

  snapshot() {
    return {
      device: this.status("device"),
      agents: Object.fromEntries(
        [...AGENTS].map((agent) => [agent, this.status("agent", agent)]),
      ),
    };
  }

  recordUsage(input = {}) {
    const eventId = String(input.event_id ?? input.eventId ?? "").trim().slice(0, 195);
    const agent = String(input.agent || "").trim().toLowerCase();
    if (eventId.length < 8) throw new Error("budget usage event_id is required");
    if (!AGENTS.has(agent)) return { duplicate: false, ignored: true, snapshot: this.snapshot() };
    const sampledTokens = Math.max(
      0,
      Math.floor(Number(input.sampled_tokens ?? input.sampledTokens) || 0),
    );
    const currency = String(input.currency || "").trim().toUpperCase();
    const amountMicros = /^[A-Z]{3}$/.test(currency)
      ? Math.max(0, Math.floor(Number(input.amount_micros ?? input.amountMicros) || 0))
      : 0;
    const createdAt = new Date(input.created_at ?? input.createdAt ?? this.now()).toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO agent_budget_receipts(
        event_id, agent, sampled_tokens, amount_micros, currency, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(eventId, agent, sampledTokens, amountMicros, currency, createdAt);
    const snapshot = this.snapshot();
    return {
      duplicate: result.changes === 0,
      ignored: false,
      snapshot,
      blocked: snapshot.device.blocked || snapshot.agents[agent].blocked,
      warning: snapshot.device.warning || snapshot.agents[agent].warning,
    };
  }
}

