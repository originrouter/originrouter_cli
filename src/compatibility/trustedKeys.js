// Production signing keys are pinned here by CLI releases. Keeping the key
// ring separate allows overlap during Ed25519 key rotation. Never place a
// private key in this repository.
export const PINNED_COMPATIBILITY_SIGNING_KEYS = Object.freeze({
  "originrouter-compatibility-2026-01": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAN93nfstfBePn4hzt0ez2mQ6B706+10S6bYhqxOI9h+w=
-----END PUBLIC KEY-----`,
});

export function trustedCompatibilityKeys(env = process.env) {
  let configured = {};
  const raw = env.ORIGINROUTER_COMPATIBILITY_TRUSTED_KEYS_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) configured = parsed;
    } catch {}
  }
  return { ...PINNED_COMPATIBILITY_SIGNING_KEYS, ...configured };
}
