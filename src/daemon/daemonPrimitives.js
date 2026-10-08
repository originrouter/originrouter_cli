import { getAllRoutes } from "../config/routes.js";
import { normalizeProviderForRead } from "../config/providers.js";
import { buildAgentRelayPlan } from "../relay/agentRelayPolicy.js";

export function httpHost(address) {
  return String(address).includes(":") && !String(address).startsWith("[")
    ? `[${address}]`
    : address;
}

export function parsePort(value, label, { allowZero = true } = {}) {
  if (value == null || value === "") return undefined;
  const min = allowZero ? 0 : 1;
  // Strict decimal, not `Number.parseInt`. parseInt stops at the first
  // character it cannot use, so it reads "80abc" as 80, "80.5" as 80 and
  // "0x10" as 0 — a typo becomes a plausible wrong port rather than an error,
  // and the operator never learns the value was rejected. `Number()` alone is
  // not enough either: it accepts "0x10" (and "" as 0, handled above), so the
  // shape is checked on the string before it is converted.
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`${label} must be an integer in [${min}, 65535] (got '${value}')`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > 65535) {
    throw new Error(`${label} must be an integer in [${min}, 65535] (got '${value}')`);
  }
  return parsed;
}

/**
 * Which local API port the daemon should try, in the order it should try them.
 *
 * A port can arrive three ways, and they are not interchangeable:
 *
 *   1. `--local-port` / `ORIGINROUTER_LOCAL_PORT` — an instruction for this run,
 *      with one exception: `0` means "leave it to the kernel" and is normalized
 *      away rather than pinned (see the note on `parseExplicit` below).
 *   2. `local-api.json` with `portSource: "operator"`, written by
 *      `local api set-port` / `local config set --port` — an instruction meant to
 *      survive restarts. This matters because a launchd-managed daemon is
 *      started by the supervisor with no flags at all, so the file is the *only*
 *      way an operator can choose a port on a service install.
 *   3. `local-api.json` without that marker — merely where the daemon last
 *      bound, which is a fact about the past.
 *
 * The recorded port is tried first, ahead of the built-in default, so a host
 * where 7437 is taken — a second OriginRouter user on a shared Linux box, say —
 * stays on the port it settled on instead of bouncing between them on every
 * restart. Stability is the priority here: the App pairs against whatever port
 * daemon.state.json reports, and a port that moves underneath it breaks that
 * pairing.
 *
 * The trade-off is that a record written by mistake is no longer self-correcting
 * — the daemon keeps preferring it. That is why the caller announces a fallback
 * loudly and names the command to pin a port deliberately; a mistaken record is
 * then a visible, one-command fix rather than a silent drift.
 *
 * A port the operator set outranks even the default, and an explicit flag
 * outranks the file. Neither is ever silently substituted: they are tried first,
 * the daemon warns if it lands elsewhere, and the recorded port tracks the
 * result until it moves back.
 */
export function resolveLocalPortCandidates({
  cliPort,
  envPort,
  recordedPort,
  portIsOperatorSet = false,
  defaultPort,
}) {
  // The callers that still pass `configuredPort` predate the operator marker.
  if (recordedPort === undefined) recordedPort = arguments[0]?.configuredPort;
  // Resolve each source on its own line. `a ?? b != null ? … : …` parses as
  // `(a ?? (b != null)) ? … : …`, so a configured port silently counted as
  // explicitly requested — and explicit requests never fall back, which turned
  // a busy port into a hard startup failure.
  //
  // An explicit `0` is a variant of "nothing is pinned", not a port: since 0.4.9
  // `--local-port 0` has been the documented way to ask the kernel for a free
  // port on a throwaway home, and `acceptance.e2e.test.js` starts the daemon
  // that way. Reading it as an instruction would also invert its meaning —
  // explicit ports never fall back, so pinning it would turn the one request
  // that means "any free port" into a hard failure on the first busy candidate.
  // Dropping it lands on the same path as an unset port: recorded, then default,
  // then the kernel. Any other out-of-range value is still rejected loudly, so
  // the no-silent-substitution rule keeps its point.
  const parseExplicit = (value, label) => {
    const parsed = parsePort(value, label);
    if (parsed === undefined) return null;
    return parsed === 0 ? undefined : parsed;
  };
  const cli = cliPort != null ? parseExplicit(cliPort, "--local-port") : null;
  const env = envPort != null
    ? parseExplicit(envPort, "ORIGINROUTER_LOCAL_PORT")
    : null;
  const explicit = cli ?? env ?? null;

  // An explicit `0` asked for the kernel to choose, and that request outranks
  // everything below it. Clearing only `explicit` would let `local-api.json`
  // supply the port instead, which is the opposite of what was asked — and on a
  // machine whose real daemon already holds the recorded port, the throwaway
  // start would fail with EADDRINUSE instead of getting its own port.
  // Distinguish "asked for 0" from "was not asked" by checking the raw input.
  const kernelRequested =
    (cliPort != null && Number(cliPort) === 0) ||
    (envPort != null && Number(envPort) === 0);
  if (kernelRequested) {
    return { explicit: null, requested: null, candidates: [] };
  }
  // A 0 in the file is damage, not a request. The kernel only ever assigns a
  // real port, so nothing legitimate writes 0 here — and 0 is the one value
  // `parsePort` accepts (for the `?? 0` fallback) that is not a port. Left
  // alone it becomes the *lead* candidate, which is the worst place for it:
  // the daemon would hand 0 to the kernel while believing it had a pinned port,
  // and the port it landed on would be reported as a fallback from a port that
  // never existed.
  const recordedRaw = parsePort(recordedPort, "local-api.json port");
  const recorded = recordedRaw === 0 ? undefined : recordedRaw;

  // A port the operator chose is an instruction and takes the lead, ahead of the
  // default: someone who ran `local api set-port 8080` on a service install has
  // no other way to say so, and the port must not drift back to 7437 underneath
  // them. It sits behind an explicit flag only because the flag is this run's
  // word against the file's.
  const requested = explicit ?? (portIsOperatorSet ? recorded : null);
  // Where it last landed leads when nobody has asked for anything specific, so a
  // host that had to move stays put rather than re-deriving its port each start.
  const leading = requested ?? recorded ?? defaultPort;
  // An empty candidate list means nothing is pinned; the caller hands the choice
  // to the kernel for a first, unconfigured run.
  const candidates = [];
  for (const port of [leading, explicit, recorded, defaultPort]) {
    if (port != null && !candidates.includes(port)) candidates.push(port);
  }
  return { explicit, requested, candidates };
}

/**
 * Whether the recorded daemon is still alive.
 *
 * `signal 0` only tests for existence, so this never disturbs the process — the
 * running daemon belongs to the service manager, and a stray signal would stop
 * it. A recorded PID that fails the test is stale (the daemon was killed
 * uncleanly), which is exactly when a foreground start *is* the right answer.
 */
export function liveDaemonPid(state, kill = process.kill) {
  const pid = Number(state?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    kill(pid, 0);
    return pid;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; anything else
    // (ESRCH) means the PID is free.
    return error?.code === "EPERM" ? pid : null;
  }
}

export function buildProxyBaseUrl(status) {
  if (!status || status.state !== "running" || !status.port) return "";
  return `http://${httpHost(status.host || "127.0.0.1")}:${status.port}`;
}

export function localControlProviderSnapshot(config) {
  return Object.entries(config?.providers || {}).map(([key, provider]) => {
    const normalized = normalizeProviderForRead(provider, {
      legacyRemoteEnabled: (config.remoteShare?.providers || []).includes(key),
    }) || {};
    return {
      name: normalized.name || key,
      type: normalized.type || "proxy",
      litellmProvider: normalized.litellmProvider || "",
      model: normalized.type === "proxy" ? "" : (normalized.model || ""),
      models: normalized.models || [],
      target: normalized.target || "",
      deviceId: normalized.deviceId || "",
    };
  });
}

export function localControlRouteSnapshot(config) {
  const routes = getAllRoutes(config);
  const result = [];
  for (const [agent, slots] of Object.entries(routes)) {
    for (const [slot, route] of Object.entries(slots || {})) {
      if (!route?.provider) continue;
      result.push({ agent, slot, provider: route.provider, model: route.model || "" });
    }
  }
  return result;
}

export async function tryBuildRelayClientOptions({ stateDir, relayUrl, fallbackDeviceId, mode }) {
  try {
    const plan = await buildAgentRelayPlan({ stateDir, relayUrl, fallbackDeviceId, mode });
    if (!plan.enabled) return { ok: false, code: plan.reason, plan };
    return { ok: true, options: plan, plan };
  } catch (err) {
    return { ok: false, code: err?.code || "unknown" };
  }
}
