#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const helper = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "node-pty",
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper"
);

if (process.platform !== "win32" && fs.existsSync(helper)) {
  fs.chmodSync(helper, 0o755);
}
