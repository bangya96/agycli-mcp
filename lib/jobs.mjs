import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { TERMINAL_STATES, requestKey } from './contracts.mjs';
import { atomicWriteJson, readJson, isAlive } from './platform.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => createHash('sha256').update(s).digest('hex');
const terminal = (v) => TERMINAL_STATES.includes(v?.state);
const error = (code, message = code) => Object.assign(new Error(message), { code });
const entries = async (dir) => fs.readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });

// Serialize short disk mutations, including stale-lock takeover, across processes.
// The gate has no job and is only held while the owning caller is alive.
export async function withStateLock(state, fn) {
  const locks = join(state, 'locks'); await fs.mkdir(locks, { recursive: true });
  const gate = join(locks, '.admission');
  const token = randomUUID();
  for (;;) {
    try {
      const handle = await fs.open(gate, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ job_id: null, pid: process.pid, token, created_at: Date.now() })); } finally { await handle.close(); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = await readJson(gate);
      if (owner && !isAlive(owner.pid)) await fs.unlink(gate).catch(() => {});
      else if (!owner) {
        const stat = await fs.stat(gate).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 30000) await fs.unlink(gate).catch(() => {});
      }
      await sleep(20);
    }
  }
  try { return await fn(); } finally { if ((await readJson(gate))?.token === token) await fs.unlink(gate).catch(() => {}); }
}

export function lockNames(request) {
  const names = [];
  if (request.conversation_id) names.push(`conversation-${hash(request.conversation_id)}.json`);
  if (request.mode !== 'plan') names.push(`workspace-${hash(process.platform === 'win32' ? request.cwd.toLowerCase() : request.cwd)}.json`);
  return names;
}

export async function releaseLocks(state, request, job_id, token) {
  await withStateLock(state, async () => {
    for (const name of lockNames(request)) {
      const path = join(state, 'locks', name), lock = await readJson(path);
      if (lock?.job_id === job_id && lock.token === token) await fs.unlink(path).catch(() => {});
    }
  });
}

export function createJobStore({ config, launch, app_data_dir }) {
  const state = resolve(config.state_dir), jobsDir = join(state, 'jobs');
  const jobPath = (id) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw error('not_found');
    return join(jobsDir, id);
  };
  const view = (v) => {
    const { pid, token, heartbeat_at, ...publicView } = v;
    publicView.elapsed_ms = Math.max(0, (v.finished_at ?? Date.now()) - (v.started_at ?? v.created_at));
    return publicView;
  };
  async function status(id) {
    const dir = jobPath(id);
    let current = await readJson(join(dir, 'result.json')) || await readJson(join(dir, 'status.json'));
    if (!current) throw error('not_found', `Job not found: ${id}`);
    if (!terminal(current) && Date.now() - (current.heartbeat_at ?? current.created_at) > 30000 && !isAlive(current.pid)) {
      // A terminal file always wins, including one committed during this read.
      current = await readJson(join(dir, 'result.json')) || {
        ...view(current), state: 'failed', finished_at: Date.now(),
        result: { text: '', partial: true, exit_code: null, denied_actions: [], failure_reason: 'interrupted', error: 'Supervisor disappeared before committing a result.' },
      };
      await atomicWriteJson(join(dir, 'result.json'), current);
      await fs.writeFile(join(dir, 'done'), '');
    }
    return view(current);
  }
  async function stale(lock) {
    if (!lock) return false;
    const dir = jobPath(lock.job_id);
    const current = await readJson(join(dir, 'result.json')) || await readJson(join(dir, 'status.json'));
    return terminal(current) || (Date.now() - (current?.heartbeat_at ?? lock.created_at) > 30000 && !isAlive(current?.pid ?? lock.pid));
  }
  async function start(request) {
    let id;
    await withStateLock(state, async () => {
      await fs.mkdir(jobsDir, { recursive: true }); await fs.mkdir(join(state, 'idem'), { recursive: true });
      const idemPath = request.idempotency_key ? join(state, 'idem', `${hash(request.idempotency_key)}.json`) : null;
      if (idemPath) {
        const previous = await readJson(idemPath);
        if (previous && await readJson(join(jobPath(previous.job_id), 'meta.json'))) {
          if (previous.request_key !== requestKey(request)) throw error('idempotency_conflict');
          id = previous.job_id; return;
        }
      }
      if (!launch) throw error('agy_not_found', 'agy not found; configure AGYCLI_MCP_AGY_PATH.');
      const names = lockNames(request);
      for (const name of names) {
        const path = join(state, 'locks', name), lock = await readJson(path);
        if (lock && await stale(lock)) await fs.unlink(path);
        else if (lock) throw error(name.startsWith('conversation') ? 'busy_conversation' : 'busy_workspace');
      }
      // Admission is approximate: only jobs observable in this state directory count.
      let live = 0;
      for (const existing of await entries(jobsDir)) {
        try { if (!terminal(await status(existing))) live++; } catch (e) { if (e.code !== 'not_found') throw e; }
      }
      if (live >= config.max_concurrency) throw error('concurrency_limit');
      id = randomUUID(); const token = randomUUID(), created_at = Date.now(), dir = jobPath(id);
      await fs.mkdir(dir);
      const meta = { schema_version: 1, job_id: id, created_at, request, runtime: { launch, app_data_dir, max_output_chars: config.max_output_chars } };
      const initial = { job_id: id, state: 'starting', mode: request.mode, cwd: request.cwd, created_at, elapsed_ms: 0, pid: process.pid, token, heartbeat_at: created_at, ...(request.model && { model: request.model }), ...(request.conversation_id && { conversation_id: request.conversation_id }) };
      const acquired = [];
      try {
        await atomicWriteJson(join(dir, 'meta.json'), meta);
        await atomicWriteJson(join(dir, 'status.json'), initial);
        for (const name of names) {
          const path = join(state, 'locks', name);
          await fs.writeFile(path, JSON.stringify({ job_id: id, pid: process.pid, token, created_at }), { flag: 'wx', mode: 0o600 }); acquired.push(path);
        }
        if (idemPath) await atomicWriteJson(idemPath, { job_id: id, request_key: requestKey(request) });
        const child = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), dir], { detached: true, stdio: 'ignore', windowsHide: true });
        await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
        child.unref();
        // Supervisor waits for admission before writing, so this cannot overwrite its init.
        await atomicWriteJson(join(dir, 'status.json'), { ...initial, pid: child.pid });
        for (const path of acquired) await atomicWriteJson(path, { job_id: id, pid: child.pid, token, created_at });
      } catch (e) {
        for (const path of acquired) await fs.unlink(path).catch(() => {});
        const failed = { ...view(initial), state: 'failed', finished_at: Date.now(), result: { text: '', partial: true, exit_code: null, denied_actions: [], failure_reason: 'spawn_failed', error: e.message } };
        await atomicWriteJson(join(dir, 'result.json'), failed); await fs.writeFile(join(dir, 'done'), '');
        throw e;
      }
    });
    const until = Date.now() + (request.conversation_id ? 0 : 2000);
    for (;;) {
      const current = await status(id);
      if (current.conversation_id || terminal(current) || Date.now() >= until) return current;
      await sleep(40);
    }
  }
  async function wait(id, { wait_ms = config.sync_wait_ms, signal } = {}) {
    const until = Date.now() + wait_ms;
    for (;;) {
      const current = await status(id);
      if (terminal(current) || signal?.aborted || Date.now() >= until) return current;
      await new Promise((done) => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); done(); };
        const timer = setTimeout(finish, Math.min(200, Math.max(0, until - Date.now())));
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
    }
  }
  async function cancel(id) {
    const current = await status(id);
    if (!terminal(current)) await fs.writeFile(join(jobPath(id), 'cancel'), '');
    return status(id);
  }
  async function list({ limit = 100 } = {}) {
    const jobs = [];
    for (const id of await entries(jobsDir)) try { jobs.push(await status(id)); } catch (e) { if (e.code !== 'not_found') throw e; }
    jobs.sort((a, b) => b.created_at - a.created_at || b.job_id.localeCompare(a.job_id));
    return { jobs: jobs.slice(0, Math.max(0, limit)) };
  }
  async function markCollected(id) { await status(id); await fs.writeFile(join(jobPath(id), 'collected'), ''); }
  async function gc() {
    return withStateLock(state, async () => {
      let removed = 0; const removedIds = new Set();
      for (const id of await entries(jobsDir)) {
        let current; try { current = await status(id); } catch (e) { if (e.code === 'not_found') continue; throw e; }
        if (terminal(current) && Date.now() - current.finished_at > config.job_ttl_ms) { await fs.rm(jobPath(id), { recursive: true, force: true }); removedIds.add(id); removed++; }
      }
      for (const name of await entries(join(state, 'locks'))) {
        if (name === '.admission') continue;
        const path = join(state, 'locks', name), lock = await readJson(path);
        if (lock && (removedIds.has(lock.job_id) || await stale(lock))) await fs.unlink(path).catch(() => {});
      }
      for (const name of await entries(join(state, 'idem'))) {
        const path = join(state, 'idem', name), idem = await readJson(path);
        if (!idem || !await readJson(join(jobPath(idem.job_id), 'meta.json'))) await fs.unlink(path).catch(() => {});
      }
      return { removed };
    });
  }
  return { start, status, wait, cancel, list, markCollected, gc };
}
