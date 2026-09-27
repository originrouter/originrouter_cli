import { execFileSync } from "node:child_process";
import { platform } from "node:os";

// pip, uv, and other download tools ignore the Windows system proxy and only
// honor proxy environment variables. Resolve the system proxy once and merge
// it into the child environment when the caller has not set one explicitly.
// ORIGINROUTER_PROXY overrides; existing HTTPS_PROXY wins; setting
// ORIGINROUTER_NO_PROXY=1 disables detection.

const WINDOWS_INTERNET_SETTINGS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function readRegistryValue(name) {
  const output = execFileSync("reg.exe", ["query", WINDOWS_INTERNET_SETTINGS_KEY, "/v", name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3_000,
    windowsHide: true,
  });
  const match = output.match(new RegExp(`${name}\\s+REG_SZ\\s+(\\S+)`));
  return match?.[1] || null;
}

export function systemProxyUrl({
  env = process.env,
  currentPlatform = platform(),
} = {}) {
  if (currentPlatform !== "win32") return null;
  if (String(env.ORIGINROUTER_NO_PROXY || "") === "1") return null;
  if (env.ORIGINROUTER_PROXY) return env.ORIGINROUTER_PROXY;
  if (env.HTTPS_PROXY || env.https_proxy) return null; // already set explicitly
  try {
    if (readRegistryValue("ProxyEnable") !== "0x1") return null;
    const server = readRegistryValue("ProxyServer");
    if (!server) return null;
    // ProxyServer is "host:port" or a semicolon-separated per-scheme list.
    if (!server.includes("=")) return `http://${server}`;
    for (const part of server.split(";")) {
      const schemeMatch = part.match(/^https?=(.+)$/);
      if (schemeMatch) return `http://${schemeMatch[1]}`;
    }
  } catch {
    // Registry may be unreadable in restricted environments; treat as absent.
  }
  return null;
}

// Returns a child-process environment with HTTP(S)_PROXY filled in from the
// Windows system proxy when the base environment has none.
export function inheritSystemProxyEnv(baseEnv = process.env, currentPlatform = platform()) {
  const env = { ...baseEnv };
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
    return env;
  }
  // systemProxyUrl also honors ORIGINROUTER_PROXY, normalizing it into the
  // standard lowercase/uppercase variable pair download tools expect.
  const url = systemProxyUrl({ env: baseEnv, currentPlatform });
  if (url) {
    env.HTTP_PROXY = url;
    env.HTTPS_PROXY = url;
    env.http_proxy = url;
    env.https_proxy = url;
  }
  return env;
}
