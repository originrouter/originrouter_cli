import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgyNativeLaunch, classifyAgyNativeInvocation } from "../src/runtime/agyNativeSession.js";

test('native session classification does not depend on launcher metadata', () => {
  const normal = ['--model', 'account-model', '--prompt-interactive', 'read the project'];
  assert.equal(classifyAgyNativeInvocation(normal).mode, 'session');
  const managed = classifyAgyNativeInvocation(['--originrouter-session', 's1', '--originrouter-title', 'App launch', ...normal]);
  assert.equal(managed.mode, 'session');
  assert.deepEqual(managed.nativeArgs, normal);
  assert.equal(classifyAgyNativeInvocation(['--print', 'one shot']).mode, 'native-command');
  assert.equal(classifyAgyNativeInvocation(['--prompt=one shot']).mode, 'native-command');
  assert.equal(classifyAgyNativeInvocation(['--originrouter-session', 's1', 'models']).mode, 'native-command');
  assert.equal(classifyAgyNativeInvocation(['--prompt-interactive', '--help']).mode, 'session');
});

test("agy launches its native configuration and preserves native flags", () => {
  const env = { http_proxy: "http://manual:7890", MARKER: "preserved" };
  const launch = buildAgyNativeLaunch(["--native-config", "--model", "account-model", "--conversation=test"], { env, cwd: "/workspace" });
  assert.equal(launch.command, "agy");
  assert.equal(launch.cwd, "/workspace");
  assert.equal(launch.stdio, "inherit");
  assert.deepEqual(launch.args, ["--model", "account-model", "--conversation=test"]);
  assert.equal(launch.env.http_proxy, env.http_proxy);
  assert.equal(launch.env.MARKER, "preserved");
  assert.equal(launch.env.OPENAI_BASE_URL, undefined);
  assert.equal(launch.env.ANTHROPIC_BASE_URL, undefined);
  assert.deepEqual(env, { http_proxy: "http://manual:7890", MARKER: "preserved" });
});

test("agy never selects an OriginRouter model provider", () => {
  for (const args of [["--provider", "cloud"], ["--provider=cloud"]]) {
    assert.throws(() => buildAgyNativeLaunch(args), /native configuration/);
  }
});

test("clean CLI entry propagates OS proxy to the actual agy child", { skip: !["darwin", "linux"].includes(process.platform) }, () => {
  const root = mkdtempSync(join(tmpdir(), "originrouter-agy-native-"));
  const project = dirname(dirname(fileURLToPath(import.meta.url)));
  const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  try {
    const home = join(root, "home");
    mkdirSync(home);
    const settings = process.platform === "darwin"
      ? "HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890"
      : "org.gnome.system.proxy mode 'manual'\norg.gnome.system.proxy.http host '127.0.0.1'\norg.gnome.system.proxy.http port 7890\norg.gnome.system.proxy.https host '127.0.0.1'\norg.gnome.system.proxy.https port 7890";
    const utility = join(root, process.platform === "darwin" ? "scutil" : "gsettings");
    writeFileSync(utility, `#!/bin/sh\nprintf '%s\\n' ${quote(settings)}\n`);
    chmodSync(utility, 0o755);
    const agy = join(root, "agy");
    writeFileSync(agy, `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),http:process.env.http_proxy,https:process.env.https_proxy,upper:process.env.HTTPS_PROXY,no:process.env.NO_PROXY,gateway:process.env.OPENAI_BASE_URL}));process.exit(7);\n`);
    chmodSync(agy, 0o755);
    const environment = { HOME: home, PATH: `${root}:/usr/bin:/bin`, ORIGINROUTER_HOME: join(root, "state"), ORIGINROUTER_DISABLE_UPDATE_CHECK: "1" };
    // No proxy variables, shell profiles, user credentials or model config.
    try {
      execFileSync(process.execPath, [join(project, "bin/originrouter.js"), "agy", "--native-config", "--conversation=test"], { env: environment, encoding: "utf8", timeout: 15000 });
      assert.fail("the native child's exit code should propagate");
    } catch (error) {
      assert.equal(error.status, 7);
      const result = JSON.parse(error.stdout.trim());
      assert.deepEqual(result.args, ["--conversation=test"]);
      assert.equal(result.http, "http://127.0.0.1:7890");
      assert.equal(result.https, result.http);
      assert.equal(result.upper, result.https);
      assert.ok(result.no.includes("localhost"));
      assert.equal(result.gateway, undefined);
    }
    assert.equal(environment.http_proxy, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
