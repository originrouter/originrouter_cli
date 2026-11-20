import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inheritSystemProxyEnv, parseMacSystemProxy, parseWindowsSystemProxy, parseGnomeSystemProxy, systemProxyUrl } from "../src/utils/systemProxy.js";
import { installerEnvironment } from "../src/commands/setup.js";

const mac = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7891
  SOCKSEnable : 1
  SOCKSProxy : ::1
  SOCKSPort : 7892
  ExceptionsList : <array> {
    0 : *.local
    1 : 10.0.0.0/8
  }
}`;
const gnome = `org.gnome.system.proxy mode 'manual'
org.gnome.system.proxy ignore-hosts ['localhost', '10.0.0.0/8']
org.gnome.system.proxy.http host '127.0.0.1'
org.gnome.system.proxy.http port 7890
org.gnome.system.proxy.https host '127.0.0.1'
org.gnome.system.proxy.https port 7891
org.gnome.system.proxy.socks host '127.0.0.1'
org.gnome.system.proxy.socks port 7892`;
const noSystemRead = () => { throw new Error("must not consult OS settings"); };

test("explicit proxy environment wins over OriginRouter and OS settings", () => {
  for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    let called = false;
    const base = { PATH: "/bin", [key]: "http://explicit:7890", ORIGINROUTER_PROXY: "http://fallback:9" };
    const result = inheritSystemProxyEnv(base, "darwin", { exec: () => { called = true; return mac; } });
    assert.equal(called, false);
    assert.equal(result[key], base[key]);
    assert.equal(result[key.toLowerCase()], base[key]);
    assert.equal(systemProxyUrl({ env: base, currentPlatform: "darwin", exec: noSystemRead }), null);
  }
});

test("different explicit protocol URLs and conflicting spellings are preserved", () => {
  const base = { HTTP_PROXY: "http://upper:1", http_proxy: "http://lower:2", HTTPS_PROXY: "http://tls:3", NO_PROXY: "*" };
  const result = inheritSystemProxyEnv(base, "darwin", { exec: noSystemRead });
  assert.equal(result.HTTP_PROXY, base.HTTP_PROXY);
  assert.equal(result.http_proxy, base.http_proxy);
  assert.equal(result.https_proxy, base.HTTPS_PROXY);
  assert.equal(result.no_proxy, "*");
});

test("macOS fallback exports separate HTTP, HTTPS, SOCKS and bypass rules", () => {
  const base = { PATH: "/bin", NO_PROXY: "private.example" };
  const result = inheritSystemProxyEnv(base, "darwin", { exec: () => mac });
  assert.equal(result.http_proxy, "http://127.0.0.1:7890");
  assert.equal(result.HTTPS_PROXY, "http://127.0.0.1:7891");
  assert.equal(result.all_proxy, "socks5h://[::1]:7892");
  assert.equal(result.no_proxy, result.NO_PROXY);
  for (const entry of ["localhost", "127.0.0.1", "::1", ".local", "10.0.0.0/8", "private.example"]) assert.ok(result.NO_PROXY.split(",").includes(entry));
  assert.deepEqual(base, { PATH: "/bin", NO_PROXY: "private.example" });
});

test("system-proxy changes are resolved from the original environment on each launch", () => {
  const base = { PATH: "/bin" };
  assert.ok(inheritSystemProxyEnv(base, "darwin", { exec: () => mac }).http_proxy);
  assert.deepEqual(inheritSystemProxyEnv(base, "darwin", { exec: () => "" }), base);
});

test("disabling system discovery preserves manual proxies", () => {
  assert.deepEqual(inheritSystemProxyEnv({ ORIGINROUTER_NO_PROXY: "1" }, "darwin", { exec: noSystemRead }), { ORIGINROUTER_NO_PROXY: "1" });
  assert.equal(inheritSystemProxyEnv({ ORIGINROUTER_NO_PROXY: "1", https_proxy: "http://manual:1" }, "darwin", { exec: noSystemRead }).HTTPS_PROXY, "http://manual:1");
});

test("OriginRouter fallback is available on every platform and rejects malformed URLs", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const result = inheritSystemProxyEnv({ ORIGINROUTER_PROXY: "http://fallback:9" }, platform, { exec: noSystemRead });
    assert.equal(result.http_proxy, "http://fallback:9");
    assert.equal(result.HTTPS_PROXY, "http://fallback:9");
  }
  assert.throws(() => inheritSystemProxyEnv({ ORIGINROUTER_PROXY: "not a URL" }, "darwin", { exec: noSystemRead }), /supported proxy URL/);
});

test("PAC-only and disabled system settings never become static proxy URLs", () => {
  const result = parseMacSystemProxy("ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : https://example.com/proxy.pac\nHTTPEnable : 0\nHTTPPort : 7890\nHTTPProxy : localhost");
  assert.equal(result.http, undefined);
  assert.equal(result.https, undefined);
  assert.equal(result.all, undefined);
});

test("invalid OS ports are ignored", () => {
  assert.equal(parseMacSystemProxy(mac.replace("HTTPPort : 7890", "HTTPPort : 99999")).http, undefined);
});

test("Windows static settings retain per-protocol routing and bypass rules", () => {
  assert.deepEqual(parseWindowsSystemProxy("http=host:80;https=https://tls:443;socks=127.0.0.1:1080", "<local>;*.corp;10.0.0.0/8"), {
    http: "http://host:80", https: "https://tls:443", all: "socks5h://127.0.0.1:1080", bypass: [".corp", "10.0.0.0/8"],
  });
  assert.equal(parseWindowsSystemProxy("http://host:8080").https, "http://host:8080");
});

test("Windows registry reader accepts DWORD/SZ values and an absent optional override", () => {
  const result = inheritSystemProxyEnv({}, "win32", { exec: (command, args) => {
    assert.equal(command, "reg.exe");
    const key = args.at(-1);
    if (key === "ProxyEnable") return " ProxyEnable    REG_DWORD    0x1";
    if (key === "ProxyServer") return " ProxyServer    REG_SZ    127.0.0.1:7890";
    throw new Error("optional value absent");
  } });
  assert.equal(result.https_proxy, "http://127.0.0.1:7890");
});

test("GNOME manual settings are read in one bounded command", () => {
  const result = inheritSystemProxyEnv({}, "linux", { exec: (command, args, options) => {
    assert.equal(command, "gsettings");
    assert.deepEqual(args, ["list-recursively", "org.gnome.system.proxy"]);
    assert.equal(options.timeout, 1500);
    return gnome;
  } });
  assert.equal(result.http_proxy, "http://127.0.0.1:7890");
  assert.equal(result.https_proxy, "http://127.0.0.1:7891");
  assert.equal(result.all_proxy, "socks5h://127.0.0.1:7892");
  assert.ok(result.NO_PROXY.includes("10.0.0.0/8"));
  assert.deepEqual(parseGnomeSystemProxy(gnome.replace("mode 'manual'", "mode 'auto'")), {});
});

test("KDE reads manual KIO settings, including space-separated ports", () => {
  const values = { ProxyType: "1", httpProxy: "http://localhost 7890", httpsProxy: "http://localhost:7891", socksProxy: "", NoProxyFor: "localhost,.corp" };
  const result = inheritSystemProxyEnv({ XDG_CURRENT_DESKTOP: "KDE" }, "linux", { exec: (_, args) => values[args.at(-1)] });
  assert.equal(result.http_proxy, "http://localhost:7890");
  assert.equal(result.https_proxy, "http://localhost:7891");
});

test("headless hosts tolerate missing system tools", () => {
  assert.deepEqual(inheritSystemProxyEnv({ PATH: "/bin" }, "linux", { exec: () => { throw new Error("ENOENT"); } }), { PATH: "/bin" });
});

test("installer environment propagates into a nested download process", () => {
  const env = installerEnvironment({ env: {} }, { ...process.env, http_proxy: "http://nested:7890", HTTP_PROXY: "http://nested:7890" });
  const childCode = `const {execFileSync}=require('node:child_process'); process.stdout.write(execFileSync(process.execPath,['-e', 'process.stdout.write(process.env.http_proxy)']));`;
  assert.equal(execFileSync(process.execPath, ["-e", childCode], { env, encoding: "utf8" }), "http://nested:7890");
});

test("Unix bootstrap exports system settings to child processes and honors ALL_PROXY", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "originrouter-bootstrap-proxy-"));
  const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
  try {
    for (const [name, text] of [["uname", "Darwin"], ["scutil", mac]]) {
      const file = join(root, name);
      writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${quote(text)}\n`);
      chmodSync(file, 0o755);
    }
    const source = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");
    const block = source.slice(source.indexOf("# Bootstrap before Node"), source.indexOf("# Privilege helper:"));
    const probe = `${block}\n${quote(process.execPath)} -e 'console.log(JSON.stringify({http:process.env.http_proxy,https:process.env.https_proxy,all:process.env.all_proxy,no:process.env.NO_PROXY}))'`;
    const environment = { PATH: `${root}:/usr/bin:/bin` };
    const detected = JSON.parse(execFileSync("bash", ["-eu", "-c", probe], { env: environment, encoding: "utf8" }).trim().split("\n").at(-1));
    assert.equal(detected.http, "http://127.0.0.1:7890");
    assert.equal(detected.https, "http://127.0.0.1:7891");
    assert.equal(detected.all, "socks5h://[::1]:7892");
    const explicit = JSON.parse(execFileSync("bash", ["-eu", "-c", probe], { env: { ...environment, ALL_PROXY: "socks5h://manual:9" }, encoding: "utf8" }).trim().split("\n").at(-1));
    assert.equal(explicit.all, "socks5h://manual:9");
    assert.equal(explicit.http, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
