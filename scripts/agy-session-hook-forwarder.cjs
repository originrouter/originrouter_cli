// The named global Hook is inert unless this process belongs to an
// OriginRouter-owned agy launch. No credentials or transcript are read here.
const http = require('node:http');
const endpoint = process.env.ORIGINROUTER_AGY_HOOK_URL;
const token = process.env.ORIGINROUTER_AGY_HOOK_TOKEN;
const active = Boolean(endpoint && token);
let url;
try {
  if (active) {
    url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('invalid local endpoint');
  }
} catch { process.stdout.write('{"decision":"deny","reason":"OriginRouter Hook endpoint is invalid"}'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { input += data; if (input.length > 1024 * 1024) process.exit(1); });
process.stdin.on('end', () => {
  if (!active) {
    let payload;
    try { payload = JSON.parse(input); } catch { payload = {}; }
    process.stdout.write(payload.hookEventName === 'PreToolUse' ? '{"decision":"allow"}' : '{}');
    return;
  }
  const request = http.request(url, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'content-length': Buffer.byteLength(input),
  } }, response => {
    let result = '';
    response.on('data', chunk => { result += chunk; });
    response.on('end', () => process.stdout.write(response.statusCode === 200 ? result : '{"decision":"deny","reason":"OriginRouter control unavailable"}'));
  });
  request.on('error', () => process.stdout.write('{"decision":"deny","reason":"OriginRouter control disconnected"}'));
  request.setTimeout(290000, () => request.destroy());
  request.end(input);
});
