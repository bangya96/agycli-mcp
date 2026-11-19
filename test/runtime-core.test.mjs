import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildArgs, runAgy, probeAgy } from '../lib/agy.mjs';
import { resolveLaunch, resolveAppDataDir, isAlive, atomicWriteJson, readJson } from '../lib/platform.mjs';
import { snapshot, compare } from '../lib/change-detection.mjs';
import { createJobStore, lockNames } from '../lib/jobs.mjs';
import { loadConfig, PLAN_PREAMBLE, ASK_PREAMBLE, PLAN_CONTINUE_PROMPT } from '../lib/contracts.mjs';

const launch = { file: process.execPath, argsPrefix: [fileURLToPath(new URL('../fixtures/fake-agy.mjs', import.meta.url))], source: 'env' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'agy-runtime-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app_data_dir = join(dir, 'app');
  const request = { prompt: 'Do a thing', mode: 'ask', cwd: dir, dirs: [], timeout_ms: 5000 };
  const options = { launch, app_data_dir, max_output_chars: 10000, env: { ...process.env, FAKE_AGY_APP_DATA: app_data_dir, FAKE_AGY_SCENARIO: 'ok' } };
  return { dir, request, options };
}

test('buildArgs exact mode and continuation flags', () => {
  for (const mode of ['ask', 'edit', 'plan']) {
    const req = { prompt: 'hello', mode, cwd: '/workspace', dirs: ['/extra'], model: 'model', effort: 'high', conversation_id: 'abcdefgh' };
    const preamble = mode === 'ask' ? ASK_PREAMBLE : PLAN_PREAMBLE;
    const flags = mode === 'plan' ? ['--mode', 'plan'] : mode === 'ask' ? ['--disable-slash-commands'] : ['--dangerously-skip-permissions', '--disable-slash-commands'];
    assert.deepEqual(buildArgs(req, { timeout_s: 42 }), ['-p', mode === 'edit' ? 'hello' : `${preamble}\n\nhello`, '--output-format', 'stream-json', '--print-timeout', '42s', ...flags, '--add-dir', '/workspace', '--add-dir', '/extra', '--model', 'model', '--effort', 'high', '--conversation', 'abcdefgh']);
    if (mode === 'plan') {
      const args = buildArgs(req, { phase: 'plan_continue', timeout_s: 42 });
      assert.equal(args[1], PLAN_CONTINUE_PROMPT); assert.equal(args[args.indexOf('--mode') + 1], 'plan'); assert.ok(!args.includes('--disable-slash-commands'));
    }
  }
  assert.throws(() => buildArgs({ mode: 'plan' }, { phase: 'plan_continue' }), /conversation_id/);
});

for (const [scenario, reason] of [['ok'], ['quota', 'quota_exhausted'], ['auth', 'auth_required'], ['error', 'agy_error'], ['malformed'], ['no_result'], ['background_abort', 'background_aborted'], ['print_timeout', 'timeout']]) {
  test(`runAgy ${scenario}`, async (t) => {
    const { request, options } = await fixture(t); options.env.FAKE_AGY_SCENARIO = scenario;
    const result = await runAgy(request, options);
    assert.equal(result.failure_reason, reason);
    assert.ok(result.conversation_id);
    if (scenario === 'ok') { assert.equal(result.text, 'OK from fake agy ✓ é\n'); assert.equal(result.partial, false); assert.equal(result.usage.total_tokens, 115); }
    if (scenario === 'no_result') { assert.equal(result.text, 'OK from fake agy ✓ é'); assert.equal(result.partial, true); assert.match(result.error, /without a result/); }
    if (scenario === 'quota') { assert.equal(result.retryable, true); assert.equal(result.error_id, 'fake-quota'); assert.ok(!result.error.includes('short_error')); }
    if (scenario === 'malformed') { assert.ok(result.malformed_lines > 0); assert.equal(result.text, 'line1\nline2'); }
    if (reason) assert.equal(result.partial, true);
  });
}

for (const scenario of ['plan', 'plan_denied', 'plan_denied_always']) {
  test(`plan artifact ${scenario}`, async (t) => {
    const { dir, request, options } = await fixture(t); request.mode = 'plan';
    options.env.FAKE_AGY_SCENARIO = scenario; options.env.FAKE_AGY_ARGV_LOG = join(dir, 'argv.jsonl');
    const result = await runAgy(request, options);
    const calls = (await fs.readFile(options.env.FAKE_AGY_ARGV_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, scenario === 'plan' ? 1 : 2);
    for (const call of calls) { assert.equal(call.argv[call.argv.indexOf('--mode') + 1], 'plan'); assert.ok(!call.argv.includes('--disable-slash-commands')); }
    if (scenario === 'plan_denied_always') { assert.equal(result.failure_reason, 'plan_incomplete'); assert.equal(result.plan, null); assert.equal(result.denied_actions.length, 2); }
    else { assert.equal(result.failure_reason, undefined); assert.match(result.plan.content, /Implementation plan/); assert.equal(result.plan.truncated, false); }
    if (scenario === 'plan_denied') { assert.equal(result.usage.total_tokens, 230); assert.equal(calls[1].argv[1], PLAN_CONTINUE_PROMPT); }
  });
}

test('ignored stdin, probes, spawn failure and bounded output', async (t) => {
  const { request, options } = await fixture(t);
  options.env.FAKE_AGY_READ_STDIN = '1'; options.max_output_chars = 5;
  assert.equal((await runAgy(request, options)).text, 'OK fr');
  assert.match((await probeAgy('version', { launch, timeout_ms: 2000 })).stdout, /1\.5\.12/);
  assert.match((await probeAgy('models', { launch, timeout_ms: 2000 })).stdout, /gemini/);
  assert.equal(JSON.parse((await probeAgy('usage', { launch, timeout_ms: 2000 })).stdout).command.name, 'usage');
  assert.equal((await runAgy(request, { ...options, launch: { file: join(request.cwd, 'missing'), argsPrefix: [] } })).failure_reason, 'spawn_failed');
});

test('deadline kills hang and POSIX descendant process group', async (t) => {
  const { dir, request, options } = await fixture(t); request.timeout_ms = 400;
  options.env.FAKE_AGY_SCENARIO = 'hang';
  assert.equal((await runAgy(request, options)).failure_reason, 'timeout');
  if (process.platform === 'win32') return;
  options.env.FAKE_AGY_SCENARIO = 'descendant'; options.env.FAKE_AGY_CHILD_PID_FILE = join(dir, 'child.pid');
  assert.equal((await runAgy(request, options)).failure_reason, 'timeout');
  const pid = Number(await fs.readFile(options.env.FAKE_AGY_CHILD_PID_FILE, 'utf8'));
  for (let i = 0; i < 30 && isAlive(pid); i++) await sleep(100);
  assert.equal(isAlive(pid), false);
});

test('platform paths and atomic JSON', async (t) => {
  const { dir } = await fixture(t);
  assert.deepEqual(await resolveLaunch({ agy_path: launch.argsPrefix[0] }), launch);
  await assert.rejects(resolveLaunch({ agy_path: join(dir, 'missing') }), (e) => e.code === 'agy_not_found' && e.searched.length === 1);
  assert.deepEqual(await resolveAppDataDir({ app_data_dir: dir }), { dir, exists: true, source: 'env' });
  const path = join(dir, 'atomic.json'); await atomicWriteJson(path, { a: 1 }); assert.deepEqual(await readJson(path), { a: 1 });
  assert.equal(await readJson(join(dir, 'absent')), null);
});

test('change detection unavailable outside git', async (t) => {
  const { dir } = await fixture(t); const before = await snapshot([dir]);
  const changes = await compare(before, await snapshot([dir]));
  assert.equal(changes.coverage, 'none'); assert.equal(changes.changes_detected, null); assert.match(changes.limitations.join(' '), /ignored/);
});

test('change detection sees mutate and already-dirty content changes', async (t) => {
  if (spawnSync('git', ['--version'], { windowsHide: true }).status !== 0) return t.skip('git unavailable');
  const { dir, request, options } = await fixture(t);
  assert.equal(spawnSync('git', ['init', dir], { windowsHide: true }).status, 0);
  const before = await snapshot([dir]); options.env.FAKE_AGY_SCENARIO = 'mutate';
  await runAgy(request, options); const after = await snapshot([dir]);
  const changes = await compare(before, after); assert.equal(changes.changes_detected, true); assert.equal(changes.coverage, 'git'); assert.ok(changes.files.includes(join(dir, 'fake-agy-wrote.txt')));
  await fs.writeFile(join(dir, 'fake-agy-wrote.txt'), 'different');
  assert.equal((await compare(after, await snapshot([dir]))).changes_detected, true);
  assert.equal((await compare(after, after)).changes_detected, false);
});

test('store detached execution, restart, locks, idempotency, cancel and gc', async (t) => {
  const { dir, request, options } = await fixture(t);
  const config = { ...loadConfig({}), state_dir: join(dir, 'state'), job_ttl_ms: 10, max_concurrency: 3 };
  const make = (binary = launch) => createJobStore({ config, launch: binary, app_data_dir: options.app_data_dir });
  const oldScenario = process.env.FAKE_AGY_SCENARIO, oldApp = process.env.FAKE_AGY_APP_DATA;
  t.after(() => { if (oldScenario === undefined) delete process.env.FAKE_AGY_SCENARIO; else process.env.FAKE_AGY_SCENARIO = oldScenario; if (oldApp === undefined) delete process.env.FAKE_AGY_APP_DATA; else process.env.FAKE_AGY_APP_DATA = oldApp; });
  process.env.FAKE_AGY_APP_DATA = options.app_data_dir; process.env.FAKE_AGY_SCENARIO = 'ok';
  const store = make(); const started = await store.start(request);
  assert.ok(started.conversation_id);
  const done = await make(null).wait(started.job_id, { wait_ms: 5000 }); assert.equal(done.state, 'done'); assert.match(done.result.text, /✓ é/); assert.equal(done.result.changes.changes_detected, null);
  await store.cancel(done.job_id); assert.equal((await store.status(done.job_id)).state, 'done');
  await store.markCollected(done.job_id); await fs.access(join(config.state_dir, 'jobs', done.job_id, 'collected'));
  process.env.FAKE_AGY_SCENARIO = 'hang';
  const req = { ...request, timeout_ms: 20000, idempotency_key: 'retry' };
  const hanging = await store.start(req);
  t.after(async () => { await store.cancel(hanging.job_id).catch(() => {}); await store.wait(hanging.job_id, { wait_ms: 3000 }).catch(() => {}); });
  assert.equal((await make().start(req)).job_id, hanging.job_id);
  await assert.rejects(store.start({ ...req, prompt: 'changed' }), { code: 'idempotency_conflict' });
  await assert.rejects(store.start(request), { code: 'busy_workspace' });
  assert.equal((await make(null).status(hanging.job_id)).state, 'running');
  const abort = new AbortController(); abort.abort(); assert.equal((await store.wait(hanging.job_id, { wait_ms: 10000, signal: abort.signal })).state, 'running');
  await store.cancel(hanging.job_id); assert.equal((await store.wait(hanging.job_id, { wait_ms: 5000 })).state, 'cancelled');
  assert.equal((await store.list({ limit: 1 })).jobs[0].job_id, hanging.job_id);
  await sleep(100); const gc = await store.gc(); assert.equal(gc.removed, 2);
  assert.equal((await fs.readdir(join(config.state_dir, 'idem'))).length, 0);
  await assert.rejects(make(null).start(request), { code: 'agy_not_found' });
});

test('store interrupted recovery and result.json precedence', async (t) => {
  const { dir, request } = await fixture(t); const config = { ...loadConfig({}), state_dir: join(dir, 'state') };
  const store = createJobStore({ config, launch: null }); const id = 'dead-job'; const jobDir = join(config.state_dir, 'jobs', id); await fs.mkdir(jobDir, { recursive: true });
  const initial = { job_id: id, state: 'running', mode: request.mode, cwd: dir, created_at: Date.now() - 60000, heartbeat_at: Date.now() - 60000, pid: 2147483647 };
  await atomicWriteJson(join(jobDir, 'status.json'), initial);
  const result = await store.status(id); assert.equal(result.state, 'failed'); assert.equal(result.result.failure_reason, 'interrupted');
  await fs.unlink(join(jobDir, 'done'));
  await atomicWriteJson(join(jobDir, 'status.json'), { ...initial, heartbeat_at: Date.now(), pid: process.pid });
  assert.equal((await store.status(id)).state, 'failed');
  await assert.rejects(store.status('../escape'), { code: 'not_found' });
});

test('stale plan is not returned and artifact symlinks cannot escape brain', async (t) => {
  const { dir, request, options } = await fixture(t);
  request.mode = 'plan'; request.conversation_id = 'abcdefgh';
  const brain = join(options.app_data_dir, 'brain'), conversation = join(brain, request.conversation_id);
  await fs.mkdir(conversation, { recursive: true });
  await fs.writeFile(join(conversation, 'implementation_plan.md'), 'old plan');
  options.env.FAKE_AGY_SCENARIO = 'no_result';
  const stale = await runAgy(request, options); assert.equal(stale.plan, null); assert.equal(stale.failure_reason, undefined);
  if (process.platform !== 'win32') {
    const outside = join(dir, 'outside.md'); await fs.writeFile(outside, 'outside');
    await fs.unlink(join(conversation, 'implementation_plan.md'));
    await fs.symlink(outside, join(conversation, 'implementation_plan.md'));
    assert.equal((await runAgy(request, options)).plan, null);
  }
});

test('conversation lock, concurrency admission and stale-lock takeover', async (t) => {
  const { dir, request, options } = await fixture(t);
  const config = { ...loadConfig({}), state_dir: join(dir, 'state'), max_concurrency: 1 };
  const store = createJobStore({ config, launch, app_data_dir: options.app_data_dir });
  const previous = process.env.FAKE_AGY_SCENARIO; process.env.FAKE_AGY_SCENARIO = 'hang';
  const req = { ...request, mode: 'plan', conversation_id: 'abcdefgh', timeout_ms: 15000 };
  const running = await store.start(req);
  t.after(async () => {
    await store.cancel(running.job_id).catch(() => {}); await store.wait(running.job_id, { wait_ms: 4000 }).catch(() => {});
    if (previous === undefined) delete process.env.FAKE_AGY_SCENARIO; else process.env.FAKE_AGY_SCENARIO = previous;
  });
  await assert.rejects(store.start(req), { code: 'busy_conversation' });
  await assert.rejects(store.start({ ...req, conversation_id: 'ijklmnop' }), { code: 'concurrency_limit' });
  await store.cancel(running.job_id); assert.equal((await store.wait(running.job_id, { wait_ms: 5000 })).state, 'cancelled');
  // An orphan lock with a dead owner and old heartbeat is reclaimable.
  await fs.writeFile(join(config.state_dir, 'locks', lockNames(request)[0]), JSON.stringify({ job_id: 'orphan', pid: 2147483647, token: 'old', created_at: Date.now() - 60000 }));
  process.env.FAKE_AGY_SCENARIO = 'ok';
  const next = await store.start(request); assert.equal((await store.wait(next.job_id, { wait_ms: 5000 })).state, 'done');
});
