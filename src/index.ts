#!/usr/bin/env node
/**
 * Per-day word + message counts for Claude Code and Codex CLI sessions.
 *
 * Claude Code logs: ~/.claude/projects/<project>/<session>.jsonl
 * Codex logs:       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *                   ~/.codex/archived_sessions/.../rollout-*.jsonl
 *
 * Counts only text the user actually reads/types:
 *   - Claude Code: assistant `text` blocks (skip `thinking`, `tool_use`);
 *                  user string content (skip tool_result, strip system wrappers).
 *   - Codex:       event_msg/agent_message and event_msg/user_message
 *                  (skip agent_reasoning, exec_command_end, token_count, etc.).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import Table from "cli-table3";
import pc from "picocolors";

const HOME = os.homedir();
const CC_ROOT = path.join(HOME, ".claude", "projects");
const CX_SESSIONS = path.join(HOME, ".codex", "sessions");
const CX_ARCHIVED = path.join(HOME, ".codex", "archived_sessions");

const SYSTEM_TAG_RE =
  /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr|stdout|stderr)>[\s\S]*?<\/\1>/g;
const CAVEAT_RE = /Caveat: [\s\S]*?(?=\n\n|$)/g;

function wordCount(s: string): number {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
}

function cleanCcUser(s: string): string {
  return s.replace(SYSTEM_TAG_RE, "").replace(CAVEAT_RE, "").trim();
}

/** UTC midnight of the given YYYY-MM-DD, in unix ms. */
function dayToMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** Fast mtime check. Returns true if file was modified on or after cutoffMs, OR if stat fails. */
function isAfter(file: string, cutoffMs: number | null): boolean {
  if (cutoffMs === null) return true;
  try {
    return fs.statSync(file).mtimeMs >= cutoffMs;
  } catch {
    return true;
  }
}

/**
 * Yield .jsonl files at exactly `dirDepth` directory levels below `root`.
 * dirDepth=0 → files directly in root.
 * dirDepth=1 → files in root/<anything>/.
 * This matches glob patterns like root/*\/\*.jsonl (dirDepth=1) without picking up
 * deeper nested internal logs (subagent transcripts, tool-results, etc.).
 */
function* jsonlAtDepth(root: string, dirDepth: number): Iterable<string> {
  if (!fs.existsSync(root)) return;
  // BFS: expand exactly `dirDepth` levels of dirs, then yield .jsonl children.
  let current: string[] = [root];
  for (let level = 0; level < dirDepth; level++) {
    const next: string[] = [];
    for (const dir of current) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory()) next.push(path.join(dir, e.name));
      }
    }
    current = next;
  }
  for (const dir of current) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) {
        yield path.join(dir, e.name);
      }
    }
  }
}

/** Yield every .jsonl file under root, at any depth. */
function* jsonlRecursive(root: string): Iterable<string> {
  if (!fs.existsSync(root)) return;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && p.endsWith(".jsonl")) yield p;
    }
  }
}

type Key =
  | "cc_user_msgs"
  | "cc_user_words"
  | "cc_asst_msgs"
  | "cc_asst_words"
  | "cx_user_msgs"
  | "cx_user_words"
  | "cx_asst_msgs"
  | "cx_asst_words"
  | "all_user_msgs"
  | "all_user_words"
  | "all_asst_msgs"
  | "all_asst_words";

type Bucket = Record<Key, number>;

function emptyBucket(): Bucket {
  return {
    cc_user_msgs: 0,
    cc_user_words: 0,
    cc_asst_msgs: 0,
    cc_asst_words: 0,
    cx_user_msgs: 0,
    cx_user_words: 0,
    cx_asst_msgs: 0,
    cx_asst_words: 0,
    all_user_msgs: 0,
    all_user_words: 0,
    all_asst_msgs: 0,
    all_asst_words: 0,
  };
}

function getBucket(buckets: Map<string, Bucket>, day: string): Bucket {
  let b = buckets.get(day);
  if (!b) {
    b = emptyBucket();
    buckets.set(day, b);
  }
  return b;
}

function readLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n");
}

function scanClaudeCode(
  buckets: Map<string, Bucket>,
  cutoffMs: number | null,
): void {
  // ~/.claude/projects/<project>/<session>.jsonl — one dir level between root and file.
  // Deeper nested .jsonl files (subagent transcripts, tool-results) are skipped.
  for (const file of jsonlAtDepth(CC_ROOT, 1)) {
    if (!isAfter(file, cutoffMs)) continue;
    let lines: string[];
    try {
      lines = readLines(file);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const ts: string = d.timestamp || "";
      const day = ts.slice(0, 10);
      if (!day) continue;
      const t = d.type;
      if (t === "assistant") {
        const content = d.message?.content ?? [];
        let hadText = false;
        let words = 0;
        for (const c of content) {
          if (c && c.type === "text") {
            const txt: string = c.text || "";
            if (txt.trim()) {
              words += wordCount(txt);
              hadText = true;
            }
          }
        }
        if (hadText) {
          const b = getBucket(buckets, day);
          b.cc_asst_words += words;
          b.cc_asst_msgs += 1;
        }
      } else if (t === "user") {
        const content = d.message?.content;
        if (typeof content === "string") {
          const cleaned = cleanCcUser(content);
          if (cleaned) {
            const b = getBucket(buckets, day);
            b.cc_user_words += wordCount(cleaned);
            b.cc_user_msgs += 1;
          }
        }
      }
    }
  }
}

function scanCodex(
  buckets: Map<string, Bucket>,
  cutoffMs: number | null,
): void {
  // ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — 3 dir levels (path encodes session
  // START date, not message date — a session started on day N can contain events from
  // day N+k, so we can't prune directories by path. mtime filtering is correct: a file
  // with recent activity has recent mtime regardless of start date.)
  // ~/.codex/archived_sessions/**/rollout-*.jsonl — recursive.
  const files = [
    ...jsonlAtDepth(CX_SESSIONS, 3),
    ...jsonlRecursive(CX_ARCHIVED),
  ];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!isAfter(file, cutoffMs)) continue;
    {
      let lines: string[];
      try {
        lines = readLines(file);
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!line) continue;
        let d: any;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        if (d.type !== "event_msg") continue;
        const ts: string = d.timestamp || "";
        const day = ts.slice(0, 10);
        if (!day) continue;
        const p = d.payload ?? {};
        const pt = p.type;
        const msg = ((p.message as string) ?? "").trim();
        if (!msg) continue;
        const b = getBucket(buckets, day);
        if (pt === "agent_message") {
          b.cx_asst_words += wordCount(msg);
          b.cx_asst_msgs += 1;
        } else if (pt === "user_message") {
          b.cx_user_words += wordCount(msg);
          b.cx_user_msgs += 1;
        }
      }
    }
  }
}

// --- formatting ---

type Group = "" | "all" | "claude" | "codex";

type Column = {
  key: Key | "date";
  group: Group;
  name: string;
};

const COLUMNS: Column[] = [
  { key: "date",           group: "",       name: "date" },
  { key: "all_user_msgs",  group: "all",    name: "you msgs" },
  { key: "all_user_words", group: "all",    name: "you words" },
  { key: "all_asst_msgs",  group: "all",    name: "reply msgs" },
  { key: "all_asst_words", group: "all",    name: "reply words" },
  { key: "cc_user_msgs",   group: "claude", name: "you msgs" },
  { key: "cc_user_words",  group: "claude", name: "you words" },
  { key: "cc_asst_msgs",   group: "claude", name: "reply msgs" },
  { key: "cc_asst_words",  group: "claude", name: "reply words" },
  { key: "cx_user_msgs",   group: "codex",  name: "you msgs" },
  { key: "cx_user_words",  group: "codex",  name: "you words" },
  { key: "cx_asst_msgs",   group: "codex",  name: "reply msgs" },
  { key: "cx_asst_words",  group: "codex",  name: "reply words" },
];

function groupColumns(cols: Column[]): Array<[Group, Column[]]> {
  const groups: Array<[Group, Column[]]> = [];
  let i = 0;
  while (i < cols.length) {
    const label = cols[i]!.group;
    let j = i;
    while (j < cols.length && cols[j]!.group === label) j++;
    groups.push([label, cols.slice(i, j)]);
    i = j;
  }
  return groups;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Build the cli-table3 table for the daily breakdown. */
function buildTable(
  activeCols: Column[],
  days: string[],
  buckets: Map<string, Bucket>,
): { output: string; totals: Record<string, number> } {
  const groups = groupColumns(activeCols);
  const dataGroups = groups.slice(1); // skip the "date" group

  const table = new Table({
    chars: {
      top: "─", "top-mid": "┬", "top-left": "┌", "top-right": "┐",
      bottom: "─", "bottom-mid": "┴", "bottom-left": "└", "bottom-right": "┘",
      left: "│", "left-mid": "├", mid: "─", "mid-mid": "┼",
      right: "│", "right-mid": "┤", middle: "│",
    },
    style: { "padding-left": 1, "padding-right": 1, head: [], border: [] },
  });

  // Header row 1: "date" rowSpan-2 + group labels colspan.
  const head1: any[] = [
    { content: pc.bold("date"), rowSpan: 2, vAlign: "center", hAlign: "center" },
  ];
  for (const [label, gcols] of dataGroups) {
    head1.push({
      content: pc.bold(label),
      colSpan: gcols.length,
      hAlign: "center",
    });
  }
  // Header row 2: column names (the date cell is covered by the rowSpan).
  const head2: any[] = [];
  for (const [, gcols] of dataGroups) {
    for (const c of gcols) head2.push({ content: pc.dim(c.name), hAlign: "right" });
  }

  table.push(head1, head2);

  const totals: Record<string, number> = {};
  for (const c of activeCols.slice(1)) totals[c.key] = 0;

  for (const day of days) {
    const b = buckets.get(day)!;
    const row: any[] = [day];
    for (const [, gcols] of dataGroups) {
      for (const c of gcols) {
        const v = b[c.key as Key];
        totals[c.key]! += v;
        row.push({ content: formatNumber(v), hAlign: "right" });
      }
    }
    table.push(row);
  }

  const n = days.length;
  const footerRow = (label: string, value: (k: string) => number) => {
    const row: any[] = [{ content: pc.bold(pc.dim(label)), hAlign: "center" }];
    for (const [, gcols] of dataGroups) {
      for (const c of gcols) {
        row.push({ content: pc.dim(formatNumber(value(c.key))), hAlign: "right" });
      }
    }
    return row;
  };

  table.push(footerRow("TOTAL", (k) => totals[k]!));
  table.push(footerRow("AVG/day", (k) => Math.floor(totals[k]! / n)));

  return { output: table.toString(), totals };
}

// --- CLI ---

type CliArgs = {
  days?: number;
  since?: string;
  csv: boolean;
  claudeOnly: boolean;
  codexOnly: boolean;
  all: boolean;
  help: boolean;
};

function parseCli(): CliArgs {
  const { values } = parseArgs({
    options: {
      days: { type: "string" },
      since: { type: "string" },
      all: { type: "boolean", default: false },
      csv: { type: "boolean", default: false },
      "claude-only": { type: "boolean", default: false },
      "codex-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  return {
    days: values.days ? Number(values.days) : undefined,
    since: values.since as string | undefined,
    all: Boolean(values.all),
    csv: Boolean(values.csv),
    claudeOnly: Boolean(values["claude-only"]),
    codexOnly: Boolean(values["codex-only"]),
    help: Boolean(values.help),
  };
}

const HELP = `claude-codex-usage — per-day word + message counts for Claude Code and Codex

Usage:
  claude-codex-usage [--days N | --since YYYY-MM-DD | --all]
                     [--claude-only | --codex-only] [--csv]

Time range (default: --days 30):
  --days N           Only show the last N days
  --since DATE       Only show activity on or after DATE (YYYY-MM-DD)
  --all              Show the full history (may be slow on large archives)

Tool selection:
  --claude-only      Only include Claude Code sessions
  --codex-only       Only include Codex sessions

Output:
  --csv              Emit CSV instead of a formatted table
  -h, --help         Show this help
`;

const DEFAULT_DAYS = 30;

function utcDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

const TYPE_WPM = 80;
const VOICE_WPM = 100;
const READ_WPM = 250;

function formatMinutes(mins: number): string {
  if (mins < 1) return `${Math.round(mins * 60)}s`;
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function main() {
  const args = parseCli();
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  if (args.claudeOnly && args.codexOnly) {
    process.stderr.write("--claude-only and --codex-only are mutually exclusive.\n");
    process.exit(2);
  }

  // Resolve cutoff: since > days > default(30). --all clears it.
  let cutoffDay: string | null;
  if (args.all) cutoffDay = null;
  else if (args.since) cutoffDay = args.since;
  else cutoffDay = utcDaysAgo((args.days ?? DEFAULT_DAYS) - 1);
  const cutoffMs = cutoffDay ? dayToMs(cutoffDay) : null;

  const buckets = new Map<string, Bucket>();
  if (!args.codexOnly) scanClaudeCode(buckets, cutoffMs);
  if (!args.claudeOnly) scanCodex(buckets, cutoffMs);

  for (const b of buckets.values()) {
    b.all_user_msgs = b.cc_user_msgs + b.cx_user_msgs;
    b.all_user_words = b.cc_user_words + b.cx_user_words;
    b.all_asst_msgs = b.cc_asst_msgs + b.cx_asst_msgs;
    b.all_asst_words = b.cc_asst_words + b.cx_asst_words;
  }

  let days = [...buckets.keys()].sort();
  if (cutoffDay) days = days.filter((d) => d >= cutoffDay);

  // Drop groups that weren't scanned (the `all` group is redundant when only one is active).
  const activeCols = COLUMNS.filter((c) => {
    if (args.claudeOnly) return c.group === "" || c.group === "claude";
    if (args.codexOnly) return c.group === "" || c.group === "codex";
    return true;
  });

  if (args.csv) {
    const slug = (s: string) => s.replace(/\s+/g, "_");
    const header = activeCols.map((c) => (c.group ? `${c.group}_${slug(c.name)}` : slug(c.name)));
    process.stdout.write(header.map(csvEscape).join(",") + "\n");
    for (const d of days) {
      const b = buckets.get(d)!;
      const row = [d, ...activeCols.slice(1).map((c) => String(b[c.key as Key]))];
      process.stdout.write(row.map(csvEscape).join(",") + "\n");
    }
    return;
  }

  if (days.length === 0) {
    process.stderr.write("No Claude Code or Codex sessions found in range.\n");
    process.exit(1);
  }

  const { output, totals } = buildTable(activeCols, days, buckets);
  console.log(output);

  // Active days: n / m (m = days in requested window; omitted for --all).
  const n = days.length;
  let windowDays: number | null = null;
  if (!args.all) {
    if (args.since) {
      const today = utcDaysAgo(0);
      const sinceMs = dayToMs(args.since);
      const todayMs = dayToMs(today);
      windowDays = Math.floor((todayMs - sinceMs) / 86_400_000) + 1;
    } else {
      windowDays = args.days ?? DEFAULT_DAYS;
    }
  }
  const denom = windowDays ? ` / ${windowDays}` : "";
  console.log(`\n${pc.bold("Active days")}: ${n}${denom}`);

  // Summary paragraph — uses the primary (first) data group.
  const prefix = args.claudeOnly ? "cc_" : args.codexOnly ? "cx_" : "all_";
  const avgTyped = Math.floor(totals[prefix + "user_words"]! / n);
  const avgRead = Math.floor(totals[prefix + "asst_words"]! / n);

  const tool =
    args.claudeOnly ? "Claude Code" :
    args.codexOnly ? "Codex" :
    "Claude Code + Codex";

  console.log(
    `\nOn an average active day with ${pc.bold(tool)}, you type ` +
    `~${pc.yellow(avgTyped.toLocaleString())} words — about ` +
    `${pc.cyan(formatMinutes(avgTyped / TYPE_WPM))} at ${TYPE_WPM} WPM typing, or ` +
    `${pc.cyan(formatMinutes(avgTyped / VOICE_WPM))} at ${VOICE_WPM} WPM if dictated. ` +
    `The assistant sends back ~${pc.yellow(avgRead.toLocaleString())} words — ` +
    `roughly ${pc.cyan(formatMinutes(avgRead / READ_WPM))} of reading at ${READ_WPM} WPM.`,
  );
}

main();
