import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hookWait, extractJobId } from '../lib/hook.mjs';

const ENTRY = fileURLToPath(new URL('../agycli-mcp.mjs', import.meta.url));

function makeJob(state, { result, collected = false } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'agycli-hook-'));
  const id = randomUUID();
  const dir = join(stateDir, 'jobs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ schema_version: 1, job_id: id }));
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ job_id: id, state: 'running', mode: 'plan' }));
  if (state) writeFileSync(join(dir, 'result.json'), JSON.stringify({ job_id: id, state, mode: 'plan', result }));
  if (collected) writeFileSync(join(dir, 'collected'), '');
  return { stateDir, id, dir };
}

const payloadFor = (id, extra = {}) => ({
  tool_name: 'mcp__agycli__agy_run',
  tool_response: [{ type: 'text', text: `job_id: ${id}\nstate: running` }],
  ...extra,
});

test('extractJobId finds the id in text and JSON shapes', () => {
  const id = randomUUID();
  assert.equal(extractJobId(payloadFor(id)), id);
  assert.equal(extractJobId({ tool_response: { structuredContent: { job_id: id } } }), id);
  assert.equal(extractJobId({ tool_response: 'nothing here' }), null);
});

test('finished and uncollected job wakes with exit 2', async () => {
  const { stateDir, id } = makeJob('failed', { result: { failure_reason: 'quota_exhausted' } });
  const r = await hookWait(payloadFor(id, { agent_type: 'general-purpose' }), { state_dir: stateDir, grace_ms: 50, poll_ms: 10 });
  assert.equal(r.exit_code, 2);
  assert.match(r.stderr, /finished: failed \(quota_exhausted\)/);
  assert.match(r.stderr, /subagent "general-purpose"/);
  assert.match(r.stderr, new RegExp(id));
});

test('collected job exits silently', async () => {
  const { stateDir, id } = makeJob('done', { collected: true });
  assert.deepEqual(await hookWait(payloadFor(id), { state_dir: stateDir, grace_ms: 50, poll_ms: 10 }), { exit_code: 0, stderr: '' });
});

test('still running at the deadline wakes with a still-running message', async () => {
  const { stateDir, id } = makeJob(null);
  const r = await hookWait(payloadFor(id), { state_dir: stateDir, timeout_ms: 100, poll_ms: 20 });
  assert.equal(r.exit_code, 2);
  assert.match(r.stderr, /still running/);
});

test('abort signal reports an interrupted wait', async () => {
  const { stateDir, id } = makeJob(null);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const r = await hookWait(payloadFor(id), { state_dir: stateDir, timeout_ms: 10_000, poll_ms: 20, signal: controller.signal });
  assert.equal(r.exit_code, 2);
  assert.match(r.stderr, /interrupted/);
});

test('unknown jobs and bad payloads exit 0', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'agycli-hook-'));
  assert.equal((await hookWait(payloadFor(randomUUID()), { state_dir: stateDir })).exit_code, 0);
  assert.equal((await hookWait(null, { state_dir: stateDir })).exit_code, 0);
});

test('hook-wait subcommand end to end', async () => {
  const { stateDir, id } = makeJob('done');
  const child = spawn(process.execPath, [ENTRY, 'hook-wait', '--timeout-ms', '5000'], {
    env: { ...process.env, AGYCLI_MCP_STATE_DIR: stateDir },
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  child.stdin.end(JSON.stringify(payloadFor(id)));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 2);
  assert.match(stderr, /finished: done/);
});
