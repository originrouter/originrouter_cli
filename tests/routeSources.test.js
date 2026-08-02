import assert from "node:assert/strict";

import {
  chooseCloudModel,
  chooseRemoteDevice,
  chooseRemoteProvider,
  loadCliDeviceDirectory,
  loadCloudModels,
  loadRemoteCliDevices,
  printCliDevices,
  printRemoteCliDevices,
  remoteRouteEligibleDevices,
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
  const devices = await loadCliDeviceDirectory({
    stateDir: "/tmp/route-sources-test",
    env: { ORIGINROUTER_CONTROL_BASE_URL: "https://control.example" },
    ensureFreshAccessTokenFn: signedIn,
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      json: async () => url.endsWith("/device-e2ee/directory")
        ? {
            data: {
              identities: [
                { device_id: "device-cli-a", trust_status: "trusted" },
              ],
            },
          }
        : {
            data: {
              devices: [
                {
                  device_id: "device-cli-a",
                  device_name: "Work Mac",
                  is_self: true,
                  online: true,
                  remote_share_running: false,
                },
              ],
            },
          },
    }),
  });
  assert.equal(devices[0].trustStatus, "trusted");
  assert.equal(devices[0].isSelf, true);
  const lines = [];
  printCliDevices(devices, (line) => lines.push(line));
  assert.match(lines[0], /this device · online · trusted · Remote Share off/);
}

{
  const allDevices = [
    {
      deviceId: "device-cli-a",
      deviceName: "Work Mac",
      online: true,
      remoteShareRunning: false,
      remoteShareCatalog: [],
    },
    {
      deviceId: "device-cli-b",
      deviceName: "Laptop",
      online: true,
      remoteShareRunning: false,
      remoteShareCatalog: [],
    },
  ];
  assert.deepEqual(remoteRouteEligibleDevices(allDevices), []);
  const lines = [];
  printRemoteCliDevices([], (line) => lines.push(line), { allDevices });
  assert.deepEqual(lines, [
    "No devices are currently sharing remote model providers.",
    "2 authorized CLI devices are online, but Remote Share is not enabled.",
  ]);
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
              {
                device_id: "device-cli-a",
                device_name: "Work Mac",
                online: true,
                remote_share_running: true,
                remote_share_catalog: [
                  { provider: "deepseek", model: "deepseek-chat" },
                  { provider: "glm", model: "glm-5" },
                ],
              },
              { device_id: "device-cli-b", device_name: "Laptop", online: false },
            ],
          },
        }),
      };
    },
  });
  assert.equal(devices.length, 2);
  assert.equal((await chooseRemoteDevice(devices, "device-cli-a")).deviceName, "Work Mac");
  assert.deepEqual(await chooseRemoteProvider(devices[0], "glm"), {
    provider: "glm",
    model: "glm-5",
  });
  assert.equal(remoteProviderName("device-cli-a"), remoteProviderName("device-cli-a"));
  assert.notEqual(remoteProviderName("device-cli-a"), remoteProviderName("device-cli-b"));
}

console.log("route source tests ok");
