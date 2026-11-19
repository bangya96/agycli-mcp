// Quota (`agy --output-format json -p /usage`, which spends no model quota) and the model list
// (`agy models`, "id<TAB>label" lines), with a mapping from model to quota group.

import { parseJsonLenient } from './contracts.mjs';

export const QUOTA_THRESHOLDS = Object.freeze({ low: 0.25, critical: 0.05 });
const USAGE_FAILURE_TTL_MS = 30_000;
const MODELS_TTL_MS = 5 * 60_000;

export function levelFor(fraction, thresholds = QUOTA_THRESHOLDS) {
  if (typeof fraction !== 'number' || Number.isNaN(fraction)) return 'unknown';
  if (fraction <= 0) return 'exhausted';
  if (fraction < thresholds.critical) return 'critical';
  if (fraction < thresholds.low) return 'low';
  return 'ok';
}

function extractJson(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error('agy returned no JSON');
  return parseJsonLenient(stdout.slice(start, end + 1));
}

/** "Models within this group: A, B (Neon), C" -> ["A", "B (Neon)", "C"] */
export function groupModels(description) {
  const m = /Models within this group:\s*(.+)$/i.exec(description || '');
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);
}

/** Strip the effort suffix from a display label: "Gemini 4 Neon (High)" -> "Gemini 4 Neon". */
export function baseLabel(label) {
  return String(label).replace(/\s*\((?:low|medium|high|xhigh|max|extra)\)\s*$/i, '').trim();
}

export function groupForLabel(groups, label) {
  if (!label || !groups) return null;
  const base = baseLabel(label);
  const hit = groups.find((g) => g.models.includes(base) || g.models.includes(label) || g.name === base);
  return hit ? hit.name : null;
}

export function parseUsage(stdout, now = Date.now()) {
  const data = extractJson(stdout);
  const groups = data?.command?.data?.groups;
  if (!Array.isArray(groups)) {
    const msg = data?.error || data?.response || 'no quota groups in agy output';
    throw new Error(`agy /usage: ${String(msg).slice(0, 300)}`);
  }
  return groups.map((g) => {
    const buckets = (g.buckets || []).map((b) => {
      const reset = b.reset_time ? Date.parse(b.reset_time) : NaN;
      return {
        id: b.id,
        name: b.name,
        window: b.window,
        remaining_fraction: typeof b.remaining_fraction === 'number' ? b.remaining_fraction : null,
        reset_time: b.reset_time || null,
        // A reset time in the past means the bucket has refilled since this reading.
        expired: Number.isFinite(reset) && reset <= now,
      };
    });
    const live = buckets.filter((b) => !b.expired && b.remaining_fraction !== null);
    const tightest = live.reduce((min, b) => (min && min.remaining_fraction <= b.remaining_fraction ? min : b), null);
    return {
      name: g.name,
      description: g.description || '',
      models: groupModels(g.description),
      level: tightest ? levelFor(tightest.remaining_fraction) : 'unknown',
      remaining_percent: tightest ? Math.floor(tightest.remaining_fraction * 100) : null,
      window: tightest ? tightest.window : null,
      reset_time: tightest ? tightest.reset_time : null,
      buckets,
    };
  });
}

export function parseModels(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 2 && parts[0].trim() && !/\s/.test(parts[0].trim()))
    .map(([id, ...rest]) => ({ id: id.trim(), label: rest.join('\t').trim() }));
}

function probeError(kind, r) {
  const tail = `${r.stderr || ''}\n${r.stdout || ''}`.trim().split(/\r?\n/).slice(-3).join(' | ');
  const err = new Error(
    r.timed_out
      ? `agy ${kind} timed out`
      : `agy ${kind} failed (exit ${r.exit_code})${tail ? `: ${tail.slice(0, 400)}` : ''}`,
  );
  if (/authentication required|authentication expired|sign in/i.test(tail)) {
    err.code = 'auth_required';
    err.message += '\nRun `agy` once interactively on this machine to sign in.';
  }
  return err;
}

/**
 * getLaunch(): (async) returns the agy launch spec or throws (code agy_not_found).
 * probeAgy(kind, {launch, timeout_ms}) -> {exit_code, stdout, stderr, timed_out?}
 */
export function createQuota({ getLaunch, probeAgy, now = Date.now }) {
  let usage = null; // {value, at} | {error, at}
  let usageInflight = null;
  let models = null; // {value, at}

  async function probeUsage() {
    try {
      const r = await probeAgy('usage', { launch: await getLaunch(), timeout_ms: 45_000 });
      if (r.exit_code !== 0) throw probeError('/usage', r);
      const value = { checked_at: new Date(now()).toISOString(), groups: parseUsage(r.stdout, now()) };
      usage = { value, at: now() };
      return value;
    } catch (err) {
      usage = { error: err, at: now() };
      throw err;
    }
  }

  async function getUsage({ max_age_ms = 60_000 } = {}) {
    const maxAge = Math.max(10_000, Number(max_age_ms) || 60_000);
    if (usage) {
      const age = now() - usage.at;
      if (usage.value && age <= maxAge) {
        // Re-evaluate expiry against the current clock; a stale cached reading must not claim "low".
        const groups = usage.value.groups.map((g) => ({ ...g }));
        return { ...usage.value, groups, cached: true, age_ms: age };
      }
      if (usage.error && age <= USAGE_FAILURE_TTL_MS) throw usage.error;
    }
    if (!usageInflight) usageInflight = probeUsage().finally(() => { usageInflight = null; });
    const value = await usageInflight;
    return { ...value, cached: false, age_ms: 0 };
  }

  async function listModels() {
    let list;
    if (models && now() - models.at <= MODELS_TTL_MS) {
      list = models.value;
    } else {
      const r = await probeAgy('models', { launch: await getLaunch(), timeout_ms: 45_000 });
      if (r.exit_code !== 0) throw probeError('models', r);
      list = parseModels(r.stdout);
      if (!list.length) throw probeError('models', { ...r, exit_code: r.exit_code ?? 'none' });
      models = { value: list, at: now() };
    }
    let groups = null;
    let quota_checked_at = null;
    try {
      const u = await getUsage();
      groups = u.groups;
      quota_checked_at = u.checked_at;
    } catch {
      // Quota is optional decoration for the model list.
    }
    return {
      models: list.map((m) => ({ ...m, quota_group: groups ? groupForLabel(groups, m.label) : null })),
      quota_checked_at,
    };
  }

  return { getUsage, listModels };
}
