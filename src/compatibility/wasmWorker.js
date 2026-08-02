import { parentPort, workerData } from "node:worker_threads";

import { compileCompatibilityWasm, executeCompatibilityWasm } from "./wasmDomHost.js";

const moduleBytes = Buffer.from(workerData.moduleBytes, "base64");
const maxOutputBytes = workerData.maxOutputBytes;
const module = await compileCompatibilityWasm(moduleBytes);

parentPort.on("message", ({ id, document, context, state }) => {
  try {
    const result = executeCompatibilityWasm(module, document, context, state);
    const serialized = JSON.stringify({ document: result.document, state: result.state });
    if (Buffer.byteLength(serialized, "utf8") > maxOutputBytes) {
      throw new Error("WASM patch output exceeds the configured size limit");
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        code: error?.code || "originrouter_wasm_patch_failed",
        message: error?.message || "WASM patch failed",
      },
    });
  }
});

parentPort.postMessage({ ready: true });
