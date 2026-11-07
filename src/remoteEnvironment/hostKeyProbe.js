import ssh2 from 'ssh2';
import { sshHostFingerprint } from './sshConnectionManager.js';

const {Client, utils} = ssh2;
function fail() { return Object.assign(new Error('Unable to read the SSH host key'), {code:'REMOTE_ENV_PROBE_FAILED'}); }

// Discovery is not trust. The caller must show this fingerprint to the user,
// who verifies it through an independent channel before saving the target.
// No SSH credential is sent by this probe.
export async function probeSshHostKey({host, port = 22}, {clientFactory = () => new Client(), timeoutMs = 20_000} = {}) {
  if (typeof host !== 'string' || !host.trim() || host.length > 253 || /[\0\r\n]/.test(host)
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('Invalid SSH host or port'), {code:'REMOTE_ENV_INVALID'});
  }
  const client = clientFactory();
  return new Promise((resolve, reject) => {
    let settled = false;
    let discovered = null;
    const timer = setTimeout(() => finish(fail()), timeoutMs);
    timer.unref?.();
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { client.end(); } catch {}
      if (error) reject(error); else resolve(result);
    };
    client.on('error', () => discovered ? finish(null, discovered) : finish(fail()));
    client.on('close', () => discovered ? finish(null, discovered) : finish(fail()));
    try {
      client.connect({host:host.trim(), port, username:'originrouter-host-key-probe', readyTimeout:timeoutMs,
        hostVerifier: (blob) => {
          let algorithm = 'unknown';
          try { algorithm = utils.parseKey(blob)?.type || algorithm; } catch {}
          discovered = {fingerprint:sshHostFingerprint(blob), algorithm};
          return false;
        },
      });
    } catch { finish(fail()); }
  });
}
