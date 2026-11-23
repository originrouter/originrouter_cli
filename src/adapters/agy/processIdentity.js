import { processStartEpochMs, isSameLiveProcess } from '../../local/processLiveness.js';

export { processStartEpochMs };
export function agyProcessAlive(pid, startedAt) {
  if (process.platform !== 'win32') return isSameLiveProcess(pid, startedAt);
  // Without an OS birth-time query, conservatively refuse a possibly-live writer.
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
