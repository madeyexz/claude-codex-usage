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

type Column = {
  key: Key | "date";
  group: "" | "all" | "claude" | "codex";
  name: string;
  width: number;
};

const COLUMNS: Column[] = [
  { key: "date", group: "", name: "date", width: 10 },
  { key: "all_user_msgs", group: "all", name: "you_msgs", width: 10 },
  { key: "all_user_words", group: "all", name: "you_words", width: 11 },
  { key: "all_asst_msgs", group: "all", name: "reply_msgs", width: 11 },
  { key: "all_asst_words", group: "all", name: "reply_words", width: 12 },
  { key: "cc_user_msgs", group: "claude", name: "you_msgs", width: 10 },
  { key: "cc_user_words", group: "claude", name: "you_words", width: 11 },
  { key: "cc_asst_msgs", group: "claude", name: "reply_msgs", width: 11 },
  { key: "cc_asst_words", group: "claude", name: "reply_words", width: 12 },
  { key: "cx_user_msgs", group: "codex", name: "you_msgs", width: 10 },
  { key: "cx_user_words", group: "codex", name: "you_words", width: 11 },
  { key: "cx_asst_msgs", group: "codex", name: "reply_msgs", width: 11 },
  { key: "cx_asst_words", group: "codex", name: "reply_words", width: 12 },
];

const COL_SEP = " ";
const GROUP_SEP = " | ";

function groupColumns(cols: Column[]): Array<[string, Column[]]> {
  const groups: Array<[string, Column[]]> = [];
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

function padLeft(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function padCenter(s: string, w: number): string {
  if (s.length >= w) return s;
  const total = w - s.length;
  const left = Math.floor(total / 2);
  return " ".repeat(left) + s + " ".repeat(total - left);
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function renderRow(cellsByGroup: string[][]): string {
  return cellsByGroup.map((cells) => cells.join(COL_SEP)).join(GROUP_SEP);
}

function headerRows(cols: Column[]): [string, string] {
  const groups = groupColumns(cols);
  const topCells: string[][] = [];
  const botCells: string[][] = [];
  for (const [label, gcols] of groups) {
    const width =
      gcols.reduce((s, c) => s + c.width, 0) +
      (gcols.length - 1) * COL_SEP.length;
    topCells.push([padCenter(label, width)]);
    botCells.push(gcols.map((c) => padLeft(c.name, c.width)));
  }
  return [renderRow(topCells), renderRow(botCells)];
}

function dataRow(cols: Column[], values: Record<string, number | string>): string {
  const groups = groupColumns(cols);
  const byGroup: string[][] = groups.map(([, gcols]) =>
    gcols.map((c) => {
      const v = values[c.key];
      const s = typeof v === "number" ? formatNumber(v) : String(v);
      return padLeft(s, c.width);
    }),
  );
  return renderRow(byGroup);
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
    const header = activeCols.map((c) => (c.group ? `${c.group}_${c.name}` : c.name));
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

  const [top, bot] = headerRows(activeCols);
  const totalWidth = bot.length;

  const totals: Record<string, number> = {};
  for (const c of activeCols.slice(1)) totals[c.key] = 0;

  console.log(top);
  console.log(bot);
  console.log("-".repeat(totalWidth));

  for (const d of days) {
    const b = buckets.get(d)!;
    const row: Record<string, number | string> = { date: d };
    for (const c of activeCols.slice(1)) {
      const v = b[c.key as Key];
      row[c.key] = v;
      totals[c.key]! += v;
    }
    console.log(dataRow(activeCols, row));
  }

  console.log("-".repeat(totalWidth));
  const totalRow: Record<string, number | string> = { date: "TOTAL", ...totals };
  console.log(dataRow(activeCols, totalRow));

  const n = days.length;
  const avgRow: Record<string, number | string> = { date: "AVG/day" };
  for (const c of activeCols.slice(1)) avgRow[c.key] = Math.floor(totals[c.key]! / n);
  console.log(dataRow(activeCols, avgRow));

  console.log(`\nActive days: ${n}`);

  // Which bucket of columns represents the user's total? Primary group (first after date).
  const prefix = args.claudeOnly ? "cc_" : args.codexOnly ? "cx_" : "all_";
  const avgTyped = Math.floor(totals[prefix + "user_words"]! / n);
  const avgRead = Math.floor(totals[prefix + "asst_words"]! / n);

  const typeMin = avgTyped / TYPE_WPM;
  const voiceMin = avgTyped / VOICE_WPM;
  const readMin = avgRead / READ_WPM;

  const tool =
    args.claudeOnly ? "Claude Code" :
    args.codexOnly ? "Codex" :
    "Claude Code + Codex";

  console.log(
    `\nOn an average active day with ${tool}, you type ~${avgTyped.toLocaleString()} ` +
    `words — about ${formatMinutes(typeMin)} at ${TYPE_WPM} WPM typing, ` +
    `or ${formatMinutes(voiceMin)} at ${VOICE_WPM} WPM if dictated. ` +
    `The assistant sends back ~${avgRead.toLocaleString()} words — ` +
    `roughly ${formatMinutes(readMin)} of reading at ${READ_WPM} WPM.`
  );
}

main();
