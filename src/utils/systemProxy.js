import { execFileSync } from "node:child_process";
import { platform } from "node:os";

// CLI proxy variables are the primary contract. Static OS settings are a
// fallback, resolved afresh for each launch without changing the caller.

const WINDOWS_INTERNET_SETTINGS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function run(exec, command, args) {
  return String(exec(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1500,
    windowsHide: true,
  })).trim();
}

function proxyAddress(address, scheme = "http") {
  const text = String(address || "").trim();
  if (!text || /[\s\x00-\x1f]/.test(text)) return null;
  try {
    const value = text.includes("://") ? text : `${scheme}://${text}`;
    const url = new URL(value);
    return ["http:", "https:", "socks:", "socks5:", "socks5h:"].includes(url.protocol) && url.hostname ? value : null;
  } catch { return null; }
}

function hostProxy(host, port, scheme = "http") {
  if (!host || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return null;
  return proxyAddress(`${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`, scheme);
}

function bypassEntries(value) {
  return String(value || "").split(/[;,\s]+/).filter((item) => item && item !== "<local>")
    .map((item) => item.startsWith("*.") ? item.slice(1) : item);
}

export function parseMacSystemProxy(output) {
  const field = (key) => String(output).match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, "m"))?.[1];
  const settings = {};
  for (const [prefix, protocol, scheme] of [["HTTP", "http", "http"], ["HTTPS", "https", "http"], ["SOCKS", "all", "socks5h"]]) {
    if (field(`${prefix}Enable`) !== "1") continue;
    const url = hostProxy(field(`${prefix}Proxy`), field(`${prefix}Port`), scheme);
    if (url) settings[protocol] = url;
  }
  const exceptions = String(output).match(/ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/)?.[1] || "";
  settings.bypass = exceptions.split("\n").flatMap((line) => bypassEntries(line.replace(/^\s*\d+\s*:\s*/, "")));
  // PAC is evaluated per destination; its URL is never a static proxy URL.
  return settings;
}

export function parseWindowsSystemProxy(server, overrides = "") {
  const settings = { bypass: bypassEntries(overrides) };
  if (!server.includes("=")) {
    const url = proxyAddress(server);
    if (url) settings.http = settings.https = url;
    return settings;
  }
  for (const entry of server.split(";")) {
    const match = entry.trim().match(/^(http|https|socks)=(.+)$/i);
    if (!match) continue;
    const protocol = match[1].toLowerCase();
    const url = proxyAddress(match[2], protocol === "socks" ? "socks5h" : "http");
    if (url) settings[protocol === "socks" ? "all" : protocol] = url;
  }
  return settings;
}

export function parseGnomeSystemProxy(output) {
  const values = new Map();
  for (const line of String(output).split("\n")) {
    const match = line.match(/^org\.gnome\.system\.proxy(?:\.(\w+))?\s+([\w-]+)\s+(.+)$/);
    if (match) values.set(`${match[1] || ""}.${match[2]}`, match[3].trim().replace(/^'(.*)'$/, "$1"));
  }
  if (values.get(".mode") !== "manual") return {};
  const settings = {};
  for (const protocol of ["http", "https", "socks"]) {
    const url = hostProxy(values.get(`${protocol}.host`), values.get(`${protocol}.port`), protocol === "socks" ? "socks5h" : "http");
    if (url) settings[protocol === "socks" ? "all" : protocol] = url;
  }
  if (values.get(".use-same-proxy") === "true" && settings.http) settings.https = settings.http;
  settings.bypass = [...(values.get(".ignore-hosts") || "").matchAll(/'([^']+)'/g)].flatMap((match) => bypassEntries(match[1]));
  return settings;
}

export function readSystemProxySettings({ env = process.env, currentPlatform = platform(), exec = execFileSync } = {}) {
  try {
    if (currentPlatform === "darwin") return parseMacSystemProxy(run(exec, "scutil", ["--proxy"]));
    if (currentPlatform === "win32") {
      const registry = (key) => run(exec, "reg.exe", ["query", WINDOWS_INTERNET_SETTINGS_KEY, "/v", key])
        .match(new RegExp(`${key}\\s+REG_(?:DWORD|SZ|EXPAND_SZ)\\s+(.+)`))?.[1]?.trim();
      if (!Number(registry("ProxyEnable"))) return {};
      const server = registry("ProxyServer");
      if (!server) return {};
      let overrides = "";
      try { overrides = registry("ProxyOverride") || ""; } catch {}
      return parseWindowsSystemProxy(server, overrides);
    }
    if (currentPlatform === "linux") {
      if (/kde/i.test(env.XDG_CURRENT_DESKTOP || "")) {
        for (const command of ["kreadconfig6", "kreadconfig5"]) {
          try {
            const read = (key) => run(exec, command, ["--file", "kioslaverc", "--group", "Proxy Settings", "--key", key]);
            if (read("ProxyType") !== "1") return {};
            const settings = {};
            for (const protocol of ["http", "https", "socks"]) {
              const address = read(`${protocol}Proxy`).replace(/\s+(\d+)$/, ":$1");
              const url = proxyAddress(address, protocol === "socks" ? "socks5h" : "http");
              if (url) settings[protocol === "socks" ? "all" : protocol] = url;
            }
            settings.bypass = bypassEntries(read("NoProxyFor"));
            return settings;
          } catch {}
        }
        return {};
      }
      return parseGnomeSystemProxy(run(exec, "gsettings", ["list-recursively", "org.gnome.system.proxy"]));
    }
  } catch {
    // Missing utilities, user-session settings or D-Bus are normal on servers.
  }
  return {};
}

const PROXY_KEYS = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"];
const hasExplicitProxy = (env) => PROXY_KEYS.some((key) => Boolean(env[key]));

export function systemProxyUrl(options = {}) {
  const { env = process.env } = options;
  if (hasExplicitProxy(env) || String(env.ORIGINROUTER_NO_PROXY || "") === "1") return null;
  if (env.ORIGINROUTER_PROXY) return proxyAddress(env.ORIGINROUTER_PROXY);
  const settings = readSystemProxySettings(options);
  return settings.https || settings.http || settings.all || null;
}

export function inheritSystemProxyEnv(baseEnv = process.env, currentPlatform = platform(), { exec = execFileSync } = {}) {
  const env = { ...baseEnv };
  if (!hasExplicitProxy(env) && String(env.ORIGINROUTER_NO_PROXY || "") !== "1") {
    const explicit = proxyAddress(env.ORIGINROUTER_PROXY);
    if (env.ORIGINROUTER_PROXY && !explicit) throw new Error("ORIGINROUTER_PROXY requires a complete supported proxy URL.");
    const settings = explicit
      ? (/^socks/.test(explicit) ? { all: explicit } : { http: explicit, https: explicit })
      : readSystemProxySettings({ env: baseEnv, currentPlatform, exec });
    for (const protocol of ["http", "https", "all"]) {
      if (settings[protocol]) env[`${protocol}_proxy`] = env[`${protocol.toUpperCase()}_PROXY`] = settings[protocol];
    }
    if (hasExplicitProxy(env)) {
      const entries = [...bypassEntries(env.no_proxy ?? env.NO_PROXY), "localhost", "127.0.0.1", "::1", ...(settings.bypass || [])];
      env.no_proxy = env.NO_PROXY = [...new Set(entries)].join(",");
    }
  }
  // Fill aliases (curl ignores uppercase HTTP_PROXY), preserving any
  // deliberate conflict already supplied by the caller.
  for (const protocol of ["http", "https", "all", "no"]) {
    const lower = `${protocol}_proxy`, upper = `${protocol.toUpperCase()}_PROXY`;
    if (env[lower] && !env[upper]) env[upper] = env[lower];
    if (env[upper] && !env[lower]) env[lower] = env[upper];
  }
  return env;
}
