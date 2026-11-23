// Real official Codex TUI + daemon. Only model output is scripted locally.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import xterm from "@xterm/headless";
import { CODEX_MAIN_ALIAS, getAllRoutes, hashRoutes } from "../src/config/routes.js";
import { PtyExecutor } from "../src/executors/ptyExecutor.js";

const bin = fileURLToPath(new URL("../bin/originrouter.js", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "or-codex-live-")));
const state = path.join(root, "state"), home = path.join(root, "codex"), cwd = path.join(root, "project");
for (const dir of [state, home, cwd]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(state, "local-api.json"), JSON.stringify({ relayMode: "off" }));
let phase = "allow", sequence = 0, questionAnswered = false;
const model = http.createServer(async (req, res) => {
  if (!req.url.endsWith("/responses")) { res.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const hasTools = request.tools?.length > 0;
  if (hasTools) assert.equal(request.model, nativeConfig ? "gpt-5.4" : CODEX_MAIN_ALIAS);
  for (const item of request.input || []) {
    if (item.type !== "function_call_output" || typeof item.output !== "string") continue;
    try {
      if (JSON.parse(item.output)?.answers?.scope?.answers?.includes("Unit")) questionAnswered = true;
    } catch { /* Other tools can return plain text. */ }
  }
  const id = String(++sequence);
  if (hasTools && phase === "wait") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); return; }
  let item;
  if (hasTools && phase === "permissions") {
    item = { type: "function_call", name: "request_permissions", call_id: id,
      arguments: JSON.stringify({ reason: "Read the test directory", permissions: { file_system: { write: [root] } } }) };
    phase = "answer";
  } else if (hasTools && phase === "file") {
    item = { type: "function_call", name: "exec_command", call_id: id,
      arguments: JSON.stringify({ cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: reviewed.txt\n+reviewed\n*** End Patch\nPATCH" }) };
    phase = "answer";
  } else if (hasTools && phase === "question") {
    item = { type: "function_call", name: "request_user_input", call_id: id, arguments: JSON.stringify({ questions: [{
      id: "scope", header: "Scope", question: "Which test suite?", options: [
        { label: "Unit", description: "Unit tests" }, { label: "All", description: "All tests" },
      ],
    }] }) };
    phase = "answer";
  } else if (hasTools && ["allow", "deny"].includes(phase)) {
    item = { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({
      cmd: "printf x >> marker", sandbox_permissions: "require_escalated", justification: "Run the marker check?",
    }) };
    phase = "answer";
  } else {
    item = { type: "message", id: "msg" + id, role: "assistant", content: [{ type: "output_text", text: "Fixture finished " + id }] };
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id } }, { type: "response.output_item.done", item },
    { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) res.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
  res.end();
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
fs.writeFileSync(path.join(home, "config.toml"), `model="gpt-5.4"
model_provider="fixture"
approval_policy="on-request"
sandbox_mode="read-only"
[features]
request_permissions_tool=true
[model_providers.fixture]
name="Fixture"
base_url="http://127.0.0.1:${model.address().port}/v1"
wire_api="responses"
[projects.${JSON.stringify(cwd)}]
trust_level="trusted"
[tui]
show_tooltips=false
`);
const env = { ...process.env, CODEX_HOME: home, ORIGINROUTER_HOME: state, ORIGINROUTER_DISABLE_UPDATE_CHECK: "1", TERM: "xterm-256color" };
const nativeConfig = process.argv.includes("--native-config");
if (!nativeConfig) {
  const cli = (...args) => execFileSync(process.execPath, [bin, ...args], { cwd, env, stdio: "pipe" });
  cli("provider", "add", "fixture", "--type", "litellm", "--litellm-provider", "openai", "--api-key", "fixture", "--model", "gpt-5.4");
  cli("route", "set", "codex.main", "--provider", "fixture", "--model", "gpt-5.4");
  const config = JSON.parse(fs.readFileSync(path.join(state, "config.json")));
  fs.writeFileSync(path.join(state, "proxy.state.json"), JSON.stringify({
    state: "running", pid: process.pid, host: "127.0.0.1", port: model.address().port,
    mode: "route", routesHash: hashRoutes(getAllRoutes(config)), aliases: [CODEX_MAIN_ALIAS],
  }));
}
const daemon = spawn(process.execPath, [bin, "daemon", "--local-port", "0"], { cwd, env, stdio: "ignore" });
const terminal = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true });
const outer = new PtyExecutor();
terminal.onData(data => outer.write(data));
const screen = () => {
  const b = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true)).join("\n");
};
let exited, base, token;
async function wait(label, fn, ms = 18000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    if (exited) break;
    await delay(80);
  }
  throw new Error(label + " timed out (model calls " + sequence + ")\n" + screen().trim());
}
let session = "codex-native-live";
async function api(action, body) {
  const res = await fetch(base + "/agent/local/sessions/" + session + "/" + action, {
    method: body ? "POST" : "GET", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(4000),
  });
  if (res.status === 404 && !body) return {};
  assert.ok(res.ok, action + ": " + res.status);
  const json = await res.json(); return json.data || json;
}
const seen = new Set();
const nextCard = () => wait("App pending card", async () => {
  const card = (await api("snapshot")).interactions?.find(e => !seen.has(e.interactionId));
  if (card) seen.add(card.interactionId);
  return card;
});
const answer = (card, action, response = {}) => api("interaction", { interactionId: card.interactionId, responseId: crypto.randomUUID(), action, response });
const result = (card, status) => wait("App result " + status, async () =>
  (await api("snapshot")).events?.find(e => e.type === "agent.interaction.result" && e.interactionId === card.interactionId && e.status === status));
const message = message => api("message", { message, messageId: crypto.randomUUID() });
const launch = args => outer.start({ command: process.execPath, args: [bin, "codex", ...(nativeConfig ? ["--native-config"] : []), "--originrouter-session", session, ...args],
    cwd, env, cols: 120, rows: 40, onOutput: data => terminal.write(data), onExit: status => { exited = status; } });
try {
  await wait("daemon startup", () => {
    const file = path.join(state, "daemon.state.json");
    if (!fs.existsSync(file)) return false;
    base = JSON.parse(fs.readFileSync(file)).localApiBaseUrl;
    return base;
  });
  token = fs.readFileSync(path.join(state, "local-api.token"), "utf8").trim();
  await launch(["Run the first check."]);
  await wait("official TUI approval", () => /Yes, proceed|press enter to confirm/i.test(screen()));
  const first = await nextCard();
  assert.match(first.payload.command, /printf x/);
  await message("Do not interpret this chat message as an approval");
  await wait("ordinary message refused while approval pending", async () =>
    (await api("snapshot")).events?.some(e => e.type === "agent.message.result" && e.accepted === false));
  assert.equal(fs.existsSync(path.join(cwd, "marker")), false);
  await answer(first, "allow");
  await result(first, "applied");
  await wait("TUI dismissed after mobile approval", () => screen().includes("Fixture finished") && !screen().includes("Yes, proceed"));
  const marker = path.join(cwd, "marker");
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  console.log("PASS mobile joined a waiting TUI, allowed once; terminal dismissed, one execution");
  phase = "deny"; await message("Run the second check.");
  const second = await nextCard();
  await wait("terminal deny menu", () => /No,|Esc to|esc to/i.test(screen()) && screen().includes("Yes, proceed"));
  outer.write("\x1b");
  await result(second, "canceled");
  await answer(second, "allow");
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  console.log("PASS App text input, terminal rejection, stale mobile decision");
  const history = await wait("conversation history", async () => {
    const h = await api("history"); return h.messages?.some(m => m.text?.includes("Fixture finished")) && h;
  });
  assert.ok(history.messages.some(m => m.event?.type === "agent.tool_call.start"));
  console.log("PASS conversation and tool history");
  await delay(400);
  phase = "file"; await message("Apply the patch.");
  const file = await nextCard();
  assert.equal(file.payload.tool, "file_change");
  assert.ok(file.payload.affectedFiles.some(f => f.endsWith("reviewed.txt")));
  await answer(file, "allow"); await result(file, "applied");
  await wait("file edited once", () => fs.existsSync(path.join(cwd, "reviewed.txt")));
  assert.equal(fs.readFileSync(path.join(cwd, "reviewed.txt"), "utf8"), "reviewed\n");
  await wait("file turn complete", () => screen().includes("Fixture finished " + sequence));
  console.log("PASS file approval includes affected path and applies reviewed patch");
  phase = "permissions"; await message("Request additional permissions.");
  const grant = await nextCard();
  assert.equal(grant.payload.tool, "permissions");
  assert.ok(JSON.stringify(grant.payload.requested).includes(root));
  await answer(grant, "deny"); await result(grant, "applied");
  await wait("permission turn complete", () => screen().includes("Fixture finished " + sequence));
  console.log("PASS additional permissions delivered and declined");
  await message("/plan");
  await wait("Plan mode", () => /Plan mode/i.test(screen()));
  phase = "question"; await message("Which suite should run?");
  const question = await nextCard(); assert.equal(question.kind, "questions");
  await answer(question, "submit", { answers: { scope: ["Unit"] } });
  await result(question, "applied");
  await wait("model received selected answer", () => questionAnswered);
  console.log("PASS blocking Plan question answered from App");
  await wait("TUI finished question", () => !screen().includes("Which test suite?") && screen().includes("Fixture finished"));
  const abortedBefore = (await api("history")).messages.filter(m => m.event?.type === "agent.task.aborted").length;
  const before = sequence;
  phase = "wait"; await message("Wait for an interrupt.");
  await wait("active stream", () => sequence > before);
  await api("interrupt", {});
  await wait("interrupt", async () => (await api("history")).messages?.filter(m => m.event?.type === "agent.task.aborted").length > abortedBefore);
  console.log("PASS App interrupt");
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  if (nativeConfig) {
    const nativeId = history.nativeSessionId;
    assert.ok(nativeId);
    outer.write("/quit"); await delay(80); outer.write("\r");
    await wait("original terminal exited", () => exited);
    exited = null;
    session = "codex-native-resumed";
    await launch(["resume", nativeId]);
    const resumed = await wait("same saved history after resume", async () => {
      const h = await api("history");
      return h.nativeSessionId === nativeId && h.messages?.some(m => m.text === "Run the first check.") && h;
    });
    assert.equal(resumed.messages.filter(m => m.text === "Run the first check.").length, 1);
    phase = "allow"; await message("Check the resumed session.");
    const resumedCard = await nextCard();
    await answer(resumedCard, "deny");
    await result(resumedCard, "applied");
    assert.equal(fs.readFileSync(marker, "utf8"), "x");
    console.log("PASS resumed the original native thread and answered a fresh approval");
  }
} finally {
  outer.stop();
  fs.rmSync(path.join(state, "proxy.state.json"), { force: true });
  daemon.kill();
  model.closeAllConnections(); model.close(); terminal.dispose();
  await delay(1000);
  fs.rmSync(root, { recursive: true, force: true });
}
