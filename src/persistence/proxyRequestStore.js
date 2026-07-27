import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { ensureStateDir } from "./state.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_MAX_RECORDS = 5000;
const DEFAULT_RETENTION_DAYS = 30;

function safeText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function iso(value, now) {
  const parsed = value == null ? new Date(now()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError("createdAt must be a valid date");
  }
  return parsed.toISOString();
}

function normalizeStatus(value) {
  const status = safeText(value, 32).toLowerCase();
  if (["success", "succeeded", "complete", "completed", "ok"].includes(status)) {
    return "success";
  }
  if (["failed", "failure", "error", "cancelled", "canceled", "timeout"].includes(status)) {
    return "failed";
  }
  return "unknown";
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    created_at: row.created_at,
    sequence: Number(row.sequence),
  }), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (value == null || value === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    const createdAt = iso(parsed?.created_at, Date.now);
    const sequence = Number(parsed?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("invalid sequence");
    return { createdAt, sequence };
  } catch {
    throw new TypeError("cursor is invalid");
  }
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function publicRequest(row) {
  return {
    request_id: row.request_id,
    route_name: row.route_name,
    status: row.status,
    model: row.model || null,
    created_at: row.created_at,
  };
}

export class ProxyRequestStore {
  constructor({
    stateDir = ensureStateDir(),
    dbPath = null,
    now = () => new Date(),
    maxRecords = DEFAULT_MAX_RECORDS,
    retentionDays = DEFAULT_RETENTION_DAYS,
  } = {}) {
    this.stateDir = stateDir;
    this.dbPath = dbPath || join(stateDir, "proxy-requests.sqlite3");
    this.now = now;
    this.maxRecords = Math.max(100, Number(maxRecords) || DEFAULT_MAX_RECORDS);
    this.retentionDays = Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS);
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.installSchema();
    try { chmodSync(this.dbPath, 0o600); } catch {}
  }

  installSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_requests (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        route_name TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unknown'
          CHECK(status IN ('success', 'failed', 'unknown')),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_proxy_requests_time
        ON proxy_requests(created_at DESC, sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_proxy_requests_status_time
        ON proxy_requests(status, created_at DESC, sequence DESC);
    `);
  }

  close() {
    if (this.db?.open) this.db.close();
  }

  record({ requestId, routeName, model, status, createdAt } = {}) {
    const request = {
      requestId: safeText(requestId, 191) || `proxy_req_${randomUUID()}`,
      routeName: safeText(routeName, 191),
      model: safeText(model, 512),
      status: normalizeStatus(status),
      createdAt: iso(createdAt, this.now),
    };
    this.db.prepare(`
      INSERT INTO proxy_requests(request_id, route_name, model, status, created_at)
      VALUES (@requestId, @routeName, @model, @status, @createdAt)
      ON CONFLICT(request_id) DO UPDATE SET
        route_name = excluded.route_name,
        model = excluded.model,
        status = excluded.status,
        created_at = excluded.created_at
    `).run(request);
    this.prune();
    return this.db.prepare(`
      SELECT sequence, request_id, route_name, model, status, created_at
      FROM proxy_requests WHERE request_id = ?
    `).get(request.requestId);
  }

  prune() {
    const cutoff = new Date(
      new Date(this.now()).getTime() - this.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    this.db.prepare("DELETE FROM proxy_requests WHERE created_at < ?").run(cutoff);
    this.db.prepare(`
      DELETE FROM proxy_requests
      WHERE sequence IN (
        SELECT sequence FROM proxy_requests
        ORDER BY created_at DESC, sequence DESC
        LIMIT -1 OFFSET ?
      )
    `).run(this.maxRecords);
  }

  listPage({ limit = DEFAULT_LIMIT, cursor = null, status = "", query = "" } = {}) {
    const normalizedLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
    const normalizedStatus = safeText(status, 32).toLowerCase();
    if (normalizedStatus && !["success", "failed"].includes(normalizedStatus)) {
      throw new TypeError("status must be success or failed");
    }
    const decodedCursor = decodeCursor(cursor);
    const clauses = [];
    const params = { fetchLimit: normalizedLimit + 1 };
    if (decodedCursor) {
      clauses.push("(created_at < @cursorCreatedAt OR (created_at = @cursorCreatedAt AND sequence < @cursorSequence))");
      params.cursorCreatedAt = decodedCursor.createdAt;
      params.cursorSequence = decodedCursor.sequence;
    }
    if (normalizedStatus) {
      clauses.push("status = @status");
      params.status = normalizedStatus;
    }
    const normalizedQuery = safeText(query, 256);
    if (normalizedQuery) {
      clauses.push(`(
        request_id LIKE @query ESCAPE '\\'
        OR route_name LIKE @query ESCAPE '\\'
        OR model LIKE @query ESCAPE '\\'
      )`);
      params.query = `%${escapeLike(normalizedQuery)}%`;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT sequence, request_id, route_name, model, status, created_at
      FROM proxy_requests
      ${where}
      ORDER BY created_at DESC, sequence DESC
      LIMIT @fetchLimit
    `).all(params);
    const hasMore = rows.length > normalizedLimit;
    const pageRows = hasMore ? rows.slice(0, normalizedLimit) : rows;
    return {
      requests: pageRows.map(publicRequest),
      next_cursor: hasMore && pageRows.length > 0
        ? encodeCursor(pageRows[pageRows.length - 1])
        : null,
      has_more: hasMore,
      limit: normalizedLimit,
    };
  }
}

export const PROXY_REQUEST_DEFAULT_LIMIT = DEFAULT_LIMIT;
export const PROXY_REQUEST_MAX_LIMIT = MAX_LIMIT;
