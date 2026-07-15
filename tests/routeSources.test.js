import assert from "node:assert/strict";

import {
  chooseCloudModel,
  chooseRemoteDevice,
  loadCloudModels,
  loadRemoteCliDevices,
  remoteProviderName,
  selectControlBaseUrl,
} from "../src/commands/routeSources.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

const signedIn = async () => makeOAuthCredential();

{
  const baseUrl = await selectControlBaseUrl({
    env: { ORIGINROUTER_CONTROL_BASE_URL: "https://override.example/" },
    fetchFn: async () => { throw new Error("override must skip probes"); },
  });
  assert.equal(baseUrl, "https://override.example");
}

{
  const calls = [];
  const models = await loadCloudModels({
    stateDir: "/tmp/route-sources-test",
    env: { ORIGINROUTER_AI_SERVER_BASE_URL: "https://ai.example/" },
    ensureFreshAccessTokenFn: signedIn,
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 1,
          data: {
            model_list: [
              {
                origin_name: "official-originrouter",
                models: [
                  { id: "claude-1", name: "Claude One" },
                  { id: "claude-1", name: "duplicate" },
                ],
              },
            ],
          },
        }),
      };
    },
  });
  assert.deepEqual(models, [{ id: "claude-1", name: "Claude One", origin: "OriginRouter Cloud" }]);
  assert.equal(calls[0].url, "https://ai.example/ai/model");
  assert.equal(calls[0].options.headers.Authorization, "Bearer or_at_ai_test");
  const selected = await chooseCloudModel(models, "claude-1");
  assert.equal(selected.id, "claude-1");
}

{
  const devices = await loadRemoteCliDevices({
    stateDir: "/tmp/route-sources-test",
    env: { ORIGINROUTER_CONTROL_BASE_URL: "https://control.example" },
    ensureFreshAccessTokenFn: signedIn,
    fetchFn: async (url, options) => {
      assert.equal(url, "https://control.example/cli/v1/devices");
      assert.equal(options.headers.Authorization, "Bearer or_at_control_test");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            devices: [
              { device_id: "device-cli-a", device_name: "Work Mac", online: true },
              { device_id: "device-cli-b", device_name: "Laptop", online: false },
            ],
          },
        }),
      };
    },
  });
  assert.equal(devices.length, 2);
  assert.equal((await chooseRemoteDevice(devices, "device-cli-a")).deviceName, "Work Mac");
  assert.equal(remoteProviderName("device-cli-a"), remoteProviderName("device-cli-a"));
  assert.notEqual(remoteProviderName("device-cli-a"), remoteProviderName("device-cli-b"));
}

console.log("route source tests ok");
