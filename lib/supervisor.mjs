import { promises as fs, existsSync, appendFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, readJson } from './platform.mjs';
import { releaseLocks, withStateLock, lockNames } from './jobs.mjs';
import { runAgy } from './agy.mjs';
import { snapshot, compare } from './change-detection.mjs';

export async function supervise(jobDir) {
  const stateDir = dirname(dirname(jobDir));
  let meta, current, heartbeat, poll, finishing = false, cancelled = false;
  const controller = new AbortController();
  let writes = Promise.resolve();
  const persist = () => {
    const copy = { ...current, heartbeat_at: Date.now(), elapsed_ms: Date.now() - current.started_at };
    writes = writes.then(() => atomicWriteJson(join(jobDir, 'status.json'), copy));
    return writes;
  };
  const stopTimers = () => { clearInterval(heartbeat); clearInterval(poll); };
  async function finish(result) {
    if (finishing) return;
    finishing = true; stopTimers(); await writes.catch(() => {});
    if (await readJson(join(jobDir, 'result.json'))) return;
    const finished_at = Date.now();
    const { pid, token, heartbeat_at, ...view } = current;
    if (cancelled) { delete result.failure_reason; result.partial = true; }
    const final = { ...view, state: cancelled ? 'cancelled' : result.failure_reason ? 'failed' : 'done', finished_at, elapsed_ms: finished_at - current.started_at, result, ...(result.conversation_id && { conversation_id: result.conversation_id }) };
    await atomicWriteJson(join(jobDir, 'result.json'), final);
    await fs.writeFile(join(jobDir, 'done'), '');
  }
  try {
    meta = await readJson(join(jobDir, 'meta.json'));
    if (!meta) throw new Error('Missing meta.json');
    await withStateLock(stateDir, async () => {
      current = await readJson(join(jobDir, 'status.json'));
      current = { ...current, state: 'running', started_at: Date.now(), pid: process.pid };
      for (const name of lockNames(meta.request)) {
        const path = join(stateDir, 'locks', name), lock = await readJson(path);
        if (lock?.job_id !== meta.job_id || lock.token !== current.token) throw new Error('Job lock ownership lost');
      }
      await persist();
    });
    const checkCancel = () => { if (!finishing && existsSync(join(jobDir, 'cancel'))) { cancelled = true; controller.abort(); } };
    heartbeat = setInterval(() => { persist().catch(() => controller.abort()); }, 5000);
    poll = setInterval(checkCancel, 250); checkCancel();
    const dirs = [meta.request.cwd, ...meta.request.dirs];
    const before = meta.request.mode !== 'plan' ? await snapshot(dirs) : null;
    let eventBytes = 0, stderrBytes = 0;
    const boundedAppend = (name, text, kind) => {
      const buffer = Buffer.from(text), used = kind === 'events' ? eventBytes : stderrBytes;
      const part = buffer.subarray(0, Math.max(0, 1024 * 1024 - used));
      if (part.length) appendFileSync(join(jobDir, name), part);
      if (kind === 'events') eventBytes += part.length; else stderrBytes += part.length;
    };
    await fs.writeFile(join(jobDir, 'events.jsonl'), ''); await fs.writeFile(join(jobDir, 'stderr.log'), '');
    const result = await runAgy(meta.request, {
      ...meta.runtime, signal: controller.signal,
      on_stdout: (s) => boundedAppend('events.jsonl', s, 'events'),
      on_stderr: (s) => boundedAppend('stderr.log', s, 'stderr'),
      on_event: (event) => {
        const cid = event.conversation_id || event.step_update?.conversation_id || event.result?.conversation_id;
        if (cid && current.conversation_id !== cid) { current.conversation_id = cid; persist().catch(() => controller.abort()); }
      },
    });
    checkCancel();
    if (before) result.changes = await compare(before, await snapshot(dirs));
    await finish(result);
  } catch (e) {
    controller.abort();
    if (!current && meta) current = { job_id: meta.job_id, mode: meta.request.mode, cwd: meta.request.cwd, created_at: meta.created_at, started_at: Date.now() };
    if (current) { finishing = false; await finish({ text: '', partial: true, exit_code: null, denied_actions: [], failure_reason: 'unknown', error: e.message }).catch(() => {}); }
  } finally {
    stopTimers();
    if (meta && current) await releaseLocks(stateDir, meta.request, meta.job_id, current.token).catch(() => {});
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();
if (isMain) {
  await supervise(resolve(process.argv[2]));
}
