import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";
import { AgyNativeQueueStore } from "../src/adapters/agy/nativeQueue.js";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgyNativeLaunch, classifyAgyNativeInvocation } from "../src/runtime/agyNativeSession.js";
import { agyLaunchSelection } from "../src/adapters/agy/nativeCatalog.js";

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

test('--new-project preserves native command routing and the requested session model and effort', () => {
  for (const args of [
    ['--new-project', '--model', 'account-model', '--effort', 'high'],
    ['--new-project', '--effort=high', '--model=account-model'],
    ['--model=account-model', '--new-project', '--effort', 'high'],
    ['--model', 'account-model', '--effort', 'high', '--new-project'],
    ['--new-project=false', '--model', 'account-model', '--effort', 'high'],
  ]) {
    const invocation = classifyAgyNativeInvocation(args);
    assert.equal(invocation.mode, 'session', args.join(' '));
    assert.deepEqual(invocation.nativeArgs, args);
    assert.deepEqual(agyLaunchSelection(args), { model: 'account-model', effort: 'high' });
  }
  for (const args of [['--new-project', '--help'], ['--new-project', 'models']]) {
    assert.equal(classifyAgyNativeInvocation(args).mode, 'native-command', args.join(' '));
  }
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
      assert.deepEqual(result.args.slice(0, 2), ['--conversation=test', '--add-dir']);
      assert.ok(result.args[2].startsWith(join(environment.ORIGINROUTER_HOME, 'agy-attachments')));
      assert.equal(result.http, "http://127.0.0.1:7890");
      assert.equal(result.https, result.http);
      assert.equal(result.upper, result.https);
      assert.ok(result.no.includes("localhost"));
      assert.equal(result.gateway, undefined);
    }
    assert.equal(environment.http_proxy, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native resume shorthand stays inside the registered wrapper', () => {
  for (const args of [['-r', 'native'], ['-r=native'], ['--resume=native'], ['-c']]) {
    assert.equal(classifyAgyNativeInvocation(args).mode, 'session');
  }
});

test('in-terminal resume replaces a managed run even when the target has no transcript', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'originrouter-agy-handover-'));
  const from = '00000000-0000-0000-0000-000000000001';
  const to = '00000000-0000-0000-0000-000000000002';
  const invocations = join(root, 'launches');
  try {
    const fake = join(root, 'agy');
    writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.5.16'); process.exit(0); }
if (args.includes('models')) process.exit(0);
fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify(args) + '\\n');
const id = args[args.indexOf('--conversation') + 1];
if (id === ${JSON.stringify(to)}) setTimeout(() => process.exit(0), 300);
else {
  const log = args[args.indexOf('--log-file') + 1];
  const line = 'I1124 09:50:33.678623     921 ';
  fs.writeFileSync(log, line + 'server.go:2723] Starting language server process with pid ' + process.pid + '\\n'
    + line + 'common.go:496] Resuming conversation ' + id + '\\n'
    + line + 'conversation_manager.go:1082] Streaming conversation ${to}\\n');
  setTimeout(() => process.exit(9), 10000);
}
`, { mode: 0o755 });
    const bin = fileURLToPath(new URL('../bin/originrouter.js', import.meta.url));
    const stateDir = join(root, 'state');
    execFileSync(process.execPath, [bin, 'agy', '-r', from, '--originrouter-session', 'first-run',
      '--originrouter-conversation', 'first-label', '--originrouter-run', 'original-run',
      '--prompt-interactive', 'first message'], {
      env: { HOME: root, PATH: root + ':/usr/bin:/bin', ORIGINROUTER_HOME: stateDir,
        ORIGINROUTER_DISABLE_UPDATE_CHECK: '1', ORIGINROUTER_MANAGED_AGENT: '1' },
      cwd: root, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const args = readFileSync(invocations, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(args.length, 2);
    assert.ok(args[0].includes(from));
    assert.ok(args[1].includes(to));
    const runs = readFileSync(join(stateDir, 'sessions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(runs.some(run => run.sessionId === 'first-run'));
    assert.ok(runs.some(run => run.sessionId !== 'first-run' && run.args.includes(to)));
    const db = new Database(join(stateDir, 'agent-catalog.sqlite3'), { readonly: true });
    try {
      const rows = db.prepare('SELECT r.status, c.native_session_id FROM agent_runs r JOIN agent_conversations c USING (conversation_id) ORDER BY r.started_at').all();
      assert.deepEqual(rows, [
        { status: 'stopped', native_session_id: from },
        { status: 'completed', native_session_id: to },
      ]);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('terminal resume restores the canonical pending queue and legacy permissions while models is stalled', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-resume-queue-'));
  const stateDir = join(root, 'state'), native = '11111111-1111-1111-1111-111111110001';
  const bin = fileURLToPath(new URL('../bin/originrouter.js', import.meta.url));
  let catalog;
  try {
    mkdirSync(stateDir);
    catalog = new AgentCatalog({ stateDir });
    catalog.upsertSession({ sessionId: 'first', conversationId: 'canonical', agent: 'agy',
      status: 'completed', nativeSessionId: native, permissionProfile: 'unrestricted' });
    catalog.close(); catalog = null;
    new AgyNativeQueueStore(stateDir, 'canonical').write([{ id: 'pending', text: 'restore this draft' }]);
    writeFileSync(join(root, 'agy'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('models')) { setTimeout(() => process.exit(1), 60000); }
else if (process.argv.includes('--version')) { console.log('1.5.16'); }
else {
  process.stdin.setRawMode(true);
  let input = '';
  process.stdin.on('data', data => {
    input += data;
    if (input.includes('restore this draft') && input.includes('\\r')) {
      fs.writeFileSync('delivered', input);
      setTimeout(() => process.exit(0), 100);
    }
  });
  process.stdout.write('>\\r\\n────────────────────\\r\\n? for shortcuts   plan · Gemini · high');
  setTimeout(() => process.exit(7), 7000);
}
`, { mode: 0o755 });
    execFileSync(process.execPath, [bin, 'agy', '-r', native, '--originrouter-session', 'new-run'], {
      cwd: root, timeout: 16000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: root, PATH: root + ':/usr/bin:/bin', ORIGINROUTER_HOME: stateDir, ORIGINROUTER_DISABLE_UPDATE_CHECK: '1' },
    });
    assert.equal(readFileSync(join(root, 'delivered'), 'utf8').split('restore this draft').length, 2);
    catalog = new AgentCatalog({ stateDir });
    const conversation = catalog.getConversation('canonical');
    assert.equal(conversation.permission_state.profile, 'unrestricted');
    assert.equal(conversation.runs.find(r => r.originrouter_session_id === 'new-run').status, 'completed');
  } finally { catalog?.close(); rmSync(root, { recursive: true, force: true }); }
});
