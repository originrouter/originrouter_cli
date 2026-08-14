#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import Database from "better-sqlite3";

import { CollaborationStore } from "../src/collaboration/collaborationStore.js";

const sourcePath = resolve(
  process.argv[2] || join(process.env.HOME || "", ".originrouter", "collaboration.sqlite3"),
);
if (!existsSync(sourcePath)) {
  console.error(`Collaboration database was not found: ${sourcePath}`);
  process.exitCode = 2;
} else {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "originrouter-collaboration-migration-"),
  );
  const copyPath = join(temporaryDirectory, basename(sourcePath));
  let source = null;
  let migrated = null;
  try {
    source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    const sourceIntegrity = source.pragma("integrity_check", { simple: true });
    if (sourceIntegrity !== "ok") {
      throw new Error(`Source database integrity check returned: ${sourceIntegrity}`);
    }
    const before = {
      runs: Number(source.prepare(
        "SELECT COUNT(*) AS count FROM collaboration_runs",
      ).get()?.count || 0),
      events: Number(source.prepare(
        "SELECT COUNT(*) AS count FROM collaboration_execution_events",
      ).get()?.count || 0),
    };
    await source.backup(copyPath);
    source.close();
    source = null;

    migrated = new CollaborationStore({ dbPath: copyPath });
    const migratedIntegrity = migrated.db.pragma("integrity_check", {
      simple: true,
    });
    if (migratedIntegrity !== "ok") {
      throw new Error(`Migrated copy integrity check returned: ${migratedIntegrity}`);
    }
    const after = {
      runs: Number(migrated.db.prepare(
        "SELECT COUNT(*) AS count FROM collaboration_runs",
      ).get()?.count || 0),
      events: Number(migrated.db.prepare(
        "SELECT COUNT(*) AS count FROM collaboration_execution_events",
      ).get()?.count || 0),
    };
    if (before.runs !== after.runs || before.events !== after.events) {
      throw new Error(
        `Row count changed during migration verification: ${JSON.stringify({ before, after })}`,
      );
    }
    for (const run of migrated.listRuns({ limit: 200, includeArchived: true })) {
      const snapshot = migrated.getSnapshot(run.run_id);
      if (!snapshot || snapshot.schema_version !== 2) {
        throw new Error(`Run ${run.run_id} did not produce a V2 snapshot.`);
      }
    }
    console.log("Collaboration migration verification passed.");
    console.log(`  Source: ${sourcePath}`);
    console.log(`  Runs: ${after.runs}`);
    console.log(`  Events: ${after.events}`);
    console.log("  Original database: unchanged");
  } catch (error) {
    console.error(`Collaboration migration verification failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    try { source?.close(); } catch {}
    try { migrated?.close(); } catch {}
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

