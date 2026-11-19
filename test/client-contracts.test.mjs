import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, normalizeRun, requestKey, parseJsonLenient, modelId, ValidationError } from '../lib/contracts.mjs';

const config = loadConfig({ AGYCLI_MCP_STATE_DIR: join(tmpdir(), 'agycli-contracts-test') });
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agycli-contracts-')));

test('normalizeRun applies defaults', () => {
  const r = normalizeRun({ prompt: 'hello', cwd: dir }, config);
  assert.equal(r.mode, 'ask');
  assert.equal(r.cwd, dir);
  assert.deepEqual([...r.dirs], []);
  assert.equal(r.timeout_ms, config.default_timeout_ms);
  assert.ok(Object.isFrozen(r));
});

test('normalizeRun rejects unknown fields, bad modes and relative paths', () => {
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: dir, nope: 1 }, config), ValidationError);
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: dir, mode: 'yolo' }, config), /mode must be/);
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: 'relative/path' }, config), /absolute/);
  assert.throws(() => normalizeRun({ prompt: '   ', cwd: dir }, config), /prompt/);
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: join(dir, 'missing') }, config), /does not exist/);
});

test('plan prompts may not start with a slash', () => {
  assert.throws(() => normalizeRun({ prompt: '  /usage', cwd: dir, mode: 'plan' }, config), /must not start with/);
  assert.doesNotThrow(() => normalizeRun({ prompt: '/usage', cwd: dir, mode: 'ask' }, config));
});

test('timeout, effort, conversation id and idempotency key are validated', () => {
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: dir, timeout_ms: 5 }, config), /timeout_ms/);
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: dir, effort: 'turbo' }, config), /effort/);
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: dir, conversation_id: '../../etc' }, config), /conversation_id/);
  assert.throws(() => normalizeRun({ prompt: 'x', cwd: dir, idempotency_key: '' }, config), /idempotency_key/);
  const r = normalizeRun(
    { prompt: 'x', cwd: dir, timeout_ms: 60_000, effort: 'high', conversation_id: '812f92aa-3ca4-4820-8acb-f2236bb858cf', idempotency_key: 'k1' },
    config,
  );
  assert.equal(r.timeout_ms, 60_000);
  assert.equal(r.effort, 'high');
});

test('model accepts a whole `agy models` row and keeps the id', () => {
  assert.equal(modelId('gemini-4-neon-high\tGemini 4 Neon (High)'), 'gemini-4-neon-high');
  const r = normalizeRun({ prompt: 'x', cwd: dir, model: 'gemini-4-neon-high\tGemini 4 Neon (High)' }, config);
  assert.equal(r.model, 'gemini-4-neon-high');
});

test('dirs are canonicalised, de-duplicated and exclude cwd', () => {
  const extra = realpathSync(mkdtempSync(join(tmpdir(), 'agycli-extra-')));
  const r = normalizeRun({ prompt: 'x', cwd: dir, dirs: [extra, extra, dir] }, config);
  assert.deepEqual([...r.dirs], [extra]);
});

test('long prompts are refused on Windows only', () => {
  const prompt = 'x'.repeat(31_000);
  assert.throws(() => normalizeRun({ prompt, cwd: dir }, config, { platform: 'win32' }), /Windows/);
  assert.doesNotThrow(() => normalizeRun({ prompt, cwd: dir }, config, { platform: 'darwin' }));
});

test('requestKey ignores idempotency_key and key order', () => {
  const a = normalizeRun({ prompt: 'x', cwd: dir, idempotency_key: 'a' }, config);
  const b = normalizeRun({ cwd: dir, prompt: 'x', idempotency_key: 'b' }, config);
  assert.equal(requestKey(a), requestKey(b));
});

test('parseJsonLenient repairs raw control characters inside strings only', () => {
  assert.deepEqual(parseJsonLenient('{"a":"x\ny\tz\u0001"}'), { a: 'x\ny\tz\u0001' });
  assert.throws(() => parseJsonLenient('{"a": nope}'));
});
