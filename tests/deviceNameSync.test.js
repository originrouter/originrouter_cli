import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {syncDeviceName} from '../src/daemon/deviceNameSync.js';
import {writeCodingAuth} from '../src/persistence/codingAuth.js';
import {makeOAuthCredential} from './support/oauthCredential.js';
import {readDevice} from '../src/persistence/state.js';

test('sync persists server name exactly and discards a response after account change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-name-sync-'));
  try {
    const credential = makeOAuthCredential({accountScope:'account-a'});
    writeCodingAuth(dir, credential);
    const device = {deviceId:credential.deviceId, displayName:'Original · CLI'};
    writeFileSync(join(dir, 'device.json'), JSON.stringify(device));
    let request;
    const fetchFn = async (url, options) => {
      request = {url, body:JSON.parse(options.body)};
      return {ok:true, json:async () => ({data:{device_id:credential.deviceId, device_name:'My server'}})};
    };
    assert.equal(await syncDeviceName({stateDir:dir,baseUrl:'https://example.test',device,accountScope:'account-a',fetchFn}), 'My server');
    assert.equal(request.body.name, 'Original · CLI');
    assert.equal(device.displayName, 'My server');
    assert.equal(JSON.parse(readFileSync(join(dir,'device.json'),'utf8')).displayName, 'My server');
    const previousHome = process.env.ORIGINROUTER_HOME;
    try {
      process.env.ORIGINROUTER_HOME = dir;
      assert.equal(readDevice().displayName, 'My server');
    } finally {
      if (previousHome == null) delete process.env.ORIGINROUTER_HOME;
      else process.env.ORIGINROUTER_HOME = previousHome;
    }
    const stale = async () => {
      writeCodingAuth(dir, makeOAuthCredential({accountScope:'account-b', sessionId:'or_ses_other'}));
      return {ok:true, json:async () => ({data:{device_id:credential.deviceId, device_name:'Old account name'}})};
    };
    assert.equal(await syncDeviceName({stateDir:dir,baseUrl:'https://example.test',device,accountScope:'account-a',fetchFn:stale}), null);
    assert.equal(device.displayName, 'My server');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('sync stops proposing once a name is synced and tolerates a null name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'or-name-sync-'));
  try {
    const credential = makeOAuthCredential({accountScope:'account-a'});
    writeCodingAuth(dir, credential);
    const device = {deviceId:credential.deviceId, displayName:'Original · CLI',
                    displayNameSynced:true, displayNameAccountScope:'account-a'};
    writeFileSync(join(dir, 'device.json'), JSON.stringify(device));
    let request;
    const fetchFn = async (url, options) => {
      request = {url, body:JSON.parse(options.body)};
      return {ok:true, json:async () => ({data:{device_id:credential.deviceId, device_name:'Server name', devices_digest:'aa'}})};
    };
    // Already synced: the call is a pure read-back and carries no proposal.
    assert.equal(await syncDeviceName({stateDir:dir,baseUrl:'https://example.test',device,accountScope:'account-a',fetchFn}), 'Server name');
    assert.equal('name' in request.body, false);
    assert.equal(device.displayName, 'Server name');
    // Unnamed registry answers null: nothing is persisted, nothing crashes.
    device.displayNameSynced = false;
    const nullName = async (url, options) => {
      request = {url, body:JSON.parse(options.body)};
      return {ok:true, json:async () => ({data:{device_id:credential.deviceId, device_name:null}})};
    };
    assert.equal(await syncDeviceName({stateDir:dir,baseUrl:'https://example.test',device,accountScope:'account-a',fetchFn:nullName}), null);
    assert.equal(request.body.name, 'Server name');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
