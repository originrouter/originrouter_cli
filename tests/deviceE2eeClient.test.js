import assert from "node:assert/strict";

import {
  getCliDeviceE2eeStatus,
  registerCliDeviceE2eeIdentity,
  removeCurrentCliDevice,
  signOutCurrentCliDevice,
} from "../src/security/deviceE2eeClient.js";

const requests = [];
const fetchFn = async (url, init) => {
  requests.push({ url, init });
  if (url.endsWith("/identity")) {
    return new Response(JSON.stringify({
      data: { identity: { key_id: "sha256:key", trust_status: "pending" } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.endsWith("/self/remove")) {
    return new Response(JSON.stringify({
      data: { identity: { key_id: "sha256:key", trust_status: "revoked" } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.endsWith("/devices/self/sign-out")) {
    return new Response(JSON.stringify({
      data: { signed_out: true, trust_preserved: true },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({
    data: {
      policy: { epoch: 1, new_device_approval_required: true },
      identity: { key_id: "sha256:key", trust_status: "pending" },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
};

const registered = await registerCliDeviceE2eeIdentity({
  controlBaseUrl: "https://control.example.test/",
  accessToken: "or_at_test",
  identity: { protocol: "originrouter-device-e2ee-v2" },
  fetchFn,
});
assert.equal(registered.trust_status, "pending");
assert.equal(requests[0].url, "https://control.example.test/cli/v1/device-e2ee/identity");
assert.equal(requests[0].init.headers.Authorization, "Bearer or_at_test");

const status = await getCliDeviceE2eeStatus({
  controlBaseUrl: "https://control.example.test",
  accessToken: "or_at_test",
  fetchFn,
});
assert.equal(status.policy.new_device_approval_required, true);

const removed = await removeCurrentCliDevice({
  controlBaseUrl: "https://control.example.test",
  accessToken: "or_at_test",
  signedRemoval: { action: "remove_current_device", signature: "signed" },
  fetchFn,
});
assert.equal(removed.trust_status, "revoked");
assert.equal(requests[2].url, "https://control.example.test/cli/v1/device-e2ee/self/remove");
assert.deepEqual(JSON.parse(requests[2].init.body), {
  action: "remove_current_device",
  signature: "signed",
});

const signedOut = await signOutCurrentCliDevice({
  controlBaseUrl: "https://control.example.test",
  accessToken: "or_at_test",
  fetchFn,
});
assert.equal(signedOut.trust_preserved, true);
assert.equal(requests[3].url, "https://control.example.test/cli/v1/devices/self/sign-out");

console.log("device e2ee client tests ok");
