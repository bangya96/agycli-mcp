import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, formatDoctor, compareVersions } from '../lib/doctor.mjs';
import { loadConfig } from '../lib/contracts.mjs';

const config = loadConfig({ AGYCLI_MCP_STATE_DIR: mkdtempSync(join(tmpdir(), 'agycli-doctor-')) });
const okLaunch = () => ({ file: '/usr/bin/agy', argsPrefix: [], source: 'path' });
const appData = (exists) => () => ({ dir: '/home/x/.gemini/antigravity-cli', exists, source: 'default' });
const probe = (version, modelsOk = true) => async (kind) =>
  kind === 'version'
    ? { exit_code: 0, stdout: `${version}\n`, stderr: '' }
    : modelsOk
      ? { exit_code: 0, stdout: 'Fetching...\ngemini-4-neon-high\tGemini 4 Neon (High)\n', stderr: '' }
      : { exit_code: 1, stdout: 'Please sign in to view available models.\n', stderr: '' };

test('compareVersions', () => {
  assert.equal(compareVersions('1.5.12', '1.5.9'), 1);
  assert.equal(compareVersions('1.5.9', '1.5.12'), -1);
  assert.equal(compareVersions('1.5.12', '1.5.12'), 0);
});

const POSIX_ENV = { PATH: '/usr/bin', HOME: '/home/u' };
const WIN_ENV = { Path: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', APPDATA: 'a', LOCALAPPDATA: 'l', TEMP: 't' };

test('healthy setup passes', async () => {
  const r = await runDoctor({ config, resolveLaunch: okLaunch, resolveAppDataDir: appData(true), probeAgy: probe('1.5.12'), platform: 'darwin', env: POSIX_ENV });
  assert.equal(r.ok, true);
  assert.ok(r.checks.every((c) => c.status === 'ok'), formatDoctor(r));
});

test('old version and missing app-data dir only warn', async () => {
  const r = await runDoctor({ config, resolveLaunch: okLaunch, resolveAppDataDir: appData(false), probeAgy: probe('1.4.0'), platform: 'darwin', env: POSIX_ENV });
  assert.equal(r.ok, true);
  assert.equal(r.checks.find((c) => c.name === 'agy version').status, 'warn');
  assert.equal(r.checks.find((c) => c.name === 'agy app-data dir').status, 'warn');
});

test('missing agy and signed-out agy fail', async () => {
  const missing = () => {
    const e = new Error('agy not found');
    e.code = 'agy_not_found';
    e.searched = ['/a/agy', '/b/agy'];
    throw e;
  };
  const r1 = await runDoctor({ config, resolveLaunch: missing, resolveAppDataDir: appData(true), probeAgy: probe('1.5.12'), platform: 'darwin', env: POSIX_ENV });
  assert.equal(r1.ok, false);
  assert.match(formatDoctor(r1), /\[FAIL\] agy binary: .*\/a\/agy/);
  const r2 = await runDoctor({ config, resolveLaunch: okLaunch, resolveAppDataDir: appData(true), probeAgy: probe('1.5.12', false), platform: 'darwin', env: POSIX_ENV });
  assert.equal(r2.ok, false);
  assert.match(formatDoctor(r2), /sign in/);
});

test('Windows gets an untested-platform warning', async () => {
  const r = await runDoctor({ config, resolveLaunch: okLaunch, resolveAppDataDir: appData(true), probeAgy: probe('1.5.12'), platform: 'win32', env: WIN_ENV });
  assert.equal(r.checks.find((c) => c.name === 'platform').status, 'warn');
});

test('environment check: mixed-case Windows names count, missing ones warn but do not fail', async () => {
  const ok = await runDoctor({ config, resolveLaunch: okLaunch, resolveAppDataDir: appData(true), probeAgy: probe('1.5.12'), platform: 'win32', env: WIN_ENV });
  assert.equal(ok.checks.find((c) => c.name === 'environment').status, 'ok');
  const filtered = { PATH: 'C:\\Windows', HOME: 'C:\\Users\\u' }; // what a filtering client might pass
  const r = await runDoctor({ config, resolveLaunch: okLaunch, resolveAppDataDir: appData(true), probeAgy: probe('1.5.12'), platform: 'win32', env: filtered });
  const check = r.checks.find((c) => c.name === 'environment');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /SystemRoot, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP/);
  assert.equal(r.ok, true);
  const posix = await runDoctor({ config, resolveLaunch: okLaunch, resolveAppDataDir: appData(true), probeAgy: probe('1.5.12'), platform: 'linux', env: { PATH: '/usr/bin' } });
  assert.match(posix.checks.find((c) => c.name === 'environment').detail, /^HOME not set/);
});
