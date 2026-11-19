import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createQuota, parseUsage, parseModels, levelFor, baseLabel, groupForLabel } from '../lib/quota.mjs';

const FAKE = fileURLToPath(new URL('../fixtures/fake-agy.mjs', import.meta.url));
const ARGS = { version: ['--version'], models: ['models'], usage: ['--output-format', 'json', '-p', '/usage'] };

// Minimal stand-in for lib/agy.mjs probeAgy, so these tests do not depend on it.
function fakeProbe(env = {}) {
  const calls = [];
  const probe = async (kind) => {
    calls.push(kind);
    const r = spawnSync(process.execPath, [FAKE, ...ARGS[kind]], { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true });
    return { exit_code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { probe, calls };
}

test('levelFor thresholds', () => {
  assert.equal(levelFor(0), 'exhausted');
  assert.equal(levelFor(0.04), 'critical');
  assert.equal(levelFor(0.2), 'low');
  assert.equal(levelFor(0.9), 'ok');
  assert.equal(levelFor(undefined), 'unknown');
});

test('parseUsage picks the tightest live bucket per group', async () => {
  const { probe } = fakeProbe();
  const groups = parseUsage((await probe('usage')).stdout);
  const by = Object.fromEntries(groups.map((g) => [g.name, g]));
  assert.equal(by['Gemini Models'].level, 'low');
  assert.equal(by['Gemini Models'].window, '5h');
  assert.equal(by['Gemini Models'].remaining_percent, 20);
  assert.equal(by['Claude and GPT models'].level, 'critical');
  assert.equal(by['Gemini 4 Argon'].level, 'exhausted');
  assert.deepEqual(by['Gemini Models'].models, ['Gemini 4 Neon', 'Gemini 4 Hydrogen', 'Orchestrator (Neon)', 'Gemini 3.8 Flash']);
});

test('expired buckets do not count against the level', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const stdout = JSON.stringify({
    command: { data: { groups: [{ name: 'G', description: 'Models within this group: A', buckets: [{ id: 'x', window: '5h', remaining_fraction: 0, reset_time: past }] }] } },
  });
  const [g] = parseUsage(stdout);
  assert.equal(g.level, 'unknown');
  assert.equal(g.buckets[0].expired, true);
});

test('model labels map to quota groups', async () => {
  const { probe } = fakeProbe();
  const groups = parseUsage((await probe('usage')).stdout);
  assert.equal(baseLabel('Gemini 4 Neon (High)'), 'Gemini 4 Neon');
  assert.equal(baseLabel('Orchestrator (Neon)'), 'Orchestrator (Neon)');
  assert.equal(groupForLabel(groups, 'Gemini 4 Neon (High)'), 'Gemini Models');
  assert.equal(groupForLabel(groups, 'Gemini 3.8 Flash (Low)'), 'Gemini Models');
  assert.equal(groupForLabel(groups, 'Claude Opus 5.5 (High)'), 'Claude and GPT models');
  assert.equal(groupForLabel(groups, 'GPT-OSS 120B (Medium)'), 'Claude and GPT models');
  assert.equal(groupForLabel(groups, 'Gemini 4 Argon (High)'), 'Gemini 4 Argon');
  assert.equal(groupForLabel(groups, 'Something New (High)'), null);
});

test('parseModels skips the progress line', () => {
  const rows = parseModels('Fetching available models...\na-1\tA One (High)\r\nb-2\tB Two\n');
  assert.deepEqual(rows, [{ id: 'a-1', label: 'A One (High)' }, { id: 'b-2', label: 'B Two' }]);
});

test('createQuota caches usage and decorates models', async () => {
  let t = 1_000_000;
  const { probe, calls } = fakeProbe();
  const q = createQuota({ getLaunch: () => ({}), probeAgy: probe, now: () => t });
  const a = await q.getUsage();
  assert.equal(a.cached, false);
  t += 5_000;
  const b = await q.getUsage();
  assert.equal(b.cached, true);
  assert.equal(calls.filter((c) => c === 'usage').length, 1);
  const m = await q.listModels();
  const neon = m.models.find((x) => x.id === 'gemini-4-neon-high');
  assert.equal(neon.quota_group, 'Gemini Models');
});

test('auth failures surface a sign-in hint and are cached briefly', async () => {
  let t = 0;
  const { probe, calls } = fakeProbe({ FAKE_AGY_SCENARIO: 'auth' });
  const q = createQuota({ getLaunch: () => ({}), probeAgy: probe, now: () => t });
  await assert.rejects(q.getUsage(), (err) => err.code === 'auth_required' && /sign in/.test(err.message));
  t += 1_000;
  await assert.rejects(q.getUsage());
  assert.equal(calls.length, 1);
  await assert.rejects(q.listModels(), /sign in/);
});
