# agycli-mcp: design plan v1 (agreed, implementation contract)

A dependency-free MCP server (Node.js 18+, ESM, JSON-RPC 2.0 over newline-delimited stdio) that
lets MCP clients drive the Google Antigravity CLI (`agy`). Clone-and-run: `node agycli-mcp.mjs`.
No build step, no npm dependencies. macOS and Windows are first-class targets; Linux should work.
Public repo, MIT licence. Ideas (not code) borrowed from
[tphakala/agy-mcp](https://github.com/tphakala/agy-mcp) (Go, MIT), credited in the README.

The difference from tphakala/agy-mcp: **three explicit modes**, with `plan` locked by agy's own
plan mode (tphakala always passes `--dangerously-skip-permissions --disable-slash-commands`, which
disables `--mode plan`).

v0 was reviewed by Astra (cx/gpt-6-astra) on 2026-11-19; this v1 records the decisions.

## Facts measured locally (agy 1.5.12, macOS, 2026-11-19)

- `agy -p` writes files and runs shell commands even without `--dangerously-skip-permissions`.
  `--sandbox` does not stop file writes inside cwd.
- `--mode plan` (without `--disable-slash-commands`) does not modify project files. It writes
  `implementation_plan.md` to `<app-data>/brain/<conversation_id>/` (macOS app-data:
  `~/.gemini/antigravity-cli`). Its `response` only says "please review the plan".
- In plan mode, a shell command attempt is denied and the run ends early, often with no plan file.
  The result then carries `denied_actions: [{"action":"command","display_name":"Bash"}]`.
- Continuing the conversation without `--mode plan` (`agy --conversation <id> -p "Plan approved,
  implement it"`) executes the plan.
- `agy --output-format json -p /usage` returns quota with no model call, in
  `command.data.groups[] = {name, description: "Models within this group: A, B, C", buckets[] =
  {id, window: "weekly"|"5h", remaining_fraction, reset_time}}`.
- `agy models` prints `id<TAB>Display label` lines. `agy models --output-format json` is rejected and
  `agy -p /models` hangs, so parse the text.
- `--output-format stream-json` NDJSON: `{"event":"init","conversation_id",...}`, `{"event":"step_update",
  "step_update":{conversation_id, step_index, state, step_type, text_delta?, usage?}}`, final
  `{"event":"result","result":{conversation_id, status, response, duration_seconds, num_turns, usage,
  denied_actions?}}`.
- JSON output can contain raw control characters inside strings.
- From tphakala's measurements: `agy -p` blocks if stdin is an open pipe (always use ignored stdin);
  headless agy kills outstanding background shell tasks at the end of a run; internal subagent output
  can be lost; prompts are literal only with `--disable-slash-commands`.

Windows (unverified, from third-party guides): installer puts `agy.exe` in `%LOCALAPPDATA%\agy\bin\`
or `%LOCALAPPDATA%\Antigravity\`; Chocolatey ships an `agy.exe` shim. App-data dir unknown, likely
`%USERPROFILE%\.gemini\antigravity-cli`. The README must say Windows is not yet smoke-tested.

## Decisions (v1 scope)

- One entry `agycli-mcp.mjs` plus `lib/` modules. No per-platform entry files.
- Keep: three modes, background jobs, `agy_run_sync` as start+wait, status/wait/cancel/jobs,
  on-demand cached quota, models, doctor, completion-wake hook, `idempotency_key`, change detection
  for `ask` and `edit`.
- Cut from v1: `continue_latest`, `json_schema`, quota-based admission (`priority`), background quota
  polling, HTTP transport, sessions listing.
- Plan auto-continue: **one** continuation, still in plan mode, only when the run had
  `denied_actions` and produced no fresh plan artifact. Never drop `--mode plan` to recover.
- Prompts: argv, stdin ignored. Windows command-line length checked (reject > 30 000 chars with a
  clear error); stdin stream-json input is a later improvement once measured.
- Floor: no hard version refusal. `doctor` warns below 1.5.12 (the only measured version).

## Modes (exact agy flags)

Common: `-p <prompt> --output-format stream-json --print-timeout <seconds>s`, spawn cwd = request
cwd, `--add-dir <cwd>` plus `--add-dir <d>` for each extra dir, `--model`, `--effort`,
`--conversation <id>` when given.

| Mode | Extra flags | Preamble | Lock |
|---|---|---|---|
| `plan` | `--mode plan` (no skip-permissions, no disable-slash-commands). Prompts starting with `/` are rejected | `PLAN_PREAMBLE` | conversation |
| `ask` | `--disable-slash-commands` (no skip-permissions) | `ASK_PREAMBLE` | conversation + workspace |
| `edit` | `--dangerously-skip-permissions --disable-slash-commands` | none | conversation + workspace |

Preamble text lives in `lib/contracts.mjs` and is prepended as `<preamble>\n\n<prompt>`.

Plan artifact: before running, fingerprint `<app-data>/brain/<cid>/implementation_plan.md` (when
continuing a known conversation). After the run, accept it only if it is new or changed during this
job. Validate the conversation id format and that the resolved path stays inside `<app-data>/brain`.
Return `plan: {path, content, truncated}`. No fresh artifact after the one continuation ->
`failure_reason: plan_incomplete`, keeping text, `denied_actions` and `conversation_id`.

Approval flow (documented in the skill): plan job -> user approves -> `agy_run` with the same
`conversation_id`, `mode: edit`, prompt "The plan is approved. Implement it."

## Shared interfaces (frozen; change only by agreement)

All functions async unless noted. Durations in ms, timestamps Unix ms.

### lib/contracts.mjs (Claude)

```text
loadConfig(env) -> Config                      // sync; see file for fields
normalizeRun(input, config) -> RunRequest      // sync; throws ValidationError(code 'invalid_params')
requestKey(request) -> string                  // sync; stable JSON without idempotency_key
constants: MODES, EFFORTS, STATES, TERMINAL_STATES, FAILURE_REASONS,
           PLAN_PREAMBLE, PLAN_CONTINUE_PROMPT, ASK_PREAMBLE, MIN_TESTED_AGY_VERSION
```

`RunRequest` (frozen object): `prompt, mode, cwd (realpath), dirs (realpaths), timeout_ms` and
optional `model, effort, conversation_id, idempotency_key`.

### lib/platform.mjs (Astra)

```text
resolveLaunch(config) -> {file, argsPrefix: string[], source}   // throws code 'agy_not_found' (with .searched)
resolveAppDataDir(config) -> {dir, exists, source}
killTree(pid, {grace_ms}) -> void         // POSIX: -pgid SIGTERM then SIGKILL; Windows: taskkill /T /F
isAlive(pid) -> boolean                   // sync
atomicWriteJson(path, value) -> void      // temp + fsync + rename
readJson(path) -> value | null
```

### lib/agy.mjs (Astra)

```text
buildArgs(request, {phase: 'initial' | 'plan_continue', timeout_s}) -> string[]   // sync, pure
runAgy(request, {launch, app_data_dir, signal, on_event?, max_output_chars}) -> ExecutionResult
probeAgy(kind: 'version'|'models'|'usage', {launch, timeout_ms}) -> {exit_code, stdout, stderr}
```

`ExecutionResult`: `text, partial, exit_code, denied_actions[]` and optional `conversation_id,
usage, num_turns, failure_reason, error, plan`.

### lib/change-detection.mjs (Astra)

```text
snapshot(dirs: string[]) -> Snapshot               // JSON-serialisable
compare(before, after) -> Changes
```

`Changes`: `{changes_detected: boolean|null, files: string[], coverage: 'git'|'partial'|'none',
limitations: string[]}`. `null` means detection unavailable, never `false`.

### lib/jobs.mjs + lib/supervisor.mjs (Astra)

```text
createJobStore({config, launch, app_data_dir}) -> JobStore
JobStore.start(request) -> JobView      // throws code: busy_conversation | busy_workspace |
                                        //   concurrency_limit | idempotency_conflict
JobStore.status(job_id) -> JobView      // throws code 'not_found'
JobStore.wait(job_id, {wait_ms, signal}) -> JobView
JobStore.cancel(job_id) -> JobView
JobStore.list({limit}) -> {jobs: JobView[]}
JobStore.markCollected(job_id) -> void
JobStore.gc() -> {removed}
```

`JobView`: `job_id, state, mode, cwd, created_at, elapsed_ms` and optional `started_at,
finished_at, conversation_id, model, result` where `result = ExecutionResult + {changes?}`.
States: `starting | running | done | failed | cancelled`. A committed terminal result wins over a
racing cancel.

Supervisor: `node lib/supervisor.mjs <job-dir>`, spawned detached with ignored stdio and
`windowsHide`. Heartbeat every 5 s into `status.json`; a job is stale when the heartbeat is older
than 30 s and the PID is not alive. MCP disconnects never cancel jobs.

### Disk contract

`<state>/jobs/<uuid>/`: `meta.json` (immutable `{schema_version:1, job_id, created_at, request}`),
`status.json` (atomic live JobView + `{pid, token, heartbeat_at}`), `events.jsonl` and `stderr.log`
(raw, bounded), `result.json` (immutable terminal JobView, written before `done`), empty `done`,
`cancel`, `collected` markers. `<state>/locks/` (conversation and workspace locks, JSON
`{job_id, pid, token, created_at}`), `<state>/idem/<sha256>.json` (`{job_id, request_key}`).
Status reads honour `result.json` even when `done` is missing. GC removes terminal jobs whose
`finished_at` is older than the TTL, never live ones.

### Claude-owned modules

`agycli-mcp.mjs` (entry and subcommands `hook-wait`, `doctor`), `lib/mcp.mjs` (framing, version
negotiation, dispatch), `lib/tools.mjs` (schemas and handlers), `lib/quota.mjs` (`getUsage`,
`listModels`, model-to-group mapping), `lib/hook.mjs` (`hookWait`), `lib/doctor.mjs`,
`test/fixtures/fake-agy.mjs`, `test/client-*.test.mjs`, README, `skills/agycli/SKILL.md`, CI.

## Tools

| Tool | Notes |
|---|---|
| `agy_run` | start job; returns JobView |
| `agy_run_sync` | start + wait up to `wait_ms` (default 90 s, env `AGYCLI_MCP_SYNC_WAIT_MS`) |
| `agy_status`, `agy_wait`, `agy_cancel`, `agy_jobs` | lifecycle; terminal reads mark `collected` |
| `agy_usage` | quota groups with level `ok/low/critical/exhausted/unknown`, `checked_at`, raw buckets |
| `agy_models` | `{models: [{id, label, quota_group?}]}` |

Run tools are annotated as potentially destructive (ask and edit share the schema).

## Testing

`node --test`. `test/fixtures/fake-agy.mjs` mimics agy flags and output with scenarios chosen by
`FAKE_AGY_SCENARIO`. CI matrix: ubuntu, macos, windows on Node 18 and 22. Real-agy smoke tests are
manual (`npm run smoke` is not required; document the commands).
