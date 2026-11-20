// End to end: the real entry point, real job store and supervisor, fake agy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../agycli-mcp.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('../fixtures/fake-agy.mjs', import.meta.url));

// Roughly what a filtering MCP client passes a stdio server. POSIX: Hermes Agent's documented
// baseline. Windows (undocumented for Hermes): the MCP Python SDK's default inherited set.
const POSIX_BASELINE = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR'];
const WINDOWS_BASELINE = ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE'];

function filteredEnv() {
  const win = process.platform === 'win32';
  const keep = new Set(win ? WINDOWS_BASELINE : POSIX_BASELINE);
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => (win ? keep.has(k.toUpperCase()) : keep.has(k) || k.startsWith('XDG_'))),
  );
}

function startServer(extraEnv = {}, { baseEnv = process.env, stateDir: reuseState, appData: reuseApp, cwd: reuseCwd } = {}) {
  const stateDir = reuseState || mkdtempSync(join(tmpdir(), 'agycli-e2e-state-'));
  const appData = reuseApp || mkdtempSync(join(tmpdir(), 'agycli-e2e-app-'));
  const cwd = reuseCwd || realpathSync(mkdtempSync(join(tmpdir(), 'agycli-e2e-cwd-')));
  const env = {
    ...baseEnv,
    AGYCLI_MCP_AGY_PATH: FAKE,
    AGYCLI_MCP_STATE_DIR: stateDir,
    AGYCLI_MCP_APP_DATA_DIR: appData,
    FAKE_AGY_APP_DATA: appData,
    ...extraEnv,
  };
  const child = spawn(process.execPath, [ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let buf = '';
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const msg = JSON.parse(line); // any non-JSON on stdout fails the test
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${stderr}`)), 60_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = async (name, args) => {
    const msg = await request('tools/call', { name, arguments: args });
    assert.ok(msg.result, `no result for ${name}: ${JSON.stringify(msg)}`);
    return msg.result;
  };
  const close = () =>
    new Promise((resolve) => {
      child.on('close', resolve);
      child.stdin.end();
    });
  return { request, call, close, stateDir, appData, cwd };
}

test('initialize and list tools', async () => {
  const s = startServer();
  try {
    const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'agycli-mcp');
    const list = await s.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['agy_cancel', 'agy_jobs', 'agy_models', 'agy_run', 'agy_run_sync', 'agy_status', 'agy_usage', 'agy_wait']);
  } finally {
    await s.close();
  }
});

test('ask job runs to completion and is marked collected', async () => {
  const s = startServer();
  try {
    const r = await s.call('agy_run_sync', { prompt: 'say hi', mode: 'ask', cwd: s.cwd, wait_ms: 30_000 });
    assert.equal(r.isError, undefined, r.content[0].text);
    const view = r.structuredContent;
    assert.equal(view.state, 'done', r.content[0].text);
    assert.match(view.result.text, /OK from fake agy ✓ é/);
    assert.match(r.content[0].text, /--- response ---/);
    assert.ok(existsSync(join(s.stateDir, 'jobs', view.job_id, 'collected')));
    const status = await s.call('agy_status', { job_id: view.job_id });
    assert.equal(status.structuredContent.state, 'done');
    const jobs = await s.call('agy_jobs', {});
    assert.ok(jobs.structuredContent.jobs.some((j) => j.job_id === view.job_id));
  } finally {
    await s.close();
  }
});

test('plan job recovers from a denied shell step and returns the plan', async () => {
  const s = startServer({ FAKE_AGY_SCENARIO: 'plan_denied' });
  try {
    const r = await s.call('agy_run_sync', { prompt: 'plan a README', mode: 'plan', cwd: s.cwd, wait_ms: 30_000 });
    const view = r.structuredContent;
    assert.equal(view.state, 'done', r.content[0].text);
    assert.match(view.result.plan.content, /Implementation plan/);
    assert.match(r.content[0].text, /--- implementation_plan\.md/);
    assert.match(r.content[0].text, /mode "edit"/);
    assert.match(view.next_step, /mode "edit"/);
  } finally {
    await s.close();
  }
});

test('background job can be waited on and cancelled', async () => {
  const s = startServer({ FAKE_AGY_SCENARIO: 'hang' });
  try {
    const started = await s.call('agy_run', { prompt: 'hang', mode: 'edit', cwd: s.cwd });
    const id = started.structuredContent.job_id;
    assert.ok(['starting', 'running'].includes(started.structuredContent.state));
    assert.match(started.structuredContent.next_step, /agy_wait/);
    const busy = await s.call('agy_run', { prompt: 'second', mode: 'ask', cwd: s.cwd });
    assert.equal(busy.isError, true);
    assert.match(busy.content[0].text, /busy_workspace/);
    await s.call('agy_cancel', { job_id: id });
    let state;
    for (let i = 0; i < 50; i++) {
      state = (await s.call('agy_wait', { job_id: id, wait_ms: 500 })).structuredContent.state;
      if (state === 'cancelled') break;
    }
    assert.equal(state, 'cancelled');
  } finally {
    await s.close();
  }
});

test('usage and models', async () => {
  const s = startServer();
  try {
    const u = await s.call('agy_usage', {});
    assert.ok(u.structuredContent.groups.some((g) => g.name === 'Gemini Models' && g.level === 'low'), u.content[0].text);
    const m = await s.call('agy_models', {});
    assert.ok(m.structuredContent.models.some((x) => x.id === 'gemini-4-neon-high' && x.quota_group === 'Gemini Models'));
  } finally {
    await s.close();
  }
});

test('validation errors come back in-band', async () => {
  const s = startServer();
  try {
    const r = await s.call('agy_run', { prompt: '/x', mode: 'plan', cwd: s.cwd });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /invalid_params/);
  } finally {
    await s.close();
  }
});

// A client that reads only the text content (never structuredContent), with a filtered
// environment, that reconnects mid-job: roughly how Hermes Agent drives the server.
test('text-only client with a filtered environment: plan, poll, reconnect, continue', async () => {
  const text = (r) => r.content.map((c) => c.text).join('\n');
  let s = startServer({ FAKE_AGY_SCENARIO: 'plan_denied' }, { baseEnv: filteredEnv() });
  const { stateDir, appData, cwd } = s;
  let id;
  try {
    const started = text(await s.call('agy_run', { prompt: 'plan a README', mode: 'plan', cwd }));
    id = (started.match(/^job_id: ([0-9a-f-]{36})$/m) || [])[1];
    assert.ok(id, started);
    assert.match(started, /^next: .*agy_wait/m);
    assert.match(started, new RegExp(`^cwd: ${cwd.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`, 'm'));
  } finally {
    await s.close();
  }

  // Reconnect: a new server process on the same state dir finds and finishes the job.
  s = startServer({ FAKE_AGY_SCENARIO: 'plan_denied' }, { baseEnv: filteredEnv(), stateDir, appData, cwd });
  try {
    let done;
    for (let i = 0; i < 60 && !done; i++) {
      const t = text(await s.call('agy_wait', { job_id: id, wait_ms: 1000 }));
      if (/^state: done/m.test(t)) done = t;
      else assert.match(t, /^state: (starting|running)/m, t);
    }
    assert.ok(done, 'plan job did not finish');
    const cid = (done.match(/conversation_id: (\S+)/) || [])[1];
    assert.ok(cid, done);
    // The plan path and the next step come before the long body.
    const planLine = done.search(/^plan: .*implementation_plan\.md/m);
    const body = done.indexOf('--- ');
    assert.ok(planLine > 0 && planLine < body, done);
    assert.ok(done.search(/^next: .*mode "edit".*conversation_id/m) < body, done);

    const edit = text(await s.call('agy_run_sync', { prompt: 'The plan is approved. Implement it.', mode: 'edit', cwd, conversation_id: cid, wait_ms: 30_000 }));
    assert.match(edit, /^state: done/m, edit);
    assert.match(edit, new RegExp(`conversation_id: ${cid}`));
    assert.match(edit, /^changes: /m);
  } finally {
    await s.close();
  }
});

test('error results carry readable text', async () => {
  const s = startServer({}, { baseEnv: filteredEnv() });
  try {
    const r = await s.call('agy_status', { job_id: 'not-a-job' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /job_id/);
  } finally {
    await s.close();
  }
});
