import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { promises as fs } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PLAN_PREAMBLE, ASK_PREAMBLE, PLAN_CONTINUE_PROMPT, isConversationId, parseJsonLenient, WINDOWS_MAX_PROMPT_CHARS } from './contracts.mjs';
import { killTree } from './platform.mjs';

export function buildArgs(request, { phase = 'initial', timeout_s } = {}) {
  if (phase === 'plan_continue' && !request.conversation_id) throw new Error('plan_continue requires conversation_id');
  const prompt = phase === 'plan_continue' ? PLAN_CONTINUE_PROMPT : request.mode === 'plan' ? `${PLAN_PREAMBLE}\n\n${request.prompt}` : request.mode === 'ask' ? `${ASK_PREAMBLE}\n\n${request.prompt}` : request.prompt;
  const args = ['-p', prompt, '--output-format', 'stream-json', '--print-timeout', `${timeout_s}s`];
  if (request.mode === 'plan' || phase === 'plan_continue') args.push('--mode', 'plan');
  else { if (request.mode === 'edit') args.push('--dangerously-skip-permissions'); args.push('--disable-slash-commands'); }
  for (const dir of [request.cwd, ...(request.dirs || [])]) args.push('--add-dir', dir);
  for (const key of ['model', 'effort', 'conversation_id']) if (request[key]) args.push(key === 'conversation_id' ? '--conversation' : `--${key}`, request[key]);
  return args;
}

async function execute(args, { launch, cwd, timeout_ms, signal, env = process.env, on_stdout, on_stderr }) {
  let stdout = '', stderr = '', timed_out = false, spawnError, killing, callbackError;
  if (process.platform === 'win32' && [launch.file, ...(launch.argsPrefix || []), ...args].map((s) => JSON.stringify(s)).join(' ').length > WINDOWS_MAX_PROMPT_CHARS) {
    return { exit_code: null, stdout, stderr, spawnError: new Error('Windows command line exceeds 30000 characters; put long context in a file.') };
  }
  const child = spawn(launch.file, [...(launch.argsPrefix || []), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  const stop = () => { killing ||= killTree(child.pid).catch(() => {}); };
  const timer = setTimeout(() => { timed_out = true; stop(); }, timeout_ms);
  const abort = () => stop();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) stop();
  const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
  const notify = (fn, s) => { try { fn?.(s); } catch (e) { callbackError = e; stop(); } };
  child.stdout.on('data', (b) => { const s = outDecoder.write(b); if (on_stdout) notify(on_stdout, s); else stdout = (stdout + s).slice(-4_000_000); });
  child.stderr.on('data', (b) => { const s = errDecoder.write(b); stderr = (stderr + s).slice(-65536); notify(on_stderr, s); });
  child.once('error', (e) => { spawnError = e; });
  const exit_code = await new Promise((done) => child.once('close', done));
  const tail = outDecoder.end(); if (on_stdout) notify(on_stdout, tail); else stdout += tail;
  stderr = (stderr + errDecoder.end()).slice(-65536);
  clearTimeout(timer); signal?.removeEventListener('abort', abort); await killing;
  if (callbackError) throw callbackError;
  return { exit_code, stdout, stderr, ...(timed_out && { timed_out }), spawnError };
}

async function runOnce(request, options, phase) {
  const cap = options.max_output_chars ?? 200000;
  let pending = '', text = '', terminal, conversation_id = request.conversation_id, malformed_lines = 0;
  const line = (raw) => {
    if (!raw.trim()) return;
    let event;
    try { try { event = JSON.parse(raw); } catch { event = parseJsonLenient(raw); } } catch { malformed_lines++; return; }
    if (!event || typeof event !== 'object') { malformed_lines++; return; }
    const body = event.result || event.step_update || event;
    conversation_id = event.conversation_id || body.conversation_id || conversation_id;
    if (event.event === 'step_update' && body.step_type === 'agent_response' && typeof body.text_delta === 'string') text = (text + body.text_delta).slice(0, cap);
    if (event.event === 'result') terminal = body;
    options.on_event?.(event);
  };
  const execution = await execute(buildArgs(request, { phase, timeout_s: Math.max(5, Math.floor(request.timeout_ms / 1000) - 15) }), {
    ...options, cwd: request.cwd, timeout_ms: request.timeout_ms,
    on_stdout: (chunk) => {
      options.on_stdout?.(chunk);
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (pending.length > Math.max(4_000_000, cap * 4)) { malformed_lines++; pending = ''; }
    },
  });
  line(pending);
  const result = { text: (typeof terminal?.response === 'string' ? terminal.response : text).slice(0, cap), partial: !terminal, exit_code: execution.exit_code, denied_actions: Array.isArray(terminal?.denied_actions) ? terminal.denied_actions : [], malformed_lines };
  if (conversation_id) result.conversation_id = conversation_id;
  for (const key of ['usage', 'num_turns', 'finished_reason']) if (terminal?.[key] !== undefined) result[key] = terminal[key];
  let structured;
  for (const raw of execution.stderr.split(/\r?\n/)) {
    const match = raw.match(/^\s*AGY_ERROR:\s*(.*)$/);
    if (match) try { structured = parseJsonLenient(match[1]); } catch {}
  }
  if (typeof structured?.retryable === 'boolean') result.retryable = structured.retryable;
  if (typeof structured?.error_id === 'string') result.error_id = structured.error_id;
  const diagnostic = `${execution.stderr}\n${terminal?.error || ''}`;
  const safeStderr = execution.stderr.split(/\r?\n/).filter((s) => !s.includes('AGY_ERROR:')).join('\n').trim();
  // Quota and auth wording is only trusted on a failed run: a successful run may mention
  // "quota" in its stderr or answer without having hit any limit.
  const failed = execution.exit_code !== 0 || (terminal && terminal.status !== 'SUCCESS');
  let reason;
  if (execution.spawnError) reason = 'spawn_failed';
  else if (execution.timed_out) reason = 'timeout';
  else if (failed && (structured?.status === 'RESOURCE_EXHAUSTED' || /quota|rate.?limit|exhausted your capacity/i.test(diagnostic))) reason = 'quota_exhausted';
  else if (failed && /authentication required|authentication expired|please sign in/i.test(diagnostic)) reason = 'auth_required';
  else if (/terminating \d+ outstanding background task|background task[^\n]*terminated/i.test(diagnostic)) reason = 'background_aborted';
  else if (terminal?.finished_reason) reason = 'timeout';
  else if (failed) reason = 'agy_error';
  if (reason) { result.failure_reason = reason; result.partial = true; result.error = String(execution.spawnError?.message || terminal?.error || safeStderr || reason).slice(0, cap); }
  else if (!terminal) result.error = 'agy exited without a result event';
  return result;
}

async function artifact(appDir, cid, cap) {
  if (!appDir || !isConversationId(cid)) return null;
  const root = resolve(appDir, 'brain'), path = resolve(root, cid, 'implementation_plan.md');
  const inside = (base, candidate) => { const rel = relative(base, candidate); return rel && !rel.startsWith('..') && !isAbsolute(rel); };
  if (!inside(root, path)) return null;
  try {
    if (!inside(await fs.realpath(root), await fs.realpath(path))) return null;
    const stat = await fs.stat(path); const data = await fs.readFile(path);
    const content = data.toString('utf8');
    return { fingerprint: `${stat.size}:${stat.mtimeMs}:${createHash('sha256').update(data).digest('hex')}`, plan: { path, content: content.slice(0, cap), truncated: content.length > cap } };
  } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; throw e; }
}

export async function runAgy(request, options) {
  const cap = options.max_output_chars ?? 200000;
  const before = request.mode === 'plan' ? await artifact(options.app_data_dir, request.conversation_id, cap) : null;
  const started = Date.now();
  let result = await runOnce(request, options, 'initial');
  if (request.mode !== 'plan') return result;
  let after = await artifact(options.app_data_dir, result.conversation_id, cap);
  const fresh = () => after && after.fingerprint !== before?.fingerprint;
  if (!fresh() && result.denied_actions.length && !result.failure_reason && !options.signal?.aborted && isConversationId(result.conversation_id)) {
    const remaining = request.timeout_ms - (Date.now() - started);
    if (remaining > 0) {
      const next = await runOnce({ ...request, conversation_id: result.conversation_id, timeout_ms: remaining }, options, 'plan_continue');
      const usage = { ...result.usage };
      for (const [key, value] of Object.entries(next.usage || {})) usage[key] = typeof value === 'number' ? (usage[key] || 0) + value : value;
      result = { ...next, usage, denied_actions: [...result.denied_actions, ...next.denied_actions] };
      after = await artifact(options.app_data_dir, result.conversation_id, cap);
    }
  }
  result.plan = fresh() ? after.plan : null;
  if (!result.plan && result.denied_actions.length && !result.failure_reason) { result.failure_reason = 'plan_incomplete'; result.partial = true; result.error = 'No fresh implementation_plan.md after plan continuation.'; }
  return result;
}

export async function probeAgy(kind, { launch, timeout_ms = 15000 }) {
  const args = { version: ['--version'], models: ['models'], usage: ['--output-format', 'json', '-p', '/usage'] }[kind];
  if (!args) throw new Error(`Unknown probe: ${kind}`);
  const { spawnError, ...result } = await execute(args, { launch, timeout_ms });
  if (spawnError) result.stderr = spawnError.message;
  return result;
}
