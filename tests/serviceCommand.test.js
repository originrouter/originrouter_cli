import assert from "node:assert/strict";

import {
  buildLaunchdPlist,
  buildSystemdUnit,
  buildWindowsTaskXml,
} from "../src/commands/service.js";

const common = {
  nodePath: "/usr/local/bin/node",
  cliPath: "/opt/originrouter/bin/originrouter.js",
  stdoutPath: "/tmp/originrouter.out.log",
  stderrPath: "/tmp/originrouter.err.log",
};

{
  const plist = buildLaunchdPlist(common);
  assert.match(plist, /<string>com\.originrouter\.daemon<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, /<string>daemon<\/string>/);
}

{
  const unit = buildSystemdUnit(common);
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/node" "\/opt\/originrouter\/bin\/originrouter\.js" daemon/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartSec=5/);
  assert.match(unit, /WantedBy=default\.target/);
}

{
  const task = buildWindowsTaskXml({
    ...common,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\originrouter-cli\\bin\\originrouter.js",
  });
  assert.match(task, /<LogonTrigger>/);
  assert.match(task, /<RestartOnFailure>/);
  assert.match(task, /<Count>3<\/Count>/);
  assert.match(task, /-EncodedCommand /);
}

console.log("service command tests ok");
