import { readDeviceE2eeDirectoryCache, deviceE2eeDirectoryHead, deviceE2eeDirectoryCacheState }
  from "./src/security/deviceE2eeDirectoryCache.js";
import { ensureStateDir } from "./src/persistence/state.js";
import { readCodingAuth } from "./src/persistence/codingAuth.js";

const stateDir = ensureStateDir();
const auth = readCodingAuth(stateDir);
// The CLI namespaces caches by the ACTIVE account namespace, not the session.
const ns = "da4ac1f6bb8941db0a5c8888100005ecdc7e5feafbe11293a3d49213bc95f61c";
const cache = readDeviceE2eeDirectoryCache(stateDir, { namespace: ns });
console.log("cache found:", !!cache);
if (cache) {
  console.log("fetched_at:", cache.fetched_at);
  console.log("policy:", JSON.stringify(cache.policy));
  console.log("head:", deviceE2eeDirectoryHead(cache));
  console.log("state:", JSON.stringify(deviceE2eeDirectoryCacheState(cache)));
  console.log("\nidentities in CLI cache:");
  for (const i of cache.identities) {
    console.log(" ", i.device_id, i.source, "v"+i.key_version, i.key_id, "trust="+i.trust_status);
  }
}
