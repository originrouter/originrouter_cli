export const VERSION = "0.2.2";
export const DEFAULT_RELAY_URL = "https://app.easytransnote.com";
// Public control-plane aliases backed by the same OriginRouter service.
// Keep this list deliberately small and code-owned: callers must never probe
// a URL supplied by an untrusted Relay message or account record.
export const OFFICIAL_RELAY_URLS = Object.freeze([
  "https://app.originrouter.com",
  DEFAULT_RELAY_URL,
]);
export const DEFAULT_DEVICE_ID = "local-dev";
export const DEFAULT_EXECUTOR = "pty";
export const DEFAULT_LOCAL_API_PORT = 7437;
export const DEFAULT_PROXY_PORT = 40123;
export const DEFAULT_REMOTE_SHARE_PROXY_PORT = 40124;
