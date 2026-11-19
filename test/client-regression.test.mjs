// Regressions found in review of the runtime layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgy } from '../lib/agy.mjs';
import { loadConfig, normalizeRun } from '../lib/contracts.mjs';

const FAKE = fileURLToPath(new URL('../fixtures/fake-agy.mjs', import.meta.url));
const launch = { file: process.execPath, argsPrefix: [FAKE], source: 'env' };
const config = loadConfig({ AGYCLI_MCP_STATE_DIR: join(tmpdir(), 'agycli-regression') });

test('a successful run that mentions quota on stderr is not a quota failure', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agycli-reg-')));
  const request = normalizeRun({ prompt: 'hi', cwd, timeout_ms: 30_000 }, config);
  const env = { ...process.env, FAKE_AGY_STDERR: 'note: your quota is at 80%; rate limit headroom ok' };
  const r = await runAgy(request, { launch, app_data_dir: null, env, max_output_chars: 10_000 });
  assert.equal(r.failure_reason, undefined, JSON.stringify(r));
  assert.match(r.text, /OK from fake agy/);
});
