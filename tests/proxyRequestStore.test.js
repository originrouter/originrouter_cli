import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROXY_REQUEST_MAX_LIMIT,
  ProxyRequestStore,
} from "../src/persistence/proxyRequestStore.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-proxy-requests-"));
const now = () => new Date("2026-07-26T12:00:00.000Z");
const store = new ProxyRequestStore({ stateDir, now, maxRecords: 100 });

try {
  for (let index = 0; index < 25; index += 1) {
    store.record({
      requestId: `req-${String(index).padStart(2, "0")}`,
      routeName: index % 2 === 0 ? "claude.main" : "codex.main",
      model: index === 7 ? "needle-model" : `model-${index % 3}`,
      status: index % 3 === 0 ? "failed" : "success",
      createdAt: "2026-07-26T10:00:00.000Z",
      prompt: "must never be persisted",
      apiKey: "sk-must-never-be-persisted",
    });
  }

  const first = store.listPage({ limit: 10 });
  assert.equal(first.requests.length, 10);
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor);
  assert.deepEqual(
    first.requests.map((request) => request.request_id),
    Array.from({ length: 10 }, (_, index) => `req-${24 - index}`),
  );

  const second = store.listPage({ limit: 10, cursor: first.next_cursor });
  const third = store.listPage({ limit: 10, cursor: second.next_cursor });
  assert.equal(second.requests.length, 10);
  assert.equal(second.has_more, true);
  assert.equal(third.requests.length, 5);
  assert.equal(third.has_more, false);
  assert.equal(third.next_cursor, null);
  const allIds = [...first.requests, ...second.requests, ...third.requests]
    .map((request) => request.request_id);
  assert.equal(new Set(allIds).size, 25, "cursor pages must not duplicate rows");
  assert.deepEqual(
    allIds,
    Array.from(
      { length: 25 },
      (_, index) => `req-${String(24 - index).padStart(2, "0")}`,
    ),
    "cursor pages must preserve stable newest-first ordering",
  );

  const failed = store.listPage({ status: "failed", limit: 100 });
  assert.ok(failed.requests.length > 0);
  assert.ok(failed.requests.every((request) => request.status === "failed"));

  assert.deepEqual(
    store.listPage({ query: "needle-model" }).requests.map((request) => request.request_id),
    ["req-07"],
  );
  assert.ok(store.listPage({ query: "claude.main" }).requests.length > 0);
  assert.deepEqual(
    store.listPage({ query: "req-03" }).requests.map((request) => request.request_id),
    ["req-03"],
  );

  const projectedKeys = Object.keys(first.requests[0]).sort();
  assert.deepEqual(projectedKeys, [
    "created_at",
    "model",
    "request_id",
    "route_name",
    "status",
  ]);
  const columns = store.db.prepare("PRAGMA table_info(proxy_requests)").all()
    .map((column) => column.name);
  assert.deepEqual(columns, [
    "sequence",
    "request_id",
    "route_name",
    "model",
    "status",
    "created_at",
  ]);

  assert.throws(() => store.listPage({ cursor: "not-a-cursor" }), /cursor is invalid/);
  assert.throws(() => store.listPage({ status: "running" }), /status must be/);
  assert.equal(store.listPage({ limit: 1000 }).limit, PROXY_REQUEST_MAX_LIMIT);

  store.record({
    requestId: "expired-request",
    routeName: "claude.main",
    model: "old-model",
    status: "success",
    createdAt: "2026-06-01T00:00:00.000Z",
  });
  assert.equal(store.listPage({ query: "expired-request" }).requests.length, 0);

  for (let index = 25; index < 130; index += 1) {
    store.record({
      requestId: `req-${String(index).padStart(3, "0")}`,
      routeName: "claude.main",
      model: "bulk-model",
      status: "completed",
      createdAt: "2026-07-26T11:00:00.000Z",
    });
  }
  const count = store.db.prepare("SELECT COUNT(*) AS count FROM proxy_requests").get().count;
  assert.equal(count, 100, "retention cap must bound the local database");

  console.log("proxy request store ok");
} finally {
  store.close();
  rmSync(stateDir, { recursive: true, force: true });
}
