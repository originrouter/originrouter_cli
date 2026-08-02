import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const home = mkdtempSync(join(tmpdir(), "originrouter-gateway-process-"));
const fakeLiteLlm = join(home, "fake-litellm.mjs");
const configPath = join(home, "config.yaml");
const routeMapPath = join(home, "route-map.json");
writeFileSync(configPath, "model_list: []\n");
writeFileSync(routeMapPath, JSON.stringify({
  schema: "originrouter-compatibility-route-map-v1",
  aliases: {
    "provider/claude": {
      provider: "provider",
      provider_family: "anthropic",
      litellm_provider: "anthropic",
      upstream_model: "claude",
      runtime: "codex",
    },
  },
}));
writeFileSync(fakeLiteLlm, `#!/usr/bin/env node
import http from "node:http";
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
const host = argv[argv.indexOf("--host") + 1];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/health/liveliness" ? "{\\"ok\\":true}" : (body.length ? body : "{}"));
  });
});
server.listen(port, host);
const close = () => server.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
`);
chmodSync(fakeLiteLlm, 0o755);

const publicPort = await reservePort();
const gatewayProcess = fileURLToPath(new URL("../src/compatibility/gatewayProcess.js", import.meta.url));
const child = spawn(process.execPath, [
  gatewayProcess,
  "--litellm", fakeLiteLlm,
  "--config", configPath,
  "--route-map", routeMapPath,
  "--state-dir", home,
  "--port", String(publicPort),
  "--host", "127.0.0.1",
], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

try {
  assert.equal(
    await waitFor(`http://127.0.0.1:${publicPort}/health/liveliness`),
    true,
    `gateway did not become healthy: ${stderr}`,
  );
  const response = await fetch(`http://127.0.0.1:${publicPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "provider/claude",
      tools: [{ type: "namespace", tools: [{ type: "function", name: "read" }] }],
      input: [],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-originrouter-compatibility-patches"), "1");
  const body = await response.json();
  assert.deepEqual(body.tools, [{ type: "function", name: "read" }]);
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  rmSync(home, { recursive: true, force: true });
}

console.log("compatibilityGatewayProcess tests passed");
