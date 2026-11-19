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

test('healthy setup passes', async () => {
  const r = await runDoctor({ config, resolveLaunch: okLaunch, resolveAppDataDir: appData(true), probeAgy: probe('1.5.12'), platform: 'darwin' });
  assert.equal(r.ok, true);
  assert.ok(r.checks.every((c) => c.status === 'ok'), formatDoctor(r));
});

test('old version and missing app-data dir only warn', async () => {
  const r = await runDoctor({ config, resolveLaunch: okLaunch, resolveAppDataDir: appData(false), probeAgy: probe('1.4.0'), platform: 'darwin' });
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
  const r1 = await runDoctor({ config, resolveLaunch: missing, resolveAppDataDir: appData(true), probeAgy: probe('1.5.12'), platform: 'darwin' });
  assert.equal(r1.ok, false);
  assert.match(formatDoctor(r1), /\[FAIL\] agy binary: .*\/a\/agy/);
  const r2 = await runDoctor({ config, resolveLaunch: okLaunch, resolveAppDataDir: appData(true), probeAgy: probe('1.5.12', false), platform: 'darwin' });
  assert.equal(r2.ok, false);
  assert.match(formatDoctor(r2), /sign in/);
});

test('Windows gets an untested-platform warning', async () => {
  const r = await runDoctor({ config, resolveLaunch: okLaunch, resolveAppDataDir: appData(true), probeAgy: probe('1.5.12'), platform: 'win32' });
  assert.equal(r.checks.find((c) => c.name === 'platform').status, 'warn');
});
