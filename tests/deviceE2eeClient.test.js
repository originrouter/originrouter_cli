import assert from "node:assert/strict";

import {
  getCliDeviceE2eeStatus,
  registerCliDeviceE2eeIdentity,
} from "../src/security/deviceE2eeClient.js";

const requests = [];
const fetchFn = async (url, init) => {
  requests.push({ url, init });
  if (url.endsWith("/identity")) {
    return new Response(JSON.stringify({
      data: { identity: { key_id: "sha256:key", trust_status: "pending" } },
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

console.log("device e2ee client tests ok");
