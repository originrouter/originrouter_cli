import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browseAgentWorkspaces } from "../src/daemon/workspaceBrowser.js";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";

const root = mkdtempSync(join(tmpdir(), "originrouter-workspace-browser-"));
const stateDir = join(root, "state");
const projects = join(root, "projects");
const alpha = join(projects, "alpha-app");
const nested = join(alpha, "nested-app");
const outside = join(root, "outside-app");
mkdirSync(stateDir);
mkdirSync(nested, { recursive: true });
mkdirSync(outside);
symlinkSync(outside, join(alpha, "outside-link"));
mkdirSync(join(projects, "beta-app"), { recursive: true });
mkdirSync(join(projects, "missing-parent-project"));
mkdirSync(join(projects, ".hidden-app"));
writeFileSync(join(projects, "notes.txt"), "not a directory");

const catalog = new AgentCatalog({ stateDir });
try {
  let page = await browseAgentWorkspaces({ path: projects, catalog, deviceId: "device-1" });
  assert.equal(page.current_path, realpathSync(projects));
  assert.deepEqual(page.entries.map((item) => item.name), ["alpha-app", "beta-app", "missing-parent-project"]);
  assert.equal(page.entries.every((item) => item.trusted === false), true);

  page = await browseAgentWorkspaces({
    path: join(projects, "al"),
    catalog,
    deviceId: "device-1",
  });
  assert.equal(page.current_path, realpathSync(projects));
  assert.deepEqual(page.entries.map((item) => item.name), ["alpha-app"]);

  page = await browseAgentWorkspaces({
    path: join(projects, "missing-parent", "alpha"),
    catalog,
    deviceId: "device-1",
  });
  assert.equal(page.current_path, realpathSync(projects));
  assert.deepEqual(
    page.entries.map((item) => item.name),
    ["missing-parent-project"],
    "the first missing path segment is completed before deeper text",
  );

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

  page = await browseAgentWorkspaces({
    path: alpha,
    catalog,
    deviceId: "device-1",
  });
  const nestedEntry = page.entries.find((item) => item.name === "nested-app");
  assert.equal(nestedEntry.trusted, true);
  assert.equal(nestedEntry.workspace_id, "", "inherited children must launch by exact path");
  const outsideLink = page.entries.find((item) => item.name === "outside-link");
  assert.equal(outsideLink.trusted, false, "symlinks outside the trusted parent must not inherit");
  assert.equal(
    catalog.getTrustedWorkspaceForPath(nested, { deviceId: "device-1" })
      .inherited_from_workspace_id,
    workspace.workspace_id,
  );
  assert.equal(
    catalog.getTrustedWorkspaceForPath(join(projects, "beta-app"), {
      deviceId: "device-1",
    }),
    null,
  );

  assert.throws(
    () => catalog.trustWorkspace("/", { deviceId: "device-1" }),
    (error) => error.code === "WORKSPACE_UNSAFE",
  );
} finally {
  catalog.close();
}

console.log("workspace browser tests passed");
