// Shared constants, configuration and run-request validation.
// Owned by Claude. Interfaces here are frozen by PLAN.md; change only by agreement.

import { isAbsolute, join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

export const SCHEMA_VERSION = 1;
export const MODES = Object.freeze(['plan', 'ask', 'edit']);
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
export const STATES = Object.freeze(['starting', 'running', 'done', 'failed', 'cancelled']);
export const TERMINAL_STATES = Object.freeze(['done', 'failed', 'cancelled']);
export const FAILURE_REASONS = Object.freeze([
  'quota_exhausted', // agy hit a quota, rate-limit or credits wall
  'timeout', // the job outlived timeout_ms, or agy's own --print-timeout fired
  'spawn_failed', // agy could not be started
  'agy_error', // agy reported an error or exited non-zero
  'auth_required', // agy is not signed in, or the sign-in expired
  'interrupted', // the supervisor vanished without writing a result
  'background_aborted', // agy killed outstanding background shell tasks at the end of the run
  'plan_incomplete', // plan mode produced no fresh implementation_plan.md
  'unknown',
]);

export const MIN_TESTED_AGY_VERSION = '1.5.12';

// Windows CreateProcess limit is 32 767 chars for the whole command line.
export const WINDOWS_MAX_PROMPT_CHARS = 30_000;

export const PLAN_PREAMBLE = [
  'You are in read-only PLANNING mode.',
  'Study the workspace with file read, list and search tools only.',
  'Do not run shell or terminal commands: they are not available in this mode and will be denied.',
  'Do not create, modify or delete project files.',
  'Do all the work yourself in this conversation; do not delegate to subagents.',
  'When you have enough information, write the implementation plan as your implementation_plan.md artifact.',
].join('\n');

export const PLAN_CONTINUE_PROMPT = [
  'Shell and terminal commands are not available in planning mode, so that step was denied.',
  'Continue using only file read, list and search tools, then write the implementation plan as your',
  'implementation_plan.md artifact. Do not modify project files.',
].join('\n');

export const ASK_PREAMBLE = [
  'READ-ONLY request.',
  'Do not create, modify, move or delete any files, and do not run commands that change state',
  '(no installs, builds that write output, git commits, formatting, or file writes).',
  'Reading files and running read-only inspection commands is fine.',
  'Do all the work yourself in this conversation; do not delegate to subagents.',
  'Answer the request below.',
].join('\n');

export const DEFAULTS = Object.freeze({
  timeout_ms: 20 * 60_000,
  min_timeout_ms: 10_000,
  max_timeout_ms: 2 * 60 * 60_000,
  sync_wait_ms: 90_000,
  max_concurrency: 3,
  job_ttl_ms: 24 * 60 * 60_000,
  max_output_chars: 200_000,
});

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'invalid_params';
  }
}

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultStateDir(env = process.env, platform = process.platform) {
  const home = homedir();
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agycli-mcp');
  }
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'agycli-mcp');
}

/**
 * Config fields:
 *   agy_path          explicit agy binary (AGYCLI_MCP_AGY_PATH) or null
 *   app_data_dir      explicit agy app-data dir (AGYCLI_MCP_APP_DATA_DIR) or null = platform default
 *   state_dir         job state directory (AGYCLI_MCP_STATE_DIR)
 *   default_model     model id used when a run names none (AGYCLI_MCP_DEFAULT_MODEL) or null
 *   default_timeout_ms, min_timeout_ms, max_timeout_ms
 *   sync_wait_ms      inline wait cap for agy_run_sync / agy_wait (AGYCLI_MCP_SYNC_WAIT_MS)
 *   max_concurrency   running jobs per state dir (AGYCLI_MCP_MAX_CONCURRENCY)
 *   job_ttl_ms        finished jobs older than this are garbage-collected (AGYCLI_MCP_JOB_TTL_MS)
 *   max_output_chars  cap on returned text (AGYCLI_MCP_MAX_OUTPUT)
 *   debug             AGYCLI_MCP_DEBUG=1 logs to stderr
 */
export function loadConfig(env = process.env) {
  return Object.freeze({
    agy_path: env.AGYCLI_MCP_AGY_PATH || null,
    app_data_dir: env.AGYCLI_MCP_APP_DATA_DIR || null,
    state_dir: env.AGYCLI_MCP_STATE_DIR || defaultStateDir(env),
    default_model: env.AGYCLI_MCP_DEFAULT_MODEL || null,
    default_timeout_ms: num(env.AGYCLI_MCP_TIMEOUT_MS, DEFAULTS.timeout_ms),
    min_timeout_ms: DEFAULTS.min_timeout_ms,
    max_timeout_ms: DEFAULTS.max_timeout_ms,
    sync_wait_ms: num(env.AGYCLI_MCP_SYNC_WAIT_MS, DEFAULTS.sync_wait_ms),
    max_concurrency: Math.floor(num(env.AGYCLI_MCP_MAX_CONCURRENCY, DEFAULTS.max_concurrency)),
    job_ttl_ms: num(env.AGYCLI_MCP_JOB_TTL_MS, DEFAULTS.job_ttl_ms),
    max_output_chars: Math.floor(num(env.AGYCLI_MCP_MAX_OUTPUT, DEFAULTS.max_output_chars)),
    debug: env.AGYCLI_MCP_DEBUG === '1',
  });
}

const RUN_FIELDS = new Set([
  'prompt', 'mode', 'model', 'effort', 'cwd', 'dirs', 'conversation_id', 'timeout_ms', 'idempotency_key',
]);
const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

function canonicalDir(path, label) {
  if (typeof path !== 'string' || !path.trim()) throw new ValidationError(`${label} must be a non-empty string`);
  if (!isAbsolute(path)) throw new ValidationError(`${label} must be an absolute path: ${path}`);
  let real;
  try {
    real = realpathSync.native(path);
  } catch {
    throw new ValidationError(`${label} does not exist: ${path}`);
  }
  if (!statSync(real).isDirectory()) throw new ValidationError(`${label} is not a directory: ${path}`);
  return real;
}

/** `agy models` rows are "id<TAB>label"; accept a whole row or a bare id. */
export function modelId(model) {
  return String(model).split('\t')[0].trim();
}

/**
 * Validate tool input and return a frozen RunRequest.
 * Unknown fields are rejected so typos do not silently change behaviour.
 */
export function normalizeRun(input, config, { platform = process.platform, defaultCwd = process.cwd() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('arguments must be an object');
  for (const key of Object.keys(input)) {
    if (!RUN_FIELDS.has(key)) throw new ValidationError(`unknown field: ${key}`);
  }

  const prompt = input.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) throw new ValidationError('prompt must be a non-empty string');

  const mode = input.mode ?? 'ask';
  if (!MODES.includes(mode)) throw new ValidationError(`mode must be one of: ${MODES.join(', ')}`);
  if (mode === 'plan' && prompt.trimStart().startsWith('/')) {
    throw new ValidationError('plan prompts must not start with "/" (plan mode cannot disable slash-command expansion)');
  }
  if (platform === 'win32' && prompt.length > WINDOWS_MAX_PROMPT_CHARS) {
    throw new ValidationError(`prompt is ${prompt.length} chars; Windows command lines allow about ${WINDOWS_MAX_PROMPT_CHARS}. Put long context in a file and reference its path.`);
  }

  const cwd = canonicalDir(input.cwd ?? defaultCwd, 'cwd');

  let dirs = [];
  if (input.dirs !== undefined) {
    if (!Array.isArray(input.dirs)) throw new ValidationError('dirs must be an array of absolute paths');
    dirs = [...new Set(input.dirs.map((d, i) => canonicalDir(d, `dirs[${i}]`)))].filter((d) => d !== cwd);
  }

  let timeout_ms = config.default_timeout_ms;
  if (input.timeout_ms !== undefined) {
    timeout_ms = Number(input.timeout_ms);
    if (!Number.isFinite(timeout_ms)) throw new ValidationError('timeout_ms must be a number');
    if (timeout_ms < config.min_timeout_ms || timeout_ms > config.max_timeout_ms) {
      throw new ValidationError(`timeout_ms must be between ${config.min_timeout_ms} and ${config.max_timeout_ms}`);
    }
    timeout_ms = Math.floor(timeout_ms);
  }

  const request = { prompt, mode, cwd, dirs, timeout_ms };

  const model = input.model ?? config.default_model;
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || !modelId(model)) throw new ValidationError('model must be a non-empty string');
    request.model = modelId(model);
  }
  if (input.effort !== undefined) {
    if (!EFFORTS.includes(input.effort)) throw new ValidationError(`effort must be one of: ${EFFORTS.join(', ')}`);
    request.effort = input.effort;
  }
  if (input.conversation_id !== undefined) {
    if (typeof input.conversation_id !== 'string' || !CONVERSATION_ID_RE.test(input.conversation_id)) {
      throw new ValidationError('conversation_id has an invalid format');
    }
    request.conversation_id = input.conversation_id;
  }
  if (input.idempotency_key !== undefined) {
    const k = input.idempotency_key;
    if (typeof k !== 'string' || !k.trim() || k.length > 200) throw new ValidationError('idempotency_key must be a 1-200 char string');
    request.idempotency_key = k;
  }

  return Object.freeze({ ...request, dirs: Object.freeze(dirs) });
}

/** Stable identity of a request for idempotency comparison (excludes idempotency_key). */
export function requestKey(request) {
  const { idempotency_key, ...rest } = request;
  const sorted = {};
  for (const key of Object.keys(rest).sort()) sorted[key] = rest[key];
  return JSON.stringify(sorted);
}

export function isConversationId(value) {
  return typeof value === 'string' && CONVERSATION_ID_RE.test(value);
}

/**
 * JSON.parse that tolerates raw control characters inside strings (agy emits them in
 * --output-format json). Only control characters inside string literals are escaped;
 * anything else that is invalid still throws.
 */
export function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the repairing parse
  }
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += code === 10 ? '\\n' : code === 13 ? '\\r' : code === 9 ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}
