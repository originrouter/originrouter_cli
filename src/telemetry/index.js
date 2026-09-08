import { TelemetryQueue } from "./telemetryQueue.js";
import { TelemetryUploader } from "./telemetryUploader.js";

export function createTelemetryPipeline({ stateDir, uploadOwner = true } = {}) {
  const queue = new TelemetryQueue({ stateDir });
  const uploader = uploadOwner ? new TelemetryUploader({ queue, stateDir }) : null;
  uploader?.schedule({ delayMs: 1_000 });
  return { queue, uploader };
}

export { TelemetryQueue, normalizeTelemetryEvent } from "./telemetryQueue.js";
export { TelemetryUploader } from "./telemetryUploader.js";
