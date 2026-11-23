import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { WebSocketServer, WebSocket } from "ws";
import { runCapture } from "../../utils/detect.js";
import { spawnCommand } from "../../utils/spawn.js";
import { codexApprovalExpiresAt } from "../../runtime/codexAppServerPrimitives.js";
import { codexInteraction } from "../../runtime/codexInteraction.js";

const tokenEnv = "ORIGINROUTER_CODEX_TUI_TOKEN";
const localCommands = new Set(("agents exec e review login logout mcp plugin app-server remote-control app completion update doctor " +
  "sandbox debug apply a queue archive delete migrate-rollouts migrate-nfs-db unarchive cloud exec-server features help").split(" "));

// Forward server-owned configuration at server startup. Preserve CLI invocations
// that require a local-only feature or a different transport on their native path.
export function codexBridgeArgs(args, cwd) {
  const config = [], tui = [];
  let serverCwd = cwd;
  let hasCwd = false, positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { tui.push(...args.slice(i)); break; }
    const [key] = arg.split("=");
    if (["--help", "-h", "-V", "--version", "--remote", "--remote-auth-token-env", "--no-daemon",
      "--add-dir", "--worktree", "--oss", "--local-provider", "-p", "--profile"].includes(key)) return null;
    if (["-c", "--config", "--enable", "--disable"].includes(key)) {
      const value = arg.includes("=") && key !== arg ? arg.slice(key.length + 1) : args[++i];
      if (!value || /^\s*sandbox_workspace_write(?:\.writable_roots)?\s*=/.test(value)) return null;
      config.push(key, value);
      tui.push(key, value);
      continue;
    }
    if (key === "--strict-config" || key === "--search") {
      if (key === "--strict-config") config.push(key);
      else config.push("-c", 'web_search="live"');
      tui.push(arg);
      continue;
    }
    if (["-m", "--model", "-C", "--cd", "-a", "--ask-for-approval", "-s", "--sandbox", "-i", "--image"].includes(key)) {
      const value = arg.includes("=") ? arg.slice(key.length + 1) : args[++i];
      if (!value) return null;
      if (["-C", "--cd"].includes(key)) {
        hasCwd = true;
        serverCwd = resolve(cwd, value);
        tui.push(key, serverCwd);
        continue;
      }
      if (["-s", "--sandbox", "-a", "--ask-for-approval"].includes(key)) {
        const setting = ["-s", "--sandbox"].includes(key) ? "sandbox_mode" : "approval_policy";
        config.push("-c", `${setting}=${JSON.stringify(value)}`);
      }
      if (arg.includes("=")) tui.push(arg);
      else tui.push(key, value);
      continue;
    }
    // Unknown or compact flag forms belong to the installed CLI. Guessing their
    // arity could send a prompt or a client-only option to the wrong process.
    if (arg.startsWith("-") && !["--no-alt-screen", "--last", "--all"].includes(arg)) return null;
    if (!positional && !arg.startsWith("-")) {
      if (localCommands.has(arg)) return null;
      positional = true;
    }
    tui.push(arg);
  }
  return { config, serverCwd, tui: [...(hasCwd ? [] : ["-C", cwd]), ...tui] };
}

export async function startCodexNativeBridge({ launch, cwd, env, sessionId, interactions, onThread }) {
  const args = codexBridgeArgs(launch.args, cwd);
  if (!args) return null;
  const help = await runCapture("codex", ["--help"]);
  if (!help.ok || !help.output.includes("--remote-auth-token-env")) return null;

  // The socket belongs exclusively to this TUI. The bearer is passed only in
  // its environment, never in argv, App metadata or the tool-running server.
  const token = randomBytes(32).toString("hex");
  let attached = false;
  const endpoint = new WebSocketServer({
    host: "127.0.0.1", port: 0,
    verifyClient: ({ req }) => !attached && req.headers.authorization === `Bearer ${token}`,
  });
  try {
    await once(endpoint, "listening");
  } catch (error) {
    process.stderr.write(`[originrouter] Codex mobile approvals unavailable (${error.code || "listen failed"}); using native terminal.\n`);
    return null;
  }
  const bridgeId = randomUUID();
  const pending = new Map();
  const fileChanges = new Map();
  const threadRequests = new Set();
  let server, terminal;
  let closed = false, registered = false;

  function finish(id, reason) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (!entry.published || entry.withdrawn) return;
    const applied = entry.winner === "app" && reason === "server_resolved";
    void interactions.markResult(entry.card.request.interactionId, applied ? "applied" : "canceled", {
      reason: entry.winner === "terminal" ? "answered_on_terminal" : reason,
    });
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const id of pending.keys()) finish(id, "codex_disconnected");
    terminal?.terminate();
    endpoint.close();
    server?.stdin.end();
    server?.kill();
  }
  function send(frame) {
    if (!server.stdin.write(JSON.stringify(frame) + "\n") && terminal && !terminal.isPaused) {
      terminal.pause();
      server.stdin.once("drain", () => terminal?.resume());
    }
  }
  function observe(frame) {
    if (!frame.method) {
      if (threadRequests.delete(frame.id) && frame.result?.thread) onThread(frame.result.thread);
      return;
    }
    const { item, threadId, itemId } = frame.params || {};
    if (item?.type === "fileChange" && item.id) {
      const key = JSON.stringify([threadId, item.id]);
      if (frame.method === "item/started") fileChanges.set(key, item.changes);
      if (frame.method === "item/completed") fileChanges.delete(key);
    }
    if (frame.method === "serverRequest/resolved") {
      finish(frame.params.requestId, "server_resolved");
      return;
    }
    if (frame.id == null || pending.has(frame.id)) return;
    let params = frame.params || {};
    if (frame.method === "item/fileChange/requestApproval" && !params.fileChanges) {
      params = { ...params, fileChanges: fileChanges.get(JSON.stringify([threadId, itemId])) };
    }
    const card = codexInteraction(frame.method, params, {
      sessionId, runtime: "codex-pty", interactionId: `codex:${bridgeId}:${frame.id}`,
      expiresAt: codexApprovalExpiresAt(),
    });
    if (!card) return;
    const entry = { card, winner: null };
    pending.set(frame.id, entry);
    if (registered) publish(frame.id, entry);
  }
  function publish(id, entry) {
    entry.published = true;
    void interactions.request(entry.card.request).then(resolved => {
      if (pending.get(id) !== entry || entry.winner || closed) return;
      const result = entry.card.reply(resolved);
      entry.winner = "app";
      send({ id, result });
    }).catch(() => {
      entry.withdrawn = true;
      // Expiry or session shutdown withdraws the mobile card. A still-open
      // terminal request is owned by Codex until it reports resolution.
    });
  }
  endpoint.on("error", close);
  endpoint.on("connection", socket => {
    attached = true;
    terminal = socket;
    server = spawnCommand("codex", ["app-server", ...args.config], {
      env: { ...env, ...launch.env }, cwd: args.serverCwd, stdio: ["pipe", "pipe", "inherit"],
    });
    server.on("error", close);
    server.on("exit", close);
    server.stdin.on("error", close);
    socket.on("error", close);
    socket.on("close", close);
    const lines = createInterface({ input: server.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      socket.send(line);
      observe(frame);
    });
    socket.on("message", bytes => {
      if (closed) return;
      let frame;
      try { frame = JSON.parse(bytes); } catch { close(); return; }
      if (!frame.params?.ephemeral && ["thread/start", "thread/resume", "thread/fork"].includes(frame.method)) threadRequests.add(frame.id);
      if (!frame.method && frame.id != null) {
        const entry = pending.get(frame.id);
        if (entry?.winner) return;
        if (entry) entry.winner = "terminal";
      }
      send(frame);
    });
  });
  return {
    close,
    hasPendingInput: () => pending.size > 0,
    resolvePermission(payload) {
      const interactionId = payload.interactionId || payload.callId;
      const entry = [...pending.values()].find(item => item.card.request.interactionId === interactionId);
      if (!entry?.published || entry.winner || entry.card.request.kind !== "permission") return false;
      const action = { approved: "allow", approved_for_session: "allow", denied: "deny", abort: "cancel" }[payload.decision];
      if (!action) return false;
      return interactions.resolve({ ...payload, interactionId, action,
        response: { remember_for_session: payload.decision === "approved_for_session" },
      }).accepted;
    },
    onRegistered() {
      registered = true;
      for (const [id, entry] of pending) {
        if (!entry.winner && !entry.published) publish(id, entry);
      }
    },
    launch: { ...launch, args: ["--remote", `ws://127.0.0.1:${endpoint.address().port}`,
      "--remote-auth-token-env", tokenEnv, ...args.tui], env: { ...launch.env, [tokenEnv]: token } },
  };
}
