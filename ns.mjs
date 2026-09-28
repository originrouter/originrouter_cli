import { createHash } from "node:crypto";
// Which namespace does each cache file correspond to?
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const dir = join(homedir(), ".originrouter");
for (const f of readdirSync(dir).filter(x=>x.startsWith("device-e2ee-directory-v2-"))) {
  const suffix = f.replace("device-e2ee-directory-v2-","").replace(".json","");
  console.log(suffix);
}
console.log("\n--- active namespace on THIS machine ---");
console.log("da4ac1f6bb8941db0a5c8888100005ecdc7e5feafbe11293a3d49213bc95f61c");
console.log("sha256(that) base64url[0:22] =",
  createHash("sha256").update("da4ac1f6bb8941db0a5c8888100005ecdc7e5feafbe11293a3d49213bc95f61c").digest("base64url").slice(0,22));
