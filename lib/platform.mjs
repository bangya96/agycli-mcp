import { promises as fs, constants } from 'node:fs';
import { join, resolve, delimiter, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export async function resolveLaunch(config) {
  const searched = [];
  const usable = async (file) => {
    searched.push(file);
    try { await fs.access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return (await fs.stat(file)).isFile(); } catch { return false; }
  };
  const missing = (message) => Object.assign(new Error(message), { code: 'agy_not_found', searched });
  if (config.agy_path) {
    const file = resolve(config.agy_path);
    if (/\.(mjs|cjs|js)$/i.test(file)) return { file: process.execPath, argsPrefix: [file], source: 'env' };
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) throw missing('Set AGYCLI_MCP_AGY_PATH to agy.exe, not a .cmd/.bat shim.');
    if (await usable(file)) return { file, argsPrefix: [], source: 'env' };
    throw missing(`agy not found or not executable: ${file}`);
  }
  const win = process.platform === 'win32';
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const file = resolve(dir.replace(/^"|"$/g, ''), win ? 'agy.exe' : 'agy');
    if (await usable(file)) return { file, argsPrefix: [], source: 'path' };
  }
  const env = process.env;
  const known = win ? [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Antigravity', 'agy.exe'),
    join(env.USERPROFILE || homedir(), '.gemini', 'bin', 'agy.exe'),
    env.ProgramData && join(env.ProgramData, 'chocolatey', 'bin', 'agy.exe'),
  ].filter(Boolean) : [join(homedir(), '.local', 'bin', 'agy'), join(homedir(), '.gemini', 'bin', 'agy')];
  for (const file of known) if (await usable(file)) return { file, argsPrefix: [], source: 'known' };
  throw missing('agy not found; set AGYCLI_MCP_AGY_PATH to its executable.');
}

export async function resolveAppDataDir(config) {
  // The same default is used on Windows, where the location remains unverified.
  const dir = resolve(config.app_data_dir || join(homedir(), '.gemini', 'antigravity-cli'));
  let exists = false;
  try { exists = (await fs.stat(dir)).isDirectory(); } catch {}
  return { dir, exists, source: config.app_data_dir ? 'env' : 'default' };
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export async function killTree(pid, { grace_ms = 500 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await new Promise((done) => {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      child.once('error', done); child.once('close', done);
    });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch (e) { if (e.code === 'ESRCH') return; throw e; }
  await new Promise((r) => setTimeout(r, grace_ms));
  try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}

export async function atomicWriteJson(path, value) {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    // Windows refuses to replace a file another process has open (EPERM/EACCES/EBUSY);
    // readers only hold it briefly, so retry for a short while.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, path); break; } catch (e) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 40) throw e;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  } finally { await handle?.close(); await fs.unlink(temp).catch(() => {}); }
}

export async function readJson(path) {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; }
}
