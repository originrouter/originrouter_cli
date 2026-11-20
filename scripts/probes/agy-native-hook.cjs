// Live-probe fixture, installed only in the probe's temporary workspace.
const http = require('node:http');
const fs = require('node:fs');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  const mode = fs.readFileSync(process.env.ORIGINROUTER_AGY_PROBE_MODE, 'utf8').trim();
  if (payload.hookEventName === 'PreToolUse' && mode === 'crash') process.exit(7);
  if (payload.hookEventName === 'PreToolUse' && mode === 'malformed') {
    process.stdout.write('invalid hook json');
    return;
  }
  const body = JSON.stringify({ payload, mode, pid: process.pid, at: Date.now() });
  const request = http.request(process.env.ORIGINROUTER_AGY_PROBE_URL + '/hook', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.ORIGINROUTER_AGY_PROBE_TOKEN}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  }, response => {
    let result = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { result += chunk; });
    response.on('end', () => {
      if (response.statusCode !== 200) {
        process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'Probe broker unavailable' }));
      } else process.stdout.write(result);
    });
  });
  request.on('error', () => {
    process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'Probe broker disconnected' }));
  });
  request.end(body);
});
