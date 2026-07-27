import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browseAgentWorkspaces } from "../src/daemon/workspaceBrowser.js";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";

const root = mkdtempSync(join(tmpdir(), "originrouter-workspace-browser-"));
const stateDir = join(root, "state");
const projects = join(root, "projects");
const alpha = join(projects, "alpha-app");
mkdirSync(stateDir);
mkdirSync(alpha, { recursive: true });
mkdirSync(join(projects, "beta-app"), { recursive: true });
mkdirSync(join(projects, ".hidden-app"));
writeFileSync(join(projects, "notes.txt"), "not a directory");

const catalog = new AgentCatalog({ stateDir });
try {
  let page = await browseAgentWorkspaces({ path: projects, catalog, deviceId: "device-1" });
  assert.equal(page.current_path, realpathSync(projects));
  assert.deepEqual(page.entries.map((item) => item.name), ["alpha-app", "beta-app"]);
  assert.equal(page.entries.every((item) => item.trusted === false), true);

  page = await browseAgentWorkspaces({
    path: join(projects, "al"),
    catalog,
    deviceId: "device-1",
  });
  assert.equal(page.current_path, realpathSync(projects));
  assert.deepEqual(page.entries.map((item) => item.name), ["alpha-app"]);

  page = await browseAgentWorkspaces({
    path: projects,
    query: ".h",
    catalog,
    deviceId: "device-1",
  });
  assert.deepEqual(page.entries.map((item) => item.name), [".hidden-app"]);

  const workspace = catalog.trustWorkspace(alpha, { deviceId: "device-1" });
  assert.equal(workspace.trusted, true);
  assert.equal(workspace.canonical_path, realpathSync(alpha));

  page = await browseAgentWorkspaces({
    path: projects,
    query: "alpha",
    catalog,
    deviceId: "device-1",
  });
  assert.equal(page.entries[0].trusted, true);
  assert.equal(page.entries[0].workspace_id, workspace.workspace_id);

  assert.throws(
    () => catalog.trustWorkspace("/", { deviceId: "device-1" }),
    (error) => error.code === "WORKSPACE_UNSAFE",
  );
} finally {
  catalog.close();
}

console.log("workspace browser tests passed");
