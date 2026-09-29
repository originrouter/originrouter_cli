// Windows equivalent of `chmod 0700` on the state directory.
//
// Why this exists: fs.chmod is very nearly a no-op on Windows (Node can only
// toggle the read-only bit), so every `{ mode: 0o600 }` and `{ mode: 0o700 }`
// in this codebase silently does nothing there. Measured on Windows 11: a file
// written with mode 0o600 reports mode 666.
//
// What protects secrets today is ACL inheritance from the user profile, which
// grants only SYSTEM, Administrators and the owning user -- no `Users`, no
// `Everyone`. That is genuinely adequate for the default location, so this
// module is defence in depth for the cases inheritance does not cover:
// ORIGINROUTER_HOME pointed at a drive root, a shared volume, or any directory
// whose inherited ACL is broader than the profile's.
//
// Approach follows OpenSSH-for-Windows, which solves the same problem for
// private keys: reset inheritance and grant an explicit minimal set, via
// icacls. Chosen over DPAPI / Credential Manager because those would need a
// native module (this project ships none outside node-pty) or a PowerShell
// round trip per read, and the identity file is read on essentially every
// command. Directory-level hardening also means new files inherit the
// restriction for free, which is the same reason 0700 on a directory is what
// really protects POSIX secrets.
//
// Principals are addressed by SID, never by name: this must work on localized
// Windows (the dev box for this fix runs code page 936, where the built-in
// groups have Chinese display names).

import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const IS_WINDOWS = platform() === "win32";

// Well-known SIDs. S-1-5-18 = Local System. The current user's own SID is
// resolved at runtime; Administrators is deliberately left out of the grant
// list -- it keeps ownership and can always take access back, so naming it
// buys nothing.
const LOCAL_SYSTEM_SID = "S-1-5-18";

function runIcacls(args) {
  const result = spawnSync("icacls", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

// The token's own SID, via whoami. Cheaper and more reliable than parsing
// icacls output, and locale-independent because /user /nh prints the raw SID.
export function currentUserSid() {
  const result = spawnSync("whoami", ["/user", "/nh", "/fo", "csv"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  const match = String(result.stdout || "").match(/S-1-[0-9-]+/);
  return match?.[0] || null;
}

/**
 * True when `path`'s ACL grants nothing beyond the current user and SYSTEM.
 *
 * Used to skip the (process-spawning) repair on the overwhelmingly common
 * case where the ACL is already correct, so a normal command pays one cheap
 * `icacls` read instead of a rewrite.
 */
export function directoryAclIsRestricted(path) {
  if (!IS_WINDOWS) return true;
  const listing = runIcacls([path]);
  if (!listing.ok) return false;
  // icacls accepts SIDs as input but always prints *resolved* principal names,
  // and those are localized. So the check cannot look for SIDs or for names.
  //
  // Two signals in the output are locale-independent:
  //   - each ACE is "<principal>:(flags)(perm)", so ":(" counts the ACEs;
  //   - an inherited ACE carries the literal "(I)" flag.
  // The hardened state is exactly "two explicit ACEs, nothing inherited".
  // Any other shape (an extra principal, inheritance restored) reads as
  // unrestricted, which errs toward re-applying rather than assuming safety.
  const aceCount = (listing.output.match(/:\(/g) || []).length;
  const hasInherited = /\(I\)/.test(listing.output);
  return aceCount === 2 && !hasInherited;
}

/**
 * Restrict `path` to the current user plus SYSTEM, breaking inheritance.
 *
 * Returns a result object rather than throwing: a state directory that cannot
 * be hardened must still be usable (a network home directory may refuse ACL
 * edits outright), so callers warn and continue. Never widens an ACL.
 */
export function restrictDirectoryToCurrentUser(path) {
  if (!IS_WINDOWS) return { ok: true, changed: false, reason: "not_windows" };
  const sid = currentUserSid();
  if (!sid) return { ok: false, changed: false, reason: "sid_unavailable" };
  if (directoryAclIsRestricted(path)) {
    return { ok: true, changed: false, reason: "already_restricted", sid };
  }
  // /inheritance:r drops inherited entries; /grant:r replaces rather than
  // adds. (OI)(CI) makes the grant apply to files and subdirectories created
  // later, which is what gives new secrets the restriction for free.
  const result = runIcacls([
    path,
    "/inheritance:r",
    `/grant:r`, `*${sid}:(OI)(CI)F`,
    `/grant:r`, `*${LOCAL_SYSTEM_SID}:(OI)(CI)F`,
    "/Q",
  ]);
  if (!result.ok) {
    return { ok: false, changed: false, reason: "icacls_failed", status: result.status, sid };
  }
  return { ok: true, changed: true, reason: "restricted", sid };
}
