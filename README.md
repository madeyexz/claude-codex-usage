# claude-codex-usage

Per-day word and message counts across your local Claude Code and Codex CLI sessions.

Counts **only the text you actually read and type** — skips assistant reasoning/thinking, tool calls, code written via Edit/Write, and tool results.

## Quick start

```sh
bunx claude-codex-usage
# or
npx claude-codex-usage
```

## Usage

```
claude-codex-usage [--days N | --since YYYY-MM-DD | --all]
                   [--claude-only | --codex-only] [--csv]
```

Options:

- `--days N` — only show the last N days (default: **30**)
- `--since YYYY-MM-DD` — only show activity on or after that date
- `--all` — show full history (slower; scans every session file)
- `--claude-only` — only include Claude Code sessions
- `--codex-only` — only include Codex sessions
- `--csv` — emit CSV (for spreadsheets, charts, etc.)

By default only the last 30 days are scanned. Use `--all` for the full history.

## Sample output

```
           |                       all                       |                     claude                      |                      codex                     
      date |   you_msgs   you_words  reply_msgs  reply_words |   you_msgs   you_words  reply_msgs  reply_words |   you_msgs   you_words  reply_msgs  reply_words
----------------------------------------------------------------------------------------------------------------------------------------------------------------
2026-04-19 |         61       2,533         248       16,802 |         39       1,513         110        8,078 |         22       1,020         138        8,724
...
   AVG/day |        150      15,650         606       61,180 |         66       3,866         207       22,610 |         84      11,784         399       38,570
```

## What counts

**Claude Code** — session files at `~/.claude/projects/<project>/<session>.jsonl`:

- ✓ `assistant.content[]` blocks where `type == "text"`
- ✓ `user.content` when it's a raw string (wrappers like `<system-reminder>`, `<command-name>`, `<local-command-stdout>`, `Caveat: ...` are stripped)
- ✗ `thinking`, `tool_use`, `tool_result`

**Codex** — session files at `~/.codex/sessions/**/rollout-*.jsonl` and `~/.codex/archived_sessions/**/*.jsonl`:

- ✓ `event_msg` with `payload.type == "agent_message"`
- ✓ `event_msg` with `payload.type == "user_message"`
- ✗ `agent_reasoning`, `exec_command_end`, `patch_apply_end`, `token_count`, `task_started/complete`, `thread_name_updated`, `view_image_tool_call`
- ✗ All `response_item/*` (duplicates of `event_msg/agent_message` for assistants; framework-injected context for users)

## Development

```sh
npm install
npm run build
node dist/index.js --days 7
```

## License

MIT
