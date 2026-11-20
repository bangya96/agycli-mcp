---
name: agycli
description: Delegate study, planning, questions or implementation to the Google Antigravity CLI (agy) through the agycli MCP server (tools agy_run, agy_wait, agy_status, agy_usage, agy_models). Use when the user asks to use agy / Antigravity CLI, e.g. "use agy", "ask agy", "guna agy", "suruh agy", "tanya agy", "minta agy buat plan".
version: 0.2.0
platforms: [macos, linux, windows]
---

# agycli: delegating to the Antigravity CLI

The agycli MCP server runs `agy` as background jobs. You (the calling agent) stay the planner and
reviewer; agy does the delegated study or implementation.

This skill works in any MCP client (Claude Code, Hermes Agent, Codex CLI, ...). Clients prefix MCP
tool names differently (`mcp__agycli__agy_run`, `mcp_agycli_agy_run`, ...): use whatever names your
client exposes for the agycli server's `agy_*` tools.

## Pick the mode

| Situation | Mode |
|---|---|
| Understand a codebase, investigate a bug, design a change | `plan` |
| Quick question about code or docs; review without changes | `ask` |
| Implement an **approved** plan, or a change the user explicitly asked agy to make | `edit` |

- `plan` is the only hard lock (agy's own plan mode). It returns `implementation_plan.md`.
- `ask` is read-only **by instruction only**. Check the `changes` field afterwards; if files changed,
  tell the user and show `git diff`. Never auto-revert.
- `edit` can change anything in the workspace. Use it only with the user's approval.

## Plan-first workflow (default for anything non-trivial)

1. `agy_run` with `mode: "plan"`, an absolute `cwd`, and a self-contained prompt.
2. Collect it with `agy_wait`, calling it again while the state is still `running`. (Claude Code
   with the optional completion-wake hook is woken when the job ends instead.)
3. Show the user the plan (summarise; quote key steps). Point out risks you see.
4. Only after the user approves: `agy_run` with `mode: "edit"`, the **same** `conversation_id`, and
   a prompt like "The plan is approved. Implement it." Add any changes the user asked for.
5. Review the result yourself: `git status`, `git diff`, run tests. Report what was verified.

If the plan job fails with `plan_incomplete`, retry with a narrower prompt or continue the same
conversation in plan mode. Never switch to `edit` to "finish" a plan.

## Writing the prompt

agy has no memory of this conversation. Include: the goal, absolute paths of relevant files,
constraints and decisions already made, what not to touch, and the answer shape you want.
Ask agy to do the work itself rather than delegating to subagents, and to run any verification
commands in the foreground (agy kills background tasks when a headless run ends).

## Models

Run `agy_models` once per session if unsure what the account offers. Typical routing:

| Tier | Use for | Models (first available) |
|---|---|---|
| High | multi-file changes, subtle bugs, architecture | `gemini-4-neon-high` (or `-xhigh`), `claude-opus-5-5-high`, `gemini-4-hydrogen-high` |
| Medium | well-scoped features and fixes | `gemini-4-neon-medium`, `claude-sonnet-5-5-medium`, `gemini-4-argon-medium` |
| Low | lookups, small mechanical edits | `gemini-3.8-flash-medium`, `gemini-3.8-flash-low` |

An explicit model from the user always wins. Gemini models share one quota group; Claude and GPT
models share another; Argon has its own.

## Quota and failures

- Before a long or high-tier job, check `agy_usage`. If the model's group is `low` or worse, say so
  and suggest a model from another group.
- `quota_exhausted`: report the reset time; switch quota group only if the user agrees.
- `auth_required`: the user must run `agy` interactively to sign in. Do not retry.
- `timeout` / `partial`: the text may be incomplete; continue the same conversation if useful.
- `busy_workspace`: another ask/edit job is running in that directory; wait for it or cancel it.

## Waiting

`agy_run_sync` waits about 90 s. For anything longer use `agy_run` and then `agy_wait` (each call
blocks up to about 90 s). Do not start a second edit job in the same workspace while one is running.

Every result starts with `job_id`, `state`, `conversation_id`, `cwd`, the plan path and a `next:`
line saying what to do next; read those before the long response body.

Cancelling or timing out a tool call does not stop the job. To stop it, call `agy_cancel`. After a
lost connection, use `agy_jobs` / `agy_status` to find the job before starting another one.

## Terms of Service

agy is for the user's own account and own work. Never route other people's requests through it,
never use it to resell access, and keep usage reasonable.
