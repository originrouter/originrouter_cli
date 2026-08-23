import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assessRegisteredWorkspaceForUnattended,
  assessUnattendedWorkspace,
  preflightUnattendedWorkspaceAuthorization,
  requireRemoteWorkspacePathPreflight,
} from "../src/runtime/unattendedWorkspaceReadiness.js";

const noAccessCheck = { checkAccess: false };

test("macOS protected folders require local authorization before a remote Run", () => {
  const result = assessUnattendedWorkspace("/Users/alice/Desktop/project", {
    ...noAccessCheck,
    platformName: "darwin",
    homeDirectory: "/Users/alice",
  });
  assert.equal(result.remote_eligible, false);
  assert.equal(result.code, "MACOS_TCC_PROTECTED_WORKSPACE");
  assert.equal(result.status, "requires_local_authorization");
  assert.match(result.action, /remote workspace authorize/);
});

test("macOS local development folders remain eligible", () => {
  const result = assessUnattendedWorkspace("/Users/alice/Developer/project", {
    ...noAccessCheck,
    platformName: "darwin",
    homeDirectory: "/Users/alice",
  });
  assert.equal(result.remote_eligible, true);
});

test("a locally authorized protected workspace becomes eligible only for the same runtime identity", () => {
  const workspace = {
    canonical_path: "/Users/alice/Desktop/project",
    unattended_authorized_at: "2026-08-21T00:00:00.000Z",
    unattended_authorization_subject: "/opt/homebrew/bin/node",
  };
  const common = {
    ...noAccessCheck,
    platformName: "darwin",
    homeDirectory: "/Users/alice",
  };
  assert.equal(
    assessRegisteredWorkspaceForUnattended(workspace, {
      ...common,
      subject: "/opt/homebrew/bin/node",
    }).remote_eligible,
    true,
  );
  assert.equal(
    assessRegisteredWorkspaceForUnattended(workspace, {
      ...common,
      subject: "/usr/local/bin/node",
    }).status,
    "requires_local_authorization",
  );
});

test("Windows protected, synced, and network workspaces are rejected", () => {
  const common = { ...noAccessCheck, platformName: "win32", homeDirectory: "C:\\Users\\alice" };
  assert.equal(
    assessUnattendedWorkspace("C:\\Users\\alice\\Documents\\project", common).code,
    "WINDOWS_PROTECTED_OR_SYNCED_WORKSPACE",
  );
  assert.equal(
    assessUnattendedWorkspace("C:\\Users\\alice\\OneDrive - Acme\\project", {
      ...common,
      env: { OneDriveCommercial: "C:\\Users\\alice\\OneDrive - Acme" },
    }).code,
    "WINDOWS_PROTECTED_OR_SYNCED_WORKSPACE",
  );
  assert.equal(
    assessUnattendedWorkspace("\\\\fileserver\\share\\project", common).code,
    "WINDOWS_NETWORK_WORKSPACE",
  );
});

test("Linux interactive mounts are rejected while normal local paths remain eligible", () => {
  assert.equal(
    assessUnattendedWorkspace("/run/user/1000/gvfs/sftp:host=server/project", {
      ...noAccessCheck,
      platformName: "linux",
    }).code,
    "LINUX_INTERACTIVE_MOUNT_WORKSPACE",
  );
  assert.equal(
    assessUnattendedWorkspace("/home/alice/Developer/project", {
      ...noAccessCheck,
      platformName: "linux",
    }).remote_eligible,
    true,
  );
});

test("an inaccessible otherwise-safe workspace is rejected on every platform", () => {
  const result = assessUnattendedWorkspace("/home/alice/Developer/project", {
    platformName: "linux",
    access() {
      const error = new Error("denied");
      error.code = "EACCES";
      throw error;
    },
  });
  assert.equal(result.code, "WORKSPACE_ACCESS_UNAVAILABLE");
  assert.equal(result.os_error, "EACCES");
});

test("a remote directory request rejects protected paths without touching the filesystem", () => {
  assert.throws(() => requireRemoteWorkspacePathPreflight("/Users/alice/Desktop/project", {
    platformName: "darwin",
    homeDirectory: "/Users/alice",
    access() {
      throw new Error("must not access a protected remote path");
    },
  }), { code: "MACOS_TCC_PROTECTED_WORKSPACE" });
  assert.equal(
    requireRemoteWorkspacePathPreflight("/Users/alice/Developer/project", {
      platformName: "darwin",
      homeDirectory: "/Users/alice",
    }).remote_eligible,
    true,
  );
});

test("local authorization verifies a real write and removes its preflight directory", () => {
  const workspace = mkdtempSync(join(tmpdir(), "originrouter-preflight-test-"));
  try {
    preflightUnattendedWorkspaceAuthorization(workspace);
    assert.equal(
      readdirSync(workspace).some((entry) => entry.startsWith(".originrouter-access-")),
      false,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
