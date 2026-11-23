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
  // The registry fills a name only into an empty slot, so a proposal is
  // useful exactly until the server has confirmed one. A synced name
  // belonging to another account is a different device's name, not ours —
  // propose in that case too, and also when the registry answered "unnamed"
  // last time (e.g. the account's rows were rebuilt under the same scope).
  const needsProposal = device.displayNameSynced !== true
      || (device.displayNameAccountScope && device.displayNameAccountScope !== accountScope)
      || device.serverNameMissing === true;
  const body = {};
  if (needsProposal) {
    // An id-shaped display name is a placeholder the daemon once cached from
    // the server, not a name worth proposing. Offer the local default instead.
    const owned = String(device.displayName || '').trim();
    const proposal = !owned || owned === device.deviceId ? defaultDeviceDisplayName() : owned;
    body.name = [...String(proposal || device.deviceId)].slice(0, 128).join('');
  }
  const response = await fetchFn(`${String(baseUrl).replace(/\/+$/, '')}/cli/v1/devices/self/name/sync`, {
    method:'POST', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
    body:JSON.stringify(body), signal:AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`device name sync HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload?.data;
  const current = readCodingAuth(stateDir);
  if (!current || current.accountScope !== accountScope || current.sessionId !== credential.sessionId ||
      current.deviceId !== device.deviceId || result?.device_id !== device.deviceId) return null;
  // The registry answers with the raw column: null still means unnamed.
  // Only a real non-id name is worth persisting as the synchronized one.
  const name = typeof result.device_name === 'string' ? result.device_name.trim() : '';
  device.serverNameMissing = !name;
  if (!name || name === device.deviceId) return null;
  if (name === device.displayName
      && device.displayNameSynced === true
      && device.displayNameAccountScope === accountScope) return device.displayName;
  const updated = setSynchronizedDeviceDisplayName(name, stateDir, accountScope);
  if (updated) Object.assign(device, updated);
  return updated?.displayName || null;
}
