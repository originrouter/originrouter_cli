import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { canonicalJson } from "./src/crypto/deviceE2eeIdentity.js";

const dir = join(homedir(), ".originrouter");
const files = readdirSync(dir).filter(f => f.startsWith("device-e2ee-directory-v2-"));

const sortIds = (ids) => [...ids].sort((a,b) =>
  String(a.device_id).localeCompare(String(b.device_id)) || Number(a.key_version)-Number(b.key_version));

function headOf(policy, identities) {
  const records = sortIds(identities).map(i => ({
    protocol: i.protocol, device_id: i.device_id, source: i.source, epoch: i.epoch,
    key_version: i.key_version, signing_algorithm: i.signing_algorithm,
    signing_public_key: i.signing_public_key, agreement_algorithm: i.agreement_algorithm,
    agreement_public_key: i.agreement_public_key, previous_key_id: i.previous_key_id ?? null,
    created_at: i.created_at, key_id: i.key_id,
    previous_key_signature: i.previous_key_signature ?? null, self_signature: i.self_signature,
    trust_status: i.trust_status,
    ...(i.admission_proof ? { admission_proof: i.admission_proof } : {}),
  }));
  return "sha256:" + createHash("sha256").update(canonicalJson({
    epoch: policy.epoch,
    new_device_approval_required: policy.new_device_approval_required === true,
    ...(policy.policy_proof ? { policy_proof: policy.policy_proof } : {}),
    identities: records,
  })).digest("base64url");
}

for (const f of files) {
  const v = JSON.parse(readFileSync(join(dir,f),"utf8"));
  console.log(`\n=== ${f}`);
  console.log("  fetched_at:", v.fetched_at, "| epoch:", v.policy.epoch);
  const ageDays = (Date.now() - Date.parse(v.fetched_at))/86400000;
  console.log("  ageDays:", ageDays.toFixed(2));
  console.log("  head:", headOf(v.policy, v.identities));
  console.log("  identities:", v.identities.length);
  for (const i of sortIds(v.identities)) {
    console.log("   ", i.device_id, "v"+i.key_version, "trust="+i.trust_status);
  }
}
