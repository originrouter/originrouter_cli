// A stable, environment-gated MCP entry. Bare agy gets an empty tool list.
const { spawn } = require('node:child_process');
const { isAbsolute } = require('node:path');
const readline = require('node:readline');
const session = process.env.ORIGINROUTER_AGY_MCP_SESSION;
const bin = process.env.ORIGINROUTER_AGY_MCP_BIN;
if (/^[a-zA-Z0-9_-]{1,64}$/.test(session || '') && bin && isAbsolute(bin)) {
  const child = spawn(process.execPath, [bin, 'agent-mcp-server', '--originrouter-session', session, '--device-tools'],
    { env: process.env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
  child.stdin.on('error', () => {});
  child.on('error', () => process.exit(1));
  child.on('exit', code => process.exit(code || 0));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.stdin.on('end', () => child.kill('SIGTERM'));
} else {
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    let request; try { request = JSON.parse(line); } catch { return; }
    if (request.id == null) return;
    if (request.method === 'initialize') send({ id: request.id, result: {
      protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'originrouter-inactive', version: '1.0.0' } } });
    else if (request.method === 'tools/list') send({ id: request.id, result: { tools: [] } });
    else if (request.method === 'ping') send({ id: request.id, result: {} });
    else send({ id: request.id, error: { code: -32601, message: 'No OriginRouter session is active' } });
  });
}
