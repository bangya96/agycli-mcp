// `node agycli-mcp.mjs doctor`: read-only preflight checks. Exit 0 when nothing failed.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_TESTED_AGY_VERSION } from './contracts.mjs';
import { parseModels } from './quota.mjs';

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function tail(r) {
  return `${r.stderr || ''}\n${r.stdout || ''}`.trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 300);
}

export async function runDoctor({ config, resolveLaunch, resolveAppDataDir, probeAgy, platform = process.platform, nodeVersion = process.versions.node }) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const major = Number(String(nodeVersion).split('.')[0]);
  add('node', major >= 18 ? 'ok' : 'fail', major >= 18 ? `Node ${nodeVersion}` : `Node ${nodeVersion}; Node 18 or newer is required`);

  let launch = null;
  try {
    launch = await resolveLaunch(config);
    add('agy binary', 'ok', `${[launch.file, ...(launch.argsPrefix || [])].join(' ')} (${launch.source})`);
  } catch (err) {
    const searched = Array.isArray(err?.searched) && err.searched.length ? ` Searched: ${err.searched.join(', ')}.` : '';
    add('agy binary', 'fail', `${err?.message || err}.${searched} Set AGYCLI_MCP_AGY_PATH to the agy binary.`);
  }

  if (launch) {
    const v = await probeAgy('version', { launch, timeout_ms: 20_000 });
    const version = (String(v.stdout).match(/\d+\.\d+\.\d+/) || [])[0];
    if (v.exit_code !== 0 || !version) {
      add('agy version', 'fail', `could not read the version: ${tail(v) || `exit ${v.exit_code}`}`);
    } else if (compareVersions(version, MIN_TESTED_AGY_VERSION) < 0) {
      add('agy version', 'warn', `${version}; older than ${MIN_TESTED_AGY_VERSION}, the version this server was measured against. Run \`agy update\`.`);
    } else {
      add('agy version', 'ok', version);
    }

    const m = await probeAgy('models', { launch, timeout_ms: 45_000 });
    const rows = m.exit_code === 0 ? parseModels(m.stdout) : [];
    if (rows.length) add('agy sign-in', 'ok', `${rows.length} models available`);
    else add('agy sign-in', 'fail', `\`agy models\` failed: ${tail(m) || `exit ${m.exit_code}`}. Run \`agy\` once interactively to sign in.`);
  }

  try {
    const a = await resolveAppDataDir(config);
    if (a.exists) add('agy app-data dir', 'ok', `${a.dir} (${a.source})`);
    else add('agy app-data dir', 'warn', `${a.dir} does not exist yet. agy creates it on first use; if plan files live elsewhere set AGYCLI_MCP_APP_DATA_DIR.`);
  } catch (err) {
    add('agy app-data dir', 'warn', err?.message || String(err));
  }

  try {
    mkdirSync(config.state_dir, { recursive: true });
    const probe = join(config.state_dir, `.doctor-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    add('state dir', 'ok', config.state_dir);
  } catch (err) {
    add('state dir', 'fail', `${config.state_dir}: ${err?.message || err}`);
  }

  if (platform === 'win32') {
    add('platform', 'warn', 'Windows support is implemented but not yet smoke-tested against a real agy. Please report problems.');
  }

  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

export function formatDoctor(report) {
  const tag = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };
  const lines = report.checks.map((c) => `${tag[c.status] || '[ ?? ]'} ${c.name}: ${c.detail}`);
  lines.push(report.ok ? 'agycli-mcp doctor: ready' : 'agycli-mcp doctor: problems found');
  return lines.join('\n');
}
