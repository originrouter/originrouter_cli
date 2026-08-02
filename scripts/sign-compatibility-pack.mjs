#!/usr/bin/env node
import { createPrivateKey, sign } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import {
  COMPATIBILITY_SIGNATURE_DOMAIN,
  COMPATIBILITY_SIGNED_ENVELOPE,
  canonicalCompatibilityJson,
  validateCompatibilityPack,
} from "../src/compatibility/patchPack.js";

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument '${key || ""}'`);
    result[key.slice(2)] = value;
  }
  return result;
}

const args = options(process.argv.slice(2));
if (!args.input || !args["private-key"] || !args["key-id"] || !args.output) {
  throw new Error(
    "Usage: npm run sign:compatibility-pack -- --input <pack.json> --private-key <ed25519.pem> --key-id <id> --output <signed.json>",
  );
}

const payload = validateCompatibilityPack(JSON.parse(readFileSync(args.input, "utf8")));
const privateKey = createPrivateKey(readFileSync(args["private-key"]));
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("compatibility signing key must be Ed25519");
const signature = sign(
  null,
  Buffer.from(`${COMPATIBILITY_SIGNATURE_DOMAIN}${canonicalCompatibilityJson(payload)}`),
  privateKey,
).toString("base64url");
const envelope = {
  schema: COMPATIBILITY_SIGNED_ENVELOPE,
  key_id: args["key-id"],
  algorithm: "Ed25519",
  payload,
  signature,
};
const temporary = `${args.output}.${process.pid}.${Date.now()}.tmp`;
writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
chmodSync(temporary, 0o600);
renameSync(temporary, args.output);
chmodSync(args.output, 0o600);
console.log(`Signed ${payload.pack_id} revision ${payload.revision} with key ${args["key-id"]}.`);
