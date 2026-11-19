#!/usr/bin/env node
// agycli-mcp: dependency-free MCP server for the Google Antigravity CLI (agy).
//
//   node agycli-mcp.mjs              MCP server over stdio (what MCP clients launch)
//   node agycli-mcp.mjs doctor       preflight checks
//   node agycli-mcp.mjs hook-wait    Claude Code async PostToolUse hook (completion wake)
//   node agycli-mcp.mjs --version
//
// Configuration is by environment variables; see README.md.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/contracts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

const INSTRUCTIONS = [
  'agycli-mcp runs the Google Antigravity CLI (agy) as background jobs.',
  'Modes: plan = locked read-only study that returns implementation_plan.md; ask = read-only by instruction, reports file changes observed during the run; edit = full access to change files and run commands.',
  'Plan-first workflow: run mode plan, show the plan to the user, and only after approval call agy_run with mode edit and the same conversation_id.',
  'Short tasks: agy_run_sync (waits about 90 s). Longer tasks: agy_run, then agy_wait or agy_status.',
  'Always pass an absolute cwd. agy has no memory of this conversation, so put all needed context in the prompt.',
].join('\n');

const USAGE = `agycli-mcp ${VERSION}
Usage:
  node agycli-mcp.mjs              start the MCP server on stdio
  node agycli-mcp.mjs doctor       check agy, sign-in, directories
  node agycli-mcp.mjs hook-wait [--timeout-ms N]
                                   Claude Code async PostToolUse hook (reads the payload on stdin)
  node agycli-mcp.mjs --version`;

function makeLog(config) {
  return (msg) => {
    if (config.debug) process.stderr.write(`[agycli-mcp] ${msg}\n`);
  };
}

async function serve() {
  const config = loadConfig();
  const log = makeLog(config);
  const [{ createServer }, { createTools }, { createQuota }, platform, agy, jobs] = await Promise.all([
    import('./lib/mcp.mjs'),
    import('./lib/tools.mjs'),
    import('./lib/quota.mjs'),
    import('./lib/platform.mjs'),
    import('./lib/agy.mjs'),
    import('./lib/jobs.mjs'),
  ]);

  let cachedLaunch = null;
  const getLaunch = async () => {
    if (!cachedLaunch) cachedLaunch = await platform.resolveLaunch(config);
    return cachedLaunch;
  };
  const appDataDir = async () => {
    try {
      return (await platform.resolveAppDataDir(config)).dir;
    } catch {
      return null;
    }
  };

  // The store is cheap and disk-backed. Without agy it still serves status/wait/cancel/list;
  // it is rebuilt once agy can be resolved, so installing agy later needs no restart.
  let store = null;
  let storeHasLaunch = false;
  const getStore = async ({ need_launch = false } = {}) => {
    if (store && (storeHasLaunch || !need_launch)) return store;
    let launch = null;
    try {
      launch = await getLaunch();
    } catch (err) {
      if (need_launch) throw err;
    }
    store = jobs.createJobStore({ config, launch, app_data_dir: await appDataDir() });
    storeHasLaunch = Boolean(launch);
    return store;
  };

  const quota = createQuota({ getLaunch, probeAgy: agy.probeAgy });
  const tools = createTools({ config, getStore, quota });
  const server = createServer({ name: 'agycli-mcp', version: VERSION, instructions: INSTRUCTIONS, tools, log });

  const gc = () => {
    Promise.resolve()
      .then(async () => (await getStore()).gc())
      .catch((err) => log(`gc failed: ${err?.message || err}`));
  };
  setTimeout(gc, 5_000).unref();
  setInterval(gc, 60 * 60_000).unref();

  process.on('uncaughtException', (err) => log(`uncaught: ${err?.stack || err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack || err}`));

  // Jobs run in detached supervisors, so the client going away never cancels them.
  server.serveStdio({ onClose: () => process.exit(0) });
  log(`agycli-mcp ${VERSION} ready (state dir ${config.state_dir})`);
}

async function doctor() {
  const config = loadConfig();
  const [{ runDoctor, formatDoctor }, platform, agy] = await Promise.all([
    import('./lib/doctor.mjs'),
    import('./lib/platform.mjs'),
    import('./lib/agy.mjs'),
  ]);
  const report = await runDoctor({
    config,
    resolveLaunch: platform.resolveLaunch,
    resolveAppDataDir: platform.resolveAppDataDir,
    probeAgy: agy.probeAgy,
  });
  process.stdout.write(`${formatDoctor(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

async function hookWaitCommand(args) {
  // Never disrupt the observed tool call: any failure here exits 0 silently.
  try {
    const config = loadConfig();
    const { hookWait } = await import('./lib/hook.mjs');
    const i = args.indexOf('--timeout-ms');
    const timeout_ms = Number(i !== -1 ? args[i + 1] : process.env.AGYCLI_MCP_HOOK_TIMEOUT_MS) || 3_600_000;

    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    let payload = null;
    try {
      payload = JSON.parse(input);
    } catch {
      process.exit(0);
    }

    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    process.on('SIGTERM', () => controller.abort());
    const { exit_code, stderr } = await hookWait(payload, { state_dir: config.state_dir, timeout_ms, signal: controller.signal });
    if (stderr) process.stderr.write(`${stderr}\n`);
    process.exit(exit_code);
  } catch {
    process.exit(0);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) await serve();
else if (cmd === 'doctor') await doctor();
else if (cmd === 'hook-wait') await hookWaitCommand(rest);
else if (cmd === '--version' || cmd === '-v') process.stdout.write(`${VERSION}\n`);
else if (cmd === '--help' || cmd === '-h' || cmd === 'help') process.stdout.write(`${USAGE}\n`);
else {
  process.stderr.write(`unknown command: ${cmd}\n${USAGE}\n`);
  process.exitCode = 2;
}
