// MCP tool definitions and handlers. The job store, quota and model probes are injected.

import { normalizeRun, TERMINAL_STATES, ValidationError } from './contracts.mjs';

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RUN_PROPERTIES = {
  prompt: {
    type: 'string',
    description: 'The full task. agy has no memory of this conversation: include goals, file paths, constraints and the answer shape you want.',
  },
  mode: {
    type: 'string',
    enum: ['plan', 'ask', 'edit'],
    default: 'ask',
    description:
      'plan: locked read-only study that returns implementation_plan.md (agy --mode plan; file edits and shell are denied). ' +
      'ask: read-only by instruction; reports any file changes observed during the run (not a hard lock). ' +
      'edit: full access to read, write and run commands in cwd. Default ask.',
  },
  model: { type: 'string', description: 'agy model id from agy_models, e.g. gemini-4-neon-high. Omit to use agy\'s default.' },
  effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Reasoning effort. Not every model accepts every value; omit unless needed.' },
  cwd: { type: 'string', description: 'Absolute project directory agy works in. Defaults to the server\'s working directory.' },
  dirs: { type: 'array', items: { type: 'string' }, description: 'Extra absolute directories to add to the agy workspace.' },
  conversation_id: {
    type: 'string',
    description: 'Continue an earlier agy conversation, e.g. a plan job\'s conversation_id with mode edit to implement an approved plan.',
  },
  timeout_ms: { type: 'number', description: 'Hard limit for the job in ms (10 s to 2 h). Default 20 min.' },
  idempotency_key: {
    type: 'string',
    description: 'Retry-safe start: the same key with the same request returns the existing job instead of starting a new one.',
  },
};

const JOB_ID_SCHEMA = { job_id: { type: 'string', description: 'Job id returned by agy_run or agy_run_sync.' } };

const RUN_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function requireJobId(args) {
  const id = args?.job_id;
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) throw new ValidationError('job_id must be a job id returned by agy_run');
  return id.toLowerCase();
}

function seconds(ms) {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '?';
}

function summarizeChanges(changes) {
  if (!changes) return null;
  if (changes.changes_detected === null) return `unknown (${changes.coverage}; ${(changes.limitations || []).join('; ')})`;
  if (!changes.changes_detected) return `none detected (${changes.coverage})`;
  const files = changes.files || [];
  const shown = files.slice(0, 30).join(', ');
  return `${files.length} file(s) changed during the run (${changes.coverage}): ${shown}${files.length > 30 ? ', ...' : ''}`;
}

/** Human-readable text for a JobView; the full object goes in structuredContent. */
export function formatJobView(view) {
  const r = view.result || {};
  const terminal = TERMINAL_STATES.includes(view.state);
  const lines = [`job_id: ${view.job_id}`];
  let state = `state: ${view.state}`;
  if (r.failure_reason) state += ` (${r.failure_reason})`;
  if (r.partial) state += ' [partial]';
  lines.push(state);
  const meta = [`mode: ${view.mode}`];
  if (view.conversation_id || r.conversation_id) meta.push(`conversation_id: ${view.conversation_id || r.conversation_id}`);
  if (view.model) meta.push(`model: ${view.model}`);
  meta.push(`elapsed: ${seconds(view.elapsed_ms)}`);
  lines.push(meta.join(' | '));
  if (r.error) lines.push(`error: ${r.error}`);
  if (r.retryable !== undefined) lines.push(`retryable: ${r.retryable}`);
  if (Array.isArray(r.denied_actions) && r.denied_actions.length) {
    lines.push(`denied_actions: ${r.denied_actions.map((a) => a.display_name || a.action).join(', ')}`);
  }
  const changes = summarizeChanges(r.changes);
  if (changes) lines.push(`changes: ${changes}`);

  if (!terminal) {
    lines.push(`next: the job is ${view.state}. Call agy_wait (blocks up to ~90 s) or agy_status with this job_id.`);
  } else if (view.state === 'done' && view.mode === 'plan' && r.plan) {
    const cid = view.conversation_id || r.conversation_id;
    lines.push(
      `next: show the plan to the user. After they approve, call agy_run with mode "edit", conversation_id "${cid}" ` +
        'and a prompt such as "The plan is approved. Implement it." Do not implement without approval.',
    );
  } else if (r.failure_reason === 'plan_incomplete') {
    lines.push('next: agy stopped before writing a plan. Retry with a narrower prompt, or continue the conversation in plan mode.');
  } else if (r.failure_reason === 'quota_exhausted') {
    lines.push('next: quota exhausted. Check agy_usage for the reset time, or use a model from another quota group.');
  } else if (r.failure_reason === 'auth_required') {
    lines.push('next: a person must run `agy` interactively on this machine to sign in.');
  }

  if (r.text) lines.push('', '--- response ---', r.text.trimEnd());
  if (r.plan) {
    lines.push('', `--- implementation_plan.md (${r.plan.path})${r.plan.truncated ? ' [truncated]' : ''} ---`, String(r.plan.content || '').trimEnd());
  }
  return lines.join('\n');
}

function jobResult(view) {
  return { content: [{ type: 'text', text: formatJobView(view) }], structuredContent: view };
}

function formatUsage(u) {
  const lines = [`quota checked_at: ${u.checked_at}${u.cached ? ` (cached, ${Math.round(u.age_ms / 1000)}s old)` : ''}`];
  for (const g of u.groups) {
    const pct = g.remaining_percent === null ? '?' : `${g.remaining_percent}%`;
    lines.push(`- ${g.name}: ${g.level}, ${pct} left (${g.window || 'n/a'} window${g.reset_time ? `, resets ${g.reset_time}` : ''})`);
    if (g.models.length) lines.push(`  models: ${g.models.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * deps:
 *   config            from loadConfig()
 *   getStore({need_launch}) -> Promise<JobStore>
 *   quota             {getUsage, listModels} from createQuota()
 */
export function createTools({ config, getStore, quota }) {
  const clampWait = (ms) => {
    const n = Number(ms);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, config.sync_wait_ms) : config.sync_wait_ms;
  };
  const collectIfTerminal = async (store, view) => {
    if (TERMINAL_STATES.includes(view.state)) await store.markCollected(view.job_id);
    return view;
  };

  return [
    {
      definition: {
        name: 'agy_run',
        description:
          'Start an Antigravity CLI (agy) job in the background and return its job_id immediately. ' +
          'Use agy_wait or agy_status to collect the result. Choose mode carefully: plan (locked read-only, returns a plan), ask (read-only by instruction), edit (can change files).',
        inputSchema: { type: 'object', properties: RUN_PROPERTIES, required: ['prompt'], additionalProperties: false },
        annotations: { title: 'Start agy job', ...RUN_ANNOTATIONS },
      },
      handler: async (args) => {
        const request = normalizeRun(args, config);
        const view = await (await getStore({ need_launch: true })).start(request);
        return jobResult(view);
      },
    },
    {
      definition: {
        name: 'agy_run_sync',
        description:
          'Start an agy job and wait for it inline (up to wait_ms, capped at about 90 s). Returns the result, or a still-running job_id to pass to agy_wait.',
        inputSchema: {
          type: 'object',
          properties: { ...RUN_PROPERTIES, wait_ms: { type: 'number', description: 'Max inline wait in ms (capped by the server, default about 90 s).' } },
          required: ['prompt'],
          additionalProperties: false,
        },
        annotations: { title: 'Run agy job and wait', ...RUN_ANNOTATIONS },
      },
      handler: async (args, { signal }) => {
        const { wait_ms, ...rest } = args;
        const request = normalizeRun(rest, config);
        const store = await getStore({ need_launch: true });
        let view = await store.start(request);
        if (!TERMINAL_STATES.includes(view.state)) view = await store.wait(view.job_id, { wait_ms: clampWait(wait_ms), signal });
        return jobResult(await collectIfTerminal(store, view));
      },
    },
    {
      definition: {
        name: 'agy_status',
        description: 'Current state of an agy job; includes the result once it has finished.',
        inputSchema: { type: 'object', properties: JOB_ID_SCHEMA, required: ['job_id'], additionalProperties: false },
        annotations: { title: 'agy job status', ...READ_ANNOTATIONS },
      },
      handler: async (args) => {
        const store = await getStore();
        return jobResult(await collectIfTerminal(store, await store.status(requireJobId(args))));
      },
    },
    {
      definition: {
        name: 'agy_wait',
        description: 'Block until an agy job finishes or wait_ms elapses (capped at about 90 s). Call again if it is still running.',
        inputSchema: {
          type: 'object',
          properties: { ...JOB_ID_SCHEMA, wait_ms: { type: 'number', description: 'Max wait in ms (capped by the server).' } },
          required: ['job_id'],
          additionalProperties: false,
        },
        annotations: { title: 'Wait for agy job', ...READ_ANNOTATIONS },
      },
      handler: async (args, { signal }) => {
        const store = await getStore();
        const view = await store.wait(requireJobId(args), { wait_ms: clampWait(args.wait_ms), signal });
        return jobResult(await collectIfTerminal(store, view));
      },
    },
    {
      definition: {
        name: 'agy_cancel',
        description: 'Cancel an agy job (kills its whole process tree). Cancellation is asynchronous; check agy_status afterwards.',
        inputSchema: { type: 'object', properties: JOB_ID_SCHEMA, required: ['job_id'], additionalProperties: false },
        annotations: { title: 'Cancel agy job', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      handler: async (args) => jobResult(await (await getStore()).cancel(requireJobId(args))),
    },
    {
      definition: {
        name: 'agy_jobs',
        description: 'List recent agy jobs (newest first), including ones still running.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'Max jobs to list (default 20).' } },
          additionalProperties: false,
        },
        annotations: { title: 'List agy jobs', ...READ_ANNOTATIONS },
      },
      handler: async (args) => {
        const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit) || 20)));
        const { jobs } = await (await getStore()).list({ limit });
        const text = jobs.length
          ? jobs
              .map((j) => `${j.job_id}  ${j.state.padEnd(9)} ${String(j.mode).padEnd(4)} ${seconds(j.elapsed_ms).padStart(8)}  ${j.cwd || ''}`)
              .join('\n')
          : 'no jobs';
        return { content: [{ type: 'text', text }], structuredContent: { jobs } };
      },
    },
    {
      definition: {
        name: 'agy_usage',
        description: 'Remaining agy quota per group (weekly and 5-hour windows) with a level of ok, low, critical, exhausted or unknown. Spends no model quota.',
        inputSchema: {
          type: 'object',
          properties: { max_age_ms: { type: 'number', description: 'Reuse a cached reading up to this age (min 10 s, default 60 s).' } },
          additionalProperties: false,
        },
        annotations: { title: 'agy quota', ...READ_ANNOTATIONS },
      },
      handler: async (args) => {
        const u = await quota.getUsage({ max_age_ms: args.max_age_ms });
        return { content: [{ type: 'text', text: formatUsage(u) }], structuredContent: u };
      },
    },
    {
      definition: {
        name: 'agy_models',
        description: 'Models available to the signed-in agy account, as ids for the model parameter, with display labels and quota groups.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { title: 'agy models', ...READ_ANNOTATIONS },
      },
      handler: async () => {
        const out = await quota.listModels();
        const text = out.models.map((m) => `${m.id}\t${m.label}${m.quota_group ? `\t[${m.quota_group}]` : ''}`).join('\n');
        return { content: [{ type: 'text', text }], structuredContent: out };
      },
    },
  ];
}
