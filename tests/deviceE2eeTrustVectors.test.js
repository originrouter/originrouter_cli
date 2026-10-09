// Cross-language trust-evaluation vectors.
//
// The directory cache's trust decision is implemented twice — here and in
// `lib/features/security/device_e2ee_directory_cache.dart` — and the two have
// to agree, because a device that one side trusts and the other rejects is a
// device whose relayed messages fail with no error anywhere. The envelope and
// directory-head vectors cover the crypto; these cover the policy, which is
// where the implementations actually differed.
//
// `tests/deviceE2eeCrossLanguage.test.js` has the Dart counterpart and reads
// the same fixture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeDeviceE2eeDirectoryCache } from "../src/security/deviceE2eeDirectoryCache.js";

const vectors = JSON.parse(readFileSync(
  new URL("./fixtures/device_e2ee_trust_vectors.json", import.meta.url),
  "utf8",
));

for (const vector of vectors.cases) {
  const accepted = (() => {
    try {
      storeDeviceE2eeDirectoryCache(
        join(mkdtempSync(join(tmpdir(), "originrouter-trust-vector-")), "cache"),
        vector.directory,
      );
      return true;
    } catch {
      return false;
    }
  })();
  assert.equal(
    accepted,
    vector.expect === "accept",
    `${vector.name}: expected ${vector.expect}. ${vector.why}`,
  );
}

console.log(`E2EE trust vectors ok (${vectors.cases.length} cases)`);
