#!/usr/bin/env node
// Fake `agy` for tests. Mimics the flags and output shapes measured against agy 1.5.12,
// so tests run anywhere without a Google account.
//
// Launch it as {file: process.execPath, argsPrefix: [<path to this file>]}.
//
// Env:
//   FAKE_AGY_SCENARIO     ok (default) | slow | hang | descendant | quota | auth | error |
//                         plan | plan_denied | plan_denied_always | mutate | malformed |
//                         no_result | background_abort | print_timeout
//   FAKE_AGY_RESPONSE     response text (default "OK from fake agy ✓ é")
//   FAKE_AGY_DELAY_MS     delay between events for "slow" (default 1500)
//   FAKE_AGY_APP_DATA     app-data dir where plan artifacts are written (brain/<cid>/implementation_plan.md)
//   FAKE_AGY_MUTATE_FILE  file written (relative to cwd) by "mutate" (default fake-agy-wrote.txt)
//   FAKE_AGY_CHILD_PID_FILE  where "descendant" writes its child's pid
//   FAKE_AGY_ARGV_LOG     append one JSON line per invocation: {argv, cwd}
//   FAKE_AGY_READ_STDIN=1 read stdin to EOF before doing anything (like real agy -p);
//                         hangs if the caller leaves stdin as an open pipe
//   FAKE_AGY_VERSION      printed by --version (default 1.5.12)
//   FAKE_AGY_USAGE_FILE   JSON file returned by `-p /usage` instead of the built-in sample

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const env = process.env;
const argv = process.argv.slice(2);
const scenario = env.FAKE_AGY_SCENARIO || 'ok';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (env.FAKE_AGY_ARGV_LOG) {
  appendFileSync(env.FAKE_AGY_ARGV_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\n');
}

function flag(name) {
  return argv.includes(name);
}
function value(...names) {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  }
  return undefined;
}

async function readStdinToEof() {
  for await (const _ of process.stdin) { /* drain */ }
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const MODELS = [
  ['gemini-4-neon-high', 'Gemini 4 Neon (High)'],
  ['gemini-4-neon-medium', 'Gemini 4 Neon (Medium)'],
  ['gemini-4-argon-high', 'Gemini 4 Argon (High)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['claude-opus-5-5-high', 'Claude Opus 5.5 (High)'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
];

function usageSample() {
  if (env.FAKE_AGY_USAGE_FILE) return JSON.parse(readFileSync(env.FAKE_AGY_USAGE_FILE, 'utf8'));
  const soon = new Date(Date.now() + 3 * 3600_000).toISOString();
  const week = new Date(Date.now() + 6 * 86400_000).toISOString();
  return {
    conversation_id: '', status: 'SUCCESS', response: 'Gemini Models\tWeekly Limit Remaining\t99%\n',
    duration_seconds: 0, num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    command: {
      name: 'usage',
      data: {
        description: 'Within each group, models share a weekly limit and a 5-hour limit.',
        groups: [
          { name: 'Gemini Models', description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon), Gemini 3.8 Flash',
            buckets: [
              { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.99, reset_time: week },
              { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.2, reset_time: soon },
            ] },
          { name: 'Claude and GPT models', description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
            buckets: [
              { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: week },
              { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.03, reset_time: soon },
            ] },
          { name: 'Gemini 4 Argon', description: 'For paid Pro plans, Argon quota is separate.',
            buckets: [
              { id: 'gemini-argon-wtu-weekly', name: 'Gemini 4 Argon Weekly Limit', window: 'weekly', remaining_fraction: 0, reset_time: week },
            ] },
        ],
      },
    },
  };
}

function writePlan(cid, body) {
  const dir = join(env.FAKE_AGY_APP_DATA || join(process.cwd(), '.fake-app-data'), 'brain', cid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'implementation_plan.md'), body);
}

async function streamText(cid, text, { slow = false } = {}) {
  // Split the UTF-8 bytes of a delta across writes so multi-byte characters straddle chunks.
  const delta = JSON.stringify({ event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: text } }) + '\n';
  const bytes = Buffer.from(delta, 'utf8');
  const cut = Math.max(1, bytes.indexOf(Buffer.from('✓', 'utf8')) + 1 || Math.floor(bytes.length / 2));
  process.stdout.write(bytes.subarray(0, cut));
  await sleep(slow ? Number(env.FAKE_AGY_DELAY_MS || 1500) : 20);
  process.stdout.write(bytes.subarray(cut));
}

function result(cid, fields) {
  out({ event: 'result', result: {
    conversation_id: cid, status: 'SUCCESS', response: '', duration_seconds: 0.5, num_turns: 1,
    usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 115 },
    ...fields,
  } });
}

async function main() {
  if (env.FAKE_AGY_READ_STDIN === '1') await readStdinToEof();

  if (flag('--version') || argv[0] === 'version') {
    process.stdout.write(`${env.FAKE_AGY_VERSION || '1.5.12'}\n`);
    return;
  }
  if (argv[0] === 'models') {
    if (scenario === 'auth') {
      process.stdout.write('Please sign in to view available models. Launch the CLI without arguments to sign in.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('Fetching available models...\n');
    for (const [id, label] of MODELS) process.stdout.write(`${id}\t${label}\n`);
    return;
  }

  const prompt = value('-p', '--print', '--prompt');
  if (prompt === undefined) {
    process.stderr.write('fake agy: interactive mode is not supported\n');
    process.exitCode = 2;
    return;
  }
  const format = value('--output-format') || 'text';

  if (prompt === '/usage') {
    if (scenario === 'auth') {
      process.stderr.write("Error: authentication required. Run 'agy' to log in.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify(usageSample()) + '\n');
    return;
  }

  const continuing = value('--conversation');
  const cid = continuing || randomUUID();
  const isPlan = value('--mode') === 'plan';
  const response = env.FAKE_AGY_RESPONSE || 'OK from fake agy ✓ é';

  if (format !== 'stream-json') {
    // Minimal text/json support; the server always uses stream-json.
    if (format === 'json') process.stdout.write(JSON.stringify({ conversation_id: cid, status: 'SUCCESS', response }) + '\n');
    else process.stdout.write(response + '\n');
    return;
  }

  out({ event: 'init', conversation_id: cid, init: { cwd: process.cwd(), tools: ['view_file', 'run_command'] } });
  out({ event: 'step_update', step_update: { conversation_id: cid, step_index: 0, state: 'DONE', step_type: 'user_input' } });

  switch (scenario) {
    case 'hang':
      setInterval(() => {}, 1 << 30);
      return;
    case 'descendant': {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
      if (env.FAKE_AGY_CHILD_PID_FILE) writeFileSync(env.FAKE_AGY_CHILD_PID_FILE, String(child.pid));
      setInterval(() => {}, 1 << 30);
      return;
    }
    case 'quota':
      process.stderr.write('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","short_error":"RESOURCE_EXHAUSTED (code 429): You have exhausted your capacity on this model. Your quota will reset after 2h0m0s.","retryable":true,"error_id":"fake-quota"}\n');
      result(cid, { status: 'ERROR', response: '', error: 'You have exhausted your capacity on this model. Your quota will reset after 2h0m0s.' });
      process.exitCode = 3;
      return;
    case 'auth':
      process.stderr.write("Error: authentication required. Run 'agy' to log in.\n");
      process.exitCode = 1;
      return;
    case 'error':
      result(cid, { status: 'ERROR', response: '', error: 'something failed inside agy' });
      process.exitCode = 1;
      return;
    case 'malformed':
      process.stdout.write('this is not json\n');
      process.stdout.write('{"event":"step_update","step_update":{"conversation_id":"' + cid + '","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"line1\nline2\t"}}\n');
      result(cid, { response: 'line1\nline2' });
      return;
    case 'no_result':
      await streamText(cid, response);
      return;
    case 'background_abort':
      await streamText(cid, 'Started the build in the background, waiting for it to finish...');
      process.stderr.write('Terminating 1 outstanding background task(s): npm run build\n');
      result(cid, { status: 'ERROR', response: 'Started the build in the background, waiting for it to finish...', error: 'Background task(s) still running at the print timeout were terminated: npm run build' });
      process.exitCode = 3;
      return;
    case 'print_timeout':
      await streamText(cid, 'Partial answer before the deadline');
      result(cid, { response: 'Partial answer before the deadline', finished_reason: 'print_timeout' });
      return;
    case 'mutate':
      writeFileSync(resolve(process.cwd(), env.FAKE_AGY_MUTATE_FILE || 'fake-agy-wrote.txt'), 'written by fake agy\n');
      break;
    default:
      break;
  }

  if (isPlan) {
    const denyNow = scenario === 'plan_denied_always' || (scenario === 'plan_denied' && !continuing);
    if (denyNow) {
      await streamText(cid, 'I will check the workspace first.');
      result(cid, { response: 'I will check the workspace first.', denied_actions: [{ action: 'command', display_name: 'Bash' }] });
      return;
    }
    writePlan(cid, `# Implementation plan\n\nPrompt length: ${prompt.length}\n\n1. Do the thing ✓\n`);
    await streamText(cid, 'Please review implementation_plan.md ✓');
    result(cid, { response: 'Please review implementation_plan.md ✓\n' });
    return;
  }

  await streamText(cid, response, { slow: scenario === 'slow' });
  if (scenario === 'slow') await sleep(Number(env.FAKE_AGY_DELAY_MS || 1500));
  out({ event: 'step_update', step_update: { conversation_id: cid, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n' } });
  result(cid, { response: response + '\n' });
}

main().catch((err) => {
  process.stderr.write(`fake agy crashed: ${err?.stack || err}\n`);
  process.exitCode = 99;
});
