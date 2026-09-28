import { readCodingAuth } from "./src/persistence/codingAuth.js";
import { ensureStateDir } from "./src/persistence/state.js";

const stateDir = ensureStateDir();
const auth = readCodingAuth(stateDir);
const ctl = auth.accessTokens.control;
console.log("deviceId:", auth.deviceId);
console.log("sessionId:", auth.sessionId);
console.log("control exp:", new Date(ctl.expiresAt).toISOString(), "now:", new Date().toISOString());
const r = await fetch("https://app.easytransnote.com/app/v1/device-e2ee/directory", {
  headers: { Authorization: `Bearer ${ctl.token}` },
});
console.log("directory status:", r.status);
const body = await r.text();
console.log(body.slice(0, 2000));
