import { spawnSync } from 'node:child_process';

// Real local executables, but only local in-process model fixtures are used.
const result = spawnSync(process.execPath, ['--test',
  './tests/realRuntimeOffline.test.js',
  './tests/realRuntimeSupervisorOffline.test.js',
  './tests/realScheduledLaunchOffline.test.js',
  './tests/realCodexDeviceToolOffline.test.js',
  './tests/realClaudeDeviceToolOffline.test.js',
], {stdio:'inherit', env:{...process.env, ORIGINROUTER_RUN_REAL_AGENT_OFFLINE_TESTS:'1'}});
if (result.error) { console.error(result.error.message); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
