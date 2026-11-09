import { readCodingAuth } from '../persistence/codingAuth.js';
import { defaultDeviceDisplayName, setSynchronizedDeviceDisplayName } from '../persistence/state.js';
import { accessTokenFor, OAUTH_RESOURCES } from '../runtime/authContract.js';
import { ensureFreshAccessToken } from '../runtime/oauthTokenRefresher.js';

// The response is applied only to the account/session which sent it. A stale
// in-flight response must never rename a device after an account switch.
export async function syncDeviceName({stateDir, baseUrl, device, accountScope, fetchFn = globalThis.fetch}) {
  const credential = await ensureFreshAccessToken({stateDir, resource:OAUTH_RESOURCES.CONTROL, fetchFn});
  if (!credential || credential.accountScope !== accountScope || credential.deviceId !== device.deviceId) return null;
  const token = accessTokenFor(credential, OAUTH_RESOURCES.CONTROL)?.token;
  if (!token) return null;
  const proposal = device.displayNameAccountScope && device.displayNameAccountScope !== accountScope
    ? defaultDeviceDisplayName() : device.displayName;
  const response = await fetchFn(`${String(baseUrl).replace(/\/+$/, '')}/cli/v1/devices/self/name/sync`, {
    method:'POST', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
    body:JSON.stringify({name:[...String(proposal || device.deviceId)].slice(0,128).join('')}), signal:AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`device name sync HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload?.data;
  const current = readCodingAuth(stateDir);
  if (!current || current.accountScope !== accountScope || current.sessionId !== credential.sessionId ||
      current.deviceId !== device.deviceId || result?.device_id !== device.deviceId ||
      typeof result?.device_name !== 'string' || !result.device_name.trim()) return null;
  const updated = setSynchronizedDeviceDisplayName(result.device_name, stateDir, accountScope);
  if (updated) Object.assign(device, updated);
  return updated?.displayName || null;
}
