import assert from "node:assert/strict";

import {
  buildLaunchdPlist,
  buildServiceEnvironmentPath,
  buildSystemdUnit,
  buildWindowsTaskXml,
  waitForLocalApiReady,
  waitForLaunchdUnloaded,
} from "../src/commands/service.js";

const common = {
  nodePath: "/usr/local/bin/node",
  cliPath: "/opt/originrouter/bin/originrouter.js",
  stdoutPath: "/tmp/originrouter.out.log",
  stderrPath: "/tmp/originrouter.err.log",
  environmentPath: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
};

{
  const value = buildServiceEnvironmentPath({
    nodePath: "/opt/custom-node/bin/node",
    cliPath: "/opt/originrouter/bin/originrouter.js",
    inheritedPath: "/custom/bin:/usr/bin:/custom/bin",
    currentPlatform: "darwin",
  });
  const entries = value.split(":");
  assert.equal(entries[0], "/opt/custom-node/bin");
  assert.equal(entries[1], "/opt/originrouter/bin");
  assert.equal(entries.filter((item) => item === "/custom/bin").length, 1);
  assert.ok(entries.includes("/usr/local/bin"));
  assert.ok(entries.includes("/opt/homebrew/bin"));
}

{
  const plist = buildLaunchdPlist(common);
  assert.match(plist, /<string>com\.originrouter\.daemon<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, /<string>daemon<\/string>/);
}

{
  const unit = buildSystemdUnit(common);
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/node" "\/opt\/originrouter\/bin\/originrouter\.js" daemon/);
  assert.match(unit, /Environment="PATH=\/usr\/local\/bin:/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartSec=5/);
  assert.match(unit, /WantedBy=default\.target/);
}

{
  const task = buildWindowsTaskXml({
    ...common,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\originrouter-cli\\bin\\originrouter.js",
    environmentPath: "C:\\Program Files\\nodejs;C:\\Users\\me\\AppData\\Roaming\\npm",
  });
  assert.match(task, /<LogonTrigger>/);
  assert.match(task, /<RestartOnFailure>/);
  assert.match(task, /<Count>3<\/Count>/);
  assert.match(task, /-EncodedCommand /);
  const encoded = task.match(/-EncodedCommand ([^<]+)<\/Arguments>/)?.[1];
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(decoded, /\$env:PATH =/);
  assert.match(decoded, /Program Files\\\\nodejs/);
}

{
  const requests = [];
  let tokenReads = 0;
  const url = await waitForLocalApiReady({
    timeoutMs: 1_000,
    readState: () => ({
      localApiPort: 7437,
      localApiBindAddress: "127.0.0.1",
    }),
    readToken: () => {
      tokenReads += 1;
      return tokenReads === 1 ? null : "test-token";
    },
    fetchFn: async (requestUrl, options) => {
      requests.push({ requestUrl, options });
      return { ok: requests.length === 2 };
    },
    sleep: async () => {},
  });

  assert.equal(url, "http://127.0.0.1:7437");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].options.headers, {});
  assert.deepEqual(requests[1].options.headers, {
    Authorization: "Bearer test-token",
  });
}

{
  let checks = 0;
  let sleeps = 0;
  await waitForLaunchdUnloaded({
    timeoutMs: 1_000,
    isLoaded: () => {
      checks += 1;
      return checks < 3;
    },
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(checks, 3);
  assert.equal(sleeps, 2);
}

console.log("service command tests ok");
