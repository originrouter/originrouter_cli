function base(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function request(path, {
  controlBaseUrl,
  accessToken,
  method = "GET",
  body,
  fetchFn = globalThis.fetch,
}) {
  const response = await fetchFn(`${base(controlBaseUrl)}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(payload?.detail?.code || payload?.error || `device E2EE HTTP ${response.status}`);
    error.code = payload?.detail?.code || "device_e2ee_request_failed";
    error.status = response.status;
    throw error;
  }
  return payload?.data || payload;
}

export async function registerCliDeviceE2eeIdentity(options) {
  const data = await request("/cli/v1/device-e2ee/identity", {
    ...options,
    method: "POST",
    body: options.identity,
  });
  return data.identity;
}

export async function getCliDeviceE2eeStatus(options) {
  return request("/cli/v1/device-e2ee/status", options);
}

export async function getCliDeviceE2eeDirectory(options) {
  return request("/cli/v1/device-e2ee/directory", options);
}
