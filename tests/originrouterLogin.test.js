import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loginUrlFor,
  loginWithDeviceFlow,
  persistOAuthCredential,
  verificationUrlFor,
} from "../src/auth/originrouterLogin.js";
import { readCodingAuth } from "../src/persistence/codingAuth.js";
import { isOAuthCredentialShape } from "../src/runtime/authContract.js";

function oauthResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

const enrollmentIdentity = {
  protocol: "originrouter-device-e2ee-v2",
  device_id: "device-cli-stable",
  source: "originrouter_cli",
  key_id: "sha256:test-key",
};

const signEnrollmentChallenge = (challenge) => {
  assert.equal(challenge, "or_ch_test");
  return "binding-signature";
};

test("login URL contains only the one-time user code", () => {
  assert.equal(
    loginUrlFor("https://app.originrouter.com/"),
    "https://app.originrouter.com/cli/authorize",
  );
  assert.equal(
    verificationUrlFor({ h5BaseUrl: "https://app.originrouter.com", userCode: "ABCD-EFGH" }),
    "https://app.originrouter.com/cli/authorize?user_code=ABCD-EFGH",
  );
});

test("Device Flow rotates RT sequentially and builds four audience tokens", async () => {
  const calls = [];
  let devicePolls = 0;
  const fetchFn = async (url, init) => {
    const body = new URLSearchParams(init.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/api/oauth/device/code")) {
      return oauthResponse(200, {
        device_code: "or_dc_test",
        user_code: "ABCD-EFGH",
        expires_in: 600,
        interval: 1,
        enrollment_challenge: "or_ch_test",
      });
    }
    if (String(url).endsWith("/api/oauth/device/bind")) {
      assert.equal(body.get("device_code"), "or_dc_test");
      assert.equal(body.get("enrollment_challenge"), "or_ch_test");
      assert.equal(body.get("e2ee_binding_signature"), "binding-signature");
      assert.deepEqual(JSON.parse(body.get("e2ee_identity")), enrollmentIdentity);
      return oauthResponse(200, { bound: true });
    }
    if (body.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
      devicePolls += 1;
      if (devicePolls === 1) return oauthResponse(400, { error: "authorization_pending" });
      return oauthResponse(200, {
        access_token: "or_at_control_login",
        refresh_token: "or_rt_1",
        session_id: "or_ses_login",
        expires_in: 600,
        refresh_expires_in: 2_592_000,
        scope: "control.read control.write",
      });
    }
    const resource = body.get("resource");
    const rotation = {
      "originrouter.ai": ["or_rt_1", "or_at_ai_login", "or_rt_2", "ai.models ai.invoke"],
      "originrouter.coding": ["or_rt_2", "or_at_coding_login", "or_rt_3", "coding.invoke"],
      "originrouter.relay": ["or_rt_3", "or_at_relay_login", "or_rt_4", "relay.connect"],
    }[resource];
    assert.ok(rotation, `unexpected resource ${resource}`);
    assert.equal(body.get("refresh_token"), rotation[0]);
    return oauthResponse(200, {
      access_token: rotation[1],
      refresh_token: rotation[2],
      session_id: "or_ses_login",
      expires_in: 600,
      refresh_expires_in: 2_592_000,
      scope: rotation[3],
    });
  };

  const printed = [];
  const credential = await loginWithDeviceFlow({
    suretyBaseUrl: "https://surety.example.test",
    h5BaseUrl: "https://app.originrouter.com",
    deviceId: "device-cli-stable",
    deviceName: "Work Mac",
    e2eeIdentity: enrollmentIdentity,
    signEnrollmentChallenge,
    noBrowser: true,
    sleepFn: async () => {},
    printFn: (line) => printed.push(line),
    fetchFn,
  });

  assert.equal(isOAuthCredentialShape(credential), true);
  assert.equal(credential.deviceId, "device-cli-stable");
  assert.equal(credential.sessionId, "or_ses_login");
  assert.equal(credential.refreshToken, "or_rt_4");
  assert.equal(credential.accessTokens.control.token, "or_at_control_login");
  assert.equal(credential.accessTokens.ai.token, "or_at_ai_login");
  assert.equal(credential.accessTokens.coding.token, "or_at_coding_login");
  assert.equal(credential.accessTokens.relay.token, "or_at_relay_login");
  assert.equal(devicePolls, 2);
  assert.match(printed.join("\n"), /ABCD-EFGH/);
  assert.equal(calls[0].body.get("device_id"), "device-cli-stable");
});

test("Device Flow maps denial to a stable client error", async () => {
  let call = 0;
  await assert.rejects(
    () => loginWithDeviceFlow({
      suretyBaseUrl: "https://surety.example.test",
      h5BaseUrl: "https://app.originrouter.com",
      deviceId: "device-cli-stable",
      noBrowser: true,
      sleepFn: async () => {},
      printFn: () => {},
      fetchFn: async () => {
        call += 1;
        return call === 1
          ? oauthResponse(200, {
            device_code: "or_dc_test",
            user_code: "ABCD",
            expires_in: 600,
            interval: 1,
            enrollment_challenge: "or_ch_test",
          })
          : call === 2
            ? oauthResponse(200, { bound: true })
            : oauthResponse(400, { error: "access_denied" });
      },
      e2eeIdentity: enrollmentIdentity,
      signEnrollmentChallenge,
    }),
    (error) => error.code === "device_flow_denied" && error.message === "device_flow_denied",
  );
});

test("persistOAuthCredential writes the complete OAuth session", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-login-persist-"));
  try {
    const credential = {
      kind: "oauth",
      clientId: "originrouter_cli",
      source: "originrouter_cli",
      deviceId: "device-cli-stable",
      sessionId: "or_ses_login",
      refreshToken: "or_rt_final",
      refreshExpiresAt: Date.now() + 100_000,
      tokenEndpoint: "https://surety.example.test/api/oauth/token",
      revocationEndpoint: "https://surety.example.test/api/oauth/revoke",
      accessTokens: Object.fromEntries(
        ["control", "ai", "coding", "relay"].map((key) => [key, {
          token: `or_at_${key}`,
          expiresAt: Date.now() + 100_000,
          scopes: [],
        }]),
      ),
    };
    persistOAuthCredential({ stateDir, credential });
    assert.equal(readCodingAuth(stateDir).refreshToken, "or_rt_final");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
