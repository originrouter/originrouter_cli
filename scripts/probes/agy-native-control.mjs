import { readFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const [root, endpoint = 'status', json = '{}'] = process.argv.slice(2);
if (!root) {
  console.error('Usage: node scripts/probes/agy-native-control.mjs PROBE_ROOT [status|mode|command|resolve|shutdown] [JSON]');
  process.exit(2);
}
if (!['status', 'mode', 'command', 'resolve', 'shutdown'].includes(endpoint)) throw new Error('Unknown probe endpoint');
const controller = JSON.parse(readFileSync(path.join(root, 'controller.json'), 'utf8'));
const url = new URL(`/${endpoint}`, controller.url);
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Only a loopback probe controller is supported');
const body = JSON.stringify(JSON.parse(json));
const request = http.request(url, { method: 'POST', headers: {
  authorization: `Bearer ${controller.token}`,
  'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
} }, response => {
  let output = '';
  response.setEncoding('utf8');
  response.on('data', chunk => { output += chunk; });
  response.on('end', () => {
    console.log(JSON.stringify(JSON.parse(output), null, 2));
    if (response.statusCode >= 400) process.exitCode = 1;
  });
});
request.on('error', error => { console.error(error.message); process.exitCode = 1; });
request.setTimeout(10_000, () => request.destroy(new Error('Probe request timed out')));
request.end(body);
