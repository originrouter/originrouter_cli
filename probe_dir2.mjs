import { ensureFreshAccessToken } from "./src/runtime/oauthTokenRefresher.js";
import { ensureStateDir } from "./src/persistence/state.js";
import { readCodingAuth } from "./src/persistence/codingAuth.js";
import { OAUTH_RESOURCES } from "./src/runtime/authContract.js";

const stateDir = ensureStateDir();
await ensureFreshAccessToken({ stateDir, resource: OAUTH_RESOURCES.CONTROL, forceRefresh: true });
const auth = readCodingAuth(stateDir);
const tok = auth.accessTokens.control.token;
console.log("fresh control token acquired");

const base = "https://app.easytransnote.com";
for (const path of ["/app/v1/device-e2ee/directory", "/app/v1/agent/sessions"]) {
  const r = await fetch(base + path, { headers: { Authorization: `Bearer ${tok}` } });
  console.log(`\n=== ${path} -> ${r.status}`);
  const t = await r.text();
  console.log(t.slice(0, 2500));
}
