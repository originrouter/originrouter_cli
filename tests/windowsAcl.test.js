import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  currentUserSid,
  directoryAclIsRestricted,
  restrictDirectoryToCurrentUser,
} from "../src/utils/windowsAcl.js";
import { ensureStateDir } from "../src/persistence/state.js";

const IS_WINDOWS = platform() === "win32";

// Non-Windows: the module must be inert, never throwing and never claiming it
// changed anything. Every caller runs on all platforms.
if (!IS_WINDOWS) {
  const result = restrictDirectoryToCurrentUser(mkdtempSync(join(tmpdir(), "or-acl-")));
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.reason, "not_windows");
  // The read side reports "restricted" so callers do not warn on POSIX, where
  // the real protection is the 0700 mode bits.
  assert.equal(directoryAclIsRestricted("/tmp"), true);
}

if (IS_WINDOWS) {
  const sid = currentUserSid();
  assert.match(sid, /^S-1-[0-9-]+$/, "current user SID must resolve");

  const root = mkdtempSync(join(tmpdir(), "or-acl-"));
  const target = join(root, "state");
  mkdirSync(target, { recursive: true });

  const first = restrictDirectoryToCurrentUser(target);
  assert.equal(first.ok, true, `hardening failed: ${first.reason}`);
  assert.equal(first.changed, true, "a freshly created temp dir inherits a broader ACL");
  assert.equal(directoryAclIsRestricted(target), true, "ACL must read back as restricted");

  // Idempotent: the second call must detect the existing state and skip the
  // rewrite, which is what keeps ensureStateDir cheap on every command.
  const second = restrictDirectoryToCurrentUser(target);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false, "repeat hardening must be a no-op");
  assert.equal(second.reason, "already_restricted");

  // A directory that does not exist must fail closed, not throw.
  const missing = restrictDirectoryToCurrentUser(join(root, "does-not-exist"));
  assert.equal(missing.ok, false);
}

// ensureStateDir must work on every platform and leave a usable directory
// behind even when hardening is impossible.
const previousHome = process.env.ORIGINROUTER_HOME;
try {
  const home = join(mkdtempSync(join(tmpdir(), "or-state-")), "home");
  process.env.ORIGINROUTER_HOME = home;
  const created = ensureStateDir();
  assert.equal(created, home);
  assert.equal(existsSync(home), true, "state dir must exist");
  assert.equal(existsSync(join(home, "logs")), true, "logs dir must exist");
  // Called twice, as real command paths do.
  assert.equal(ensureStateDir(), home);
  if (IS_WINDOWS) {
    assert.equal(directoryAclIsRestricted(home), true, "state dir must end up restricted");
  }
} finally {
  if (previousHome === undefined) delete process.env.ORIGINROUTER_HOME;
  else process.env.ORIGINROUTER_HOME = previousHome;
}

console.log("windows ACL tests ok");
