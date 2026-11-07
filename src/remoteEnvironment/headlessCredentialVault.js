import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

function unavailable() {
  return Object.assign(new Error('Headless SSH credential storage is unavailable or its key is invalid'), {code:'REMOTE_ENV_SECRET_STORE_UNAVAILABLE'});
}
function keyIdentity(key) { return `headless-v1:${createHmac('sha256',key).update('originrouter-ssh-vault-identity-v1').digest('hex')}`; }
function verifyKey(key, expectedIdentity) {
  if (expectedIdentity && keyIdentity(key) !== expectedIdentity) throw unavailable();
}
function checkPrivate(stat, directory = false) {
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw unavailable();
  if ((stat.mode & 0o077) !== 0) throw unavailable();
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw unavailable();
}

/** Explicitly configured server vault. The operator supplies a stable random
 * 32-byte key via a private file (for example a systemd credential). There is
 * no automatic fallback, generated key, or plaintext credential storage. */
export class HeadlessCredentialVault {
  constructor({stateDir, keyFile} = {}) {
    if (process.platform === 'win32' || typeof stateDir !== 'string' || !isAbsolute(stateDir)
      || typeof keyFile !== 'string' || !isAbsolute(keyFile)) throw unavailable();
    this.root = join(stateDir,'remote-environment-secrets');
    this.keyFile = keyFile;
  }
  readKey() {
    let fd;
    try {
      fd = openSync(this.keyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd); checkPrivate(stat);
      if (stat.size !== 32) throw unavailable();
      const key = readFileSync(fd);
      if (key.length !== 32) throw unavailable();
      return key;
    } catch { throw unavailable(); }
    finally { if (fd != null) closeSync(fd); }
  }
  identity() {
    const key = this.readKey();
    try { return keyIdentity(key); }
    finally { key.fill(0); }
  }
  directory() {
    try {
      mkdirSync(this.root,{recursive:true,mode:0o700});
      const stat = lstatSync(this.root); checkPrivate(stat,true);
      return this.root;
    } catch { throw unavailable(); }
  }
  path(ref) {
    if (typeof ref !== 'string' || !ref || ref.length > 512) throw unavailable();
    return join(this.directory(),`${createHash('sha256').update(ref).digest('hex')}.json`);
  }
  async put(ref, value, {expectedIdentity} = {}) {
    const key=this.readKey(); let fd, temporary;
    try {
      verifyKey(key,expectedIdentity);
      const path=this.path(ref), nonce=randomBytes(12);
      const cipher=createCipheriv('aes-256-gcm',key,nonce);
      cipher.setAAD(Buffer.from(ref,'utf8'));
      const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
      const record=JSON.stringify({version:1,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')});
      temporary=join(this.root,`.pending-${randomUUID()}`);
      fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      writeFileSync(fd,record);fsyncSync(fd);closeSync(fd);fd=null;
      // A reference is immutable. Hard-linking is atomic and refuses an
      // existing destination instead of overwriting another ciphertext.
      linkSync(temporary,path);unlinkSync(temporary);temporary=null;
      const directoryFd=openSync(this.root,constants.O_RDONLY);
      try {fsyncSync(directoryFd);} finally {closeSync(directoryFd);}
    } catch { throw unavailable(); }
    finally {
      key.fill(0); if(fd!=null)closeSync(fd);
      if(temporary)try{unlinkSync(temporary);}catch{}
    }
  }
  async get(ref, {expectedIdentity} = {}) {
    const key=this.readKey(); let fd;
    try {
      verifyKey(key,expectedIdentity);
      fd=openSync(this.path(ref),constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=fstatSync(fd);checkPrivate(stat);
      if(stat.size > 300_000)throw unavailable();
      const record=JSON.parse(readFileSync(fd,'utf8'));
      if(record.version!==1 || typeof record.nonce!=='string' || typeof record.tag!=='string' || typeof record.ciphertext!=='string')throw unavailable();
      const nonce=Buffer.from(record.nonce,'base64'), tag=Buffer.from(record.tag,'base64'), ciphertext=Buffer.from(record.ciphertext,'base64');
      if(nonce.length!==12 || tag.length!==16)throw unavailable();
      const decipher=createDecipheriv('aes-256-gcm',key,nonce);
      decipher.setAAD(Buffer.from(ref,'utf8'));decipher.setAuthTag(tag);
      const plaintext=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
      try {
        const value=JSON.parse(plaintext.toString('utf8'));
        if(!value || typeof value!=='object' || Array.isArray(value))throw unavailable();
        return value;
      } finally {plaintext.fill(0);}
    } catch {throw unavailable();}
    finally {key.fill(0);if(fd!=null)closeSync(fd);}
  }
  async remove(ref, {expectedIdentity} = {}) {
    const key=this.readKey();
    try {
      verifyKey(key,expectedIdentity);
      const path=this.path(ref);
      // Reject replacing a vault entry with a symlink or unexpected file.
      let stat;
      try {stat=lstatSync(path);} catch (error) {if(error.code==='ENOENT')return false;throw error;}
      checkPrivate(stat);
      unlinkSync(path);
      const directoryFd=openSync(this.root,constants.O_RDONLY);
      try {fsyncSync(directoryFd);} finally {closeSync(directoryFd);}
      return true;
    } catch {throw unavailable();}
    finally {key.fill(0);}
  }
}
