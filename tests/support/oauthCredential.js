export function makeOAuthCredential(overrides = {}) {
  const now = Date.now();
  const accessTokenExpiresAt = overrides.accessTokenExpiresAt ?? now + 3_600_000;
  const baseTokens = {
    control: {
      token: "or_at_control_test",
      expiresAt: accessTokenExpiresAt,
      scopes: ["control.read", "control.write"],
    },
    ai: {
      token: "or_at_ai_test",
      expiresAt: accessTokenExpiresAt,
      scopes: ["ai.models", "ai.invoke"],
    },
    coding: {
      token: "or_at_coding_test",
      expiresAt: accessTokenExpiresAt,
      scopes: ["coding.invoke"],
    },
    relay: {
      token: "or_at_relay_test",
      expiresAt: accessTokenExpiresAt,
      scopes: ["relay.connect"],
    },
  };
  const credential = {
    kind: "oauth",
    clientId: "originrouter_cli",
    source: "originrouter_cli",
    deviceId: "device-test-001",
    sessionId: "or_ses_test_session",
    refreshToken: "or_rt_test_refresh",
    refreshExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
    tokenEndpoint: "https://surety.example.test/api/oauth/token",
    revocationEndpoint: "https://surety.example.test/api/oauth/revoke",
    ...overrides,
  };
  delete credential.accessTokenExpiresAt;
  credential.accessTokens = {
    ...baseTokens,
    ...(overrides.accessTokens || {}),
  };
  return credential;
}
