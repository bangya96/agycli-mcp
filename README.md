# agycli-mcp

A dependency-free [MCP](https://modelcontextprotocol.io) server for the **Google Antigravity CLI** (`agy`).
It lets Claude Code (or any MCP client) hand work to `agy` in three explicit modes:

| Mode | What agy may do | How it is enforced |
|---|---|---|
| `plan` | Read and search files, then write an implementation plan | **Locked** by agy's own `--mode plan`: file edits and shell commands are denied. Returns `implementation_plan.md`. |
| `ask` | Read files and answer | **Instruction only**: a read-only preamble, plus change detection that reports any files that changed during the run |
| `edit` | Read, write and run commands in the workspace | Nothing; use it when you mean it |

On top of that: background jobs that survive client disconnects, quota checks, a completion-wake hook
for Claude Code, and a `doctor` command.

- Pure Node.js 18+, no `npm install`, no build step: clone and run `node agycli-mcp.mjs`.
- macOS, Windows and Linux from one file.
- MIT licence.

## Why another agy MCP server?

[tphakala/agy-mcp](https://github.com/tphakala/agy-mcp) is excellent and inspired most of the job,
quota and hook design here. It always runs agy with `--dangerously-skip-permissions
--disable-slash-commands`, which also disables agy's plan mode, so it has no locked read-only path.
agycli-mcp adds the `plan` / `ask` / `edit` split, aimed at a plan-first workflow:

1. `plan`: agy studies the code and writes a plan, without touching files.
2. You review and approve the plan.
3. `edit` with the same `conversation_id`: agy implements the approved plan.

## Requirements

- Node.js 18 or newer.
- The Antigravity CLI (`agy`), signed in. Run `agy` once interactively to sign in.
  Tested with agy **1.5.12** on macOS.
- Git (optional, used for change detection in `ask` and `edit`).

## Install

```bash
git clone https://github.com/bangya96/agycli-mcp.git
cd agycli-mcp
node agycli-mcp.mjs doctor
```

`doctor` checks Node, finds `agy`, checks your sign-in, and verifies the directories. Fix anything
marked `[FAIL]`.

### Claude Code

macOS / Linux:

```bash
claude mcp add agycli -- node /absolute/path/to/agycli-mcp/agycli-mcp.mjs
```

Windows (PowerShell):

```powershell
claude mcp add agycli -- node C:\path\to\agycli-mcp\agycli-mcp.mjs
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "agycli": { "command": "node", "args": ["/absolute/path/to/agycli-mcp/agycli-mcp.mjs"] }
  }
}
```

### Optional: Claude Code skill

`skills/agycli/SKILL.md` teaches Claude when to use each mode and which model to pick. Copy it to
`~/.claude/skills/agycli/SKILL.md` (Windows: `%USERPROFILE%\.claude\skills\agycli\SKILL.md`).

### Optional: completion-wake hook (Claude Code)

Claude Code does not wake the model when a background MCP job finishes. This hook does: after every
`agy_run`, it waits for the job in the background and wakes Claude when the job ends (unless the
result was already read). Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__agycli__agy_run(_sync)?",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/agycli-mcp/agycli-mcp.mjs hook-wait",
            "asyncRewake": true,
            "timeout": 3700
          }
        ]
      }
    ]
  }
}
```

- The `agycli` in the matcher must match the name you used in `claude mcp add`.
- The hook's `timeout` (seconds) must exceed hook-wait's own limit (1 hour by default,
  `--timeout-ms` or `AGYCLI_MCP_HOOK_TIMEOUT_MS` to change).
- Hooks run with your shell environment, not the MCP server's. If you set `AGYCLI_MCP_STATE_DIR`
  for the server, set it for the hook too.

## Tools

| Tool | Purpose |
|---|---|
| `agy_run` | Start a job in the background; returns `job_id` (and `conversation_id` once agy reports it) |
| `agy_run_sync` | Start and wait inline up to about 90 s; returns the result or a running `job_id` |
| `agy_wait` | Block until a job finishes (up to about 90 s per call) |
| `agy_status` | State and result of a job |
| `agy_cancel` | Cancel a job and its whole process tree |
| `agy_jobs` | Recent jobs, newest first |
| `agy_usage` | Quota per group (weekly and 5-hour windows), level `ok` / `low` / `critical` / `exhausted` / `unknown`. Spends no model quota |
| `agy_models` | Model ids for the `model` parameter, with labels and quota groups |

Run parameters: `prompt` (required), `mode` (`plan` / `ask` / `edit`, default `ask`), `model`,
`effort` (`low` / `medium` / `high` / `xhigh`), `cwd` (absolute), `dirs` (extra absolute dirs),
`conversation_id`, `timeout_ms` (10 s to 2 h, default 20 min), `idempotency_key`.

The inline wait is capped at 90 s because MCP clients such as Claude Code give up on a tool call after
roughly 120 s. Jobs keep running regardless; collect them with `agy_wait` or `agy_status`.

### Results

A finished job reports `state` (`done`, `failed`, `cancelled`) and, when it failed, a
`failure_reason`: `quota_exhausted`, `timeout`, `auth_required`, `spawn_failed`, `agy_error`,
`background_aborted`, `plan_incomplete`, `interrupted` or `unknown`. `partial: true` means the text
was reconstructed from streamed output and may be incomplete. `ask` and `edit` jobs include
`changes`: the files that changed during the run (via git), or `null` when that could not be checked.

## Safety notes

- **`plan` is the only hard lock.** It relies on agy's plan mode. agy still loads the project's
  `AGENTS.md`, hooks and its own MCP servers, which run outside that lock.
- **`ask` is not a sandbox.** agy in headless mode writes files and runs commands even without
  `--dangerously-skip-permissions`, and `--sandbox` does not stop writes in the workspace (measured with
  agy 1.5.12). `ask` relies on a read-only instruction and then tells you what changed. Run it in a git
  repository so changes are visible and reversible.
- **`edit` can do anything your user account can do** inside and around the workspace.
- Only one `ask` or `edit` job runs per workspace, and one job per conversation, at a time.
- Prompts and agy output are stored in the job state directory (see below) for 24 hours.

## Terms of Service

agy is a Google product for your own use. Google's suspension appeal form lists "using third party
software, tools, or services to access Antigravity" and "resale of AI Developer Tools services" as
grounds for suspension. This server only runs the official `agy` binary through its documented headless
mode, but whether that is acceptable is Google's call, not ours. **Use your own account, for your own
work, at your own risk. Do not use this to resell or share access.**

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGYCLI_MCP_AGY_PATH` | auto | Path to the agy binary |
| `AGYCLI_MCP_APP_DATA_DIR` | `~/.gemini/antigravity-cli` | agy's data dir; plan files are read from `brain/<conversation_id>/` |
| `AGYCLI_MCP_STATE_DIR` | `~/.local/state/agycli-mcp`, Windows `%LOCALAPPDATA%\agycli-mcp` | Job state |
| `AGYCLI_MCP_DEFAULT_MODEL` | agy's default | Model id used when a run names none |
| `AGYCLI_MCP_TIMEOUT_MS` | `1200000` | Default job timeout |
| `AGYCLI_MCP_SYNC_WAIT_MS` | `90000` | Inline wait cap for `agy_run_sync` / `agy_wait` |
| `AGYCLI_MCP_MAX_CONCURRENCY` | `3` | Running jobs per state dir |
| `AGYCLI_MCP_JOB_TTL_MS` | `86400000` | Finished jobs are deleted after this |
| `AGYCLI_MCP_MAX_OUTPUT` | `200000` | Max characters of text returned |
| `AGYCLI_MCP_HOOK_TIMEOUT_MS` | `3600000` | hook-wait limit |
| `AGYCLI_MCP_DEBUG` | off | `1` logs to stderr |

agy is looked up in `AGYCLI_MCP_AGY_PATH`, then `PATH`, then the usual install locations
(`~/.local/bin/agy`, `~/.gemini/bin/agy`; on Windows `%LOCALAPPDATA%\agy\bin\agy.exe`,
`%LOCALAPPDATA%\Antigravity\agy.exe`, `%USERPROFILE%\.gemini\bin\agy.exe` and the Chocolatey shim).

## Tested

- Real agy 1.5.12 on macOS, through the MCP server: `doctor`, `agy_usage`, `agy_models`, an `ask`
  job (no files changed), a `plan` job (plan returned, working tree untouched) and an `edit` job that
  continued the plan's conversation and implemented it (changed file reported).
- The automated suite (fake agy) runs in CI on Linux, macOS and Windows with Node 18 and 22.

## Windows status

Windows is supported in code (process-tree kill with `taskkill /T /F`, `.exe` lookup, no shell
spawning) and the test suite runs on Windows in CI with a fake agy. It has **not yet been
smoke-tested against a real agy on Windows**, and agy's Windows install and data paths come from
third-party guides. If plan files are not found, set `AGYCLI_MCP_APP_DATA_DIR`. Reports welcome.

Prompts are passed on the command line, which Windows limits to about 32 000 characters; longer
prompts are refused with a clear error. Put long context in a file and reference its path.

## Development

```bash
npm test            # or: node --test
```

Tests use `fixtures/fake-agy.mjs`, which mimics agy's flags and output, so they need no Google
account. `PLAN.md` documents the design, the measured agy behaviour and the module contracts.

## Credits

Job supervision, quota, completion-wake hook and doctor ideas come from
[tphakala/agy-mcp](https://github.com/tphakala/agy-mcp) (MIT). No code was copied.

## Licence

MIT. See [LICENSE](LICENSE).
