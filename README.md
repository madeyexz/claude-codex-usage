# claude-codex-usage

[![npm version](https://img.shields.io/npm/v/claude-codex-usage?color=cb3837&label=npm&logo=npm)](https://www.npmjs.com/package/claude-codex-usage)
[![npm downloads](https://img.shields.io/npm/dm/claude-codex-usage?color=cb3837)](https://www.npmjs.com/package/claude-codex-usage)
[![license](https://img.shields.io/npm/l/claude-codex-usage)](./LICENSE)
[![node](https://img.shields.io/node/v/claude-codex-usage)](https://nodejs.org/)

> **How many words per day do you actually read and type with coding agents?**

A zero-config CLI that scans your local Claude Code and Codex CLI session logs and prints a per-day breakdown of messages and words, plus a summary that translates it into hours of typing, voice dictation, and reading. Nothing leaves your machine.

---

## Install-free run

```bash
bunx claude-codex-usage
# or
npx claude-codex-usage
```

By default it shows the last 30 days. Use `--all` for the full history.

## Example

```
┌────────────┬─────────────────────────────────────────────────┐
│            │                     claude                      │
│    date    ├──────────┬───────────┬────────────┬─────────────┤
│            │ you msgs │ you words │ reply msgs │ reply words │
├────────────┼──────────┼───────────┼────────────┼─────────────┤
│ 2026-04-17 │      132 │     4,805 │        438 │      50,201 │
│ 2026-04-18 │      157 │     9,212 │        562 │      48,847 │
│ 2026-04-19 │       39 │     1,513 │        110 │       8,078 │
│ 2026-04-20 │       44 │       625 │        104 │       6,710 │
├────────────┼──────────┼───────────┼────────────┼─────────────┤
│   TOTAL    │      372 │    16,155 │      1,214 │     113,836 │
│  AVG/day   │       93 │     4,038 │        303 │      28,459 │
└────────────┴──────────┴───────────┴────────────┴─────────────┘

Active days: 4 / 4

On an average active day with Claude Code:
  You send 93 messages (4,038 words) — about 50 min typing at 80 WPM,
    or 40 min dictating at 100 WPM.
  You read 303 assistant text blocks (28,459 words) — roughly 1h 53m at 250 WPM.
  (3.3× more reply blocks than prompts — the agent emits text between each tool call.)
```

The default view has three column groups — **all**, **claude**, **codex** — showing both tools side by side.

## Usage

```
claude-codex-usage [--days N | --since YYYY-MM-DD | --all]
                   [--claude-only | --codex-only] [--csv]
```

| flag | effect |
|---|---|
| `--days N` | Only the last N days (default: **30**) |
| `--since YYYY-MM-DD` | Only activity on or after that date |
| `--all` | Full history (slower; scans every session file) |
| `--claude-only` | Hide Codex columns |
| `--codex-only` | Hide Claude Code columns |
| `--csv` | Emit CSV instead of a table |
| `-h, --help` | Show help |

## What gets counted

The goal is to count **only the text you actually read and type** — not the agent's internal reasoning, not tool calls, not code written via Edit/Write, not tool results.

**Claude Code** — session files at `~/.claude/projects/<project>/<session>.jsonl`:

- ✅ `assistant.content[]` blocks where `type == "text"` (what the agent shows you)
- ✅ `user.content` when it's a raw string (your prompts; system wrappers like `<system-reminder>` and `<command-name>` are stripped)
- ❌ `thinking`, `tool_use`, `tool_result`

**Codex** — session files at `~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions/`:

- ✅ `event_msg` with `payload.type == "agent_message"` (final/commentary text)
- ✅ `event_msg` with `payload.type == "user_message"`
- ❌ `agent_reasoning`, `exec_command_end`, `patch_apply_end`, `token_count`, `task_started/complete`, `thread_name_updated`, `view_image_tool_call`
- ❌ All `response_item/*` (duplicates of `event_msg/agent_message` for assistants; framework-injected context for users)

## Why `reply msgs` ≫ `you msgs`

One prompt produces **multiple** assistant text blocks because the agent narrates between each tool call:

```
you:       "fix the bug"
assistant: "Let me look at the stack trace first"      ← block 1
           Read(...)
assistant: "Found it — null check missing"             ← block 2
           Edit(...)
assistant: "Running tests now."                        ← block 3
           Bash(...)
assistant: "All 42 pass."                              ← block 4
```

So `reply msgs` counts **how many text chunks you have to read**, not the number of "responses". Expect 3–5× more reply blocks than prompts. The word counts are the real measure of reading and typing volume.

## Privacy

Everything runs locally. No network calls. No data leaves your machine. It only reads files under `~/.claude/` and `~/.codex/` that you already have.

## Performance

By default the last 30 days takes ~2–3 s; `--days 7` runs in under 1 s. File mtime is used to skip irrelevant history without parsing it. `--all` forces a full scan and can take ~10 s depending on archive size.

## Development

```bash
git clone https://github.com/madeyexz/claude-codex-usage.git
cd claude-codex-usage
bun install            # or: npm install
bun run build          # or: npm run build
node dist/index.js --days 7
```

Dependencies are intentionally minimal: [`cli-table3`](https://www.npmjs.com/package/cli-table3) for borders and [`picocolors`](https://www.npmjs.com/package/picocolors) for ANSI.

## License

[MIT](./LICENSE)
