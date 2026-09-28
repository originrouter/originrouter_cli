import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const v = JSON.parse(readFileSync(join(homedir(),".originrouter","device-e2ee-directory-v2-CXoFuJgVtIHAhcqYJG9h2m.json"),"utf8"));
console.log("THIS SESSION'S CACHE (or_ses_UYZnzwQvpitYwLkzCi3HzPt7nBeVEgo4)");
console.log("  fetched_at:", v.fetched_at);
const ageH = (Date.now()-Date.parse(v.fetched_at))/3600000;
console.log("  age:", ageH.toFixed(1), "hours   (maxStale = 24h)");
console.log("  policy epoch:", v.policy.epoch, " new_device_approval_required:", v.policy.new_device_approval_required);
console.log("  devices cached:", v.identities.map(i=>i.device_id).join("\n                  "));
console.log("\n  MINI (device-fdc03b4b8ec94badee9dc2f84c6aef96) present?",
  v.identities.some(i=>i.device_id==="device-fdc03b4b8ec94badee9dc2f84c6aef96"));
