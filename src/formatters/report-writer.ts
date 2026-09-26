// Shared Markdown emitter for every collector.
// Owns the report schema and the per-source history diff, so all three sources behave identically.
// It never ranks, scores, labels, or drops a signal.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../collectors/common';

export type Source = 'github' | 'hackernews' | 'stackoverflow';

export interface Signal {
  type: string; // e.g. repo, issue, story, show_hn, unanswered, bounty, hot
  subjects: string[]; // target ids that produced it, or trending:<filter>
  title: string;
  date: string; // YYYY-MM-DD
  metrics: Record<string, number>;
  url: string;
  context: string;
}

export interface ReportInput {
  source: Source;
  runAt: Date;
  keyword: Signal[];
  trending: Signal[];
  raw: string[]; // run log, errors, anything unclassified — always kept
}

export interface ReportResult {
  path: string;
  keywordCount: number;
  trendingCount: number;
  newCount: number;
  recurringCount: number;
}

const REPORTS_DIR = join(ROOT, 'data', 'reports');
// Only these sections hold signals; CHANGES and RAW are excluded from history parsing.
const SIGNAL_SECTIONS = new Set(['NEW SIGNALS', 'TRENDING', 'RECURRING']);

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}`;
}

function stampToLabel(s: string): string {
  return `${s.slice(0, 10)} ${s.slice(11, 13)}:00`;
}

function fmtMetrics(m: Record<string, number>): string {
  const parts = Object.entries(m).map(([k, v]) => `${k}: ${v}`);
  return parts.length ? parts.join(' · ') : 'n/a';
}

/** Merge signals sharing a URL (the same item found by several targets/queries). */
function dedupe(signals: Signal[]): Signal[] {
  const byUrl = new Map<string, Signal>();
  for (const s of signals) {
    const prev = byUrl.get(s.url);
    if (!prev) {
      byUrl.set(s.url, { ...s, subjects: [...s.subjects] });
      continue;
    }
    for (const subj of s.subjects) if (!prev.subjects.includes(subj)) prev.subjects.push(subj);
  }
  return [...byUrl.values()];
}

interface PastReport {
  stamp: string;
  metrics: Map<string, Record<string, number>>; // url -> metrics seen in that report
}

function parseReport(text: string): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  let section = '';
  for (const line of text.split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      section = h[1]!.trim().split(' (')[0]!;
      continue;
    }
    if (!SIGNAL_SECTIONS.has(section) || !line.startsWith('- ')) continue;
    const url = line.match(/\| (https?:\/\/\S+)\s*$/)?.[1];
    if (!url) continue;
    const metrics: Record<string, number> = {};
    // Titles are quoted and have their own quotes replaced, so strip them before reading metrics.
    const unquoted = line.replace(/"[^"]*"/g, '').replace(/first seen: [^|]*/, '');
    for (const m of unquoted.matchAll(/\b([a-z_]+): (-?\d+)\b/g)) {
      if (m[1] !== 'occurrences') metrics[m[1]!] = Number(m[2]);
    }
    out.set(url, { ...out.get(url), ...metrics });
  }
  return out;
}

function loadHistory(source: Source, currentFile: string): PastReport[] {
  const re = new RegExp(`^(\\d{4}-\\d{2}-\\d{2}-\\d{2})-${source}\\.md$`);
  let files: string[] = [];
  try {
    files = readdirSync(REPORTS_DIR);
  } catch {
    return [];
  }
  return files
    .filter((f) => re.test(f) && f !== currentFile)
    .sort()
    .map((f) => ({
      stamp: f.match(re)![1]!,
      metrics: parseReport(readFileSync(join(REPORTS_DIR, f), 'utf8')),
    }));
}

function signalLine(s: Signal): string {
  return `- ${s.type} | ${s.subjects.join(', ')} | "${s.title}" | ${s.date} | ${fmtMetrics(s.metrics)} | ${s.url}`;
}

export function writeReport(input: ReportInput): ReportResult {
  const st = stamp(input.runAt);
  const fileName = `${st}-${input.source}.md`;
  const path = join(REPORTS_DIR, fileName);

  const keyword = dedupe(input.keyword);
  const trending = dedupe(input.trending);
  const history = loadHistory(input.source, fileName);
  const previous = history.at(-1);

  const occurrences = (url: string) => history.filter((h) => h.metrics.has(url));

  const newSignals = keyword.filter((s) => occurrences(s.url).length === 0);
  const allCurrent = dedupe([...keyword, ...trending]);
  const recurring = allCurrent.filter((s) => occurrences(s.url).length > 0);

  const out: string[] = [];
  out.push(`# RADAR REPORT — ${input.source} — ${stampToLabel(st)}`);
  out.push('');
  out.push(
    `run: ${input.runAt.toISOString()} · keyword signals: ${keyword.length} · trending: ${trending.length} · ` +
      `new: ${newSignals.length} · recurring: ${recurring.length} · previous ${input.source} reports: ${history.length}`,
  );
  out.push('');

  out.push('## NEW SIGNALS');
  if (!newSignals.length) out.push('- none this run');
  for (const s of newSignals) {
    out.push(signalLine(s));
    out.push(`  context: ${s.context || 'n/a'}`);
  }
  out.push('');

  out.push('## TRENDING (velocity signals — from trending pass, not keyword match)');
  if (!trending.length) out.push('- none this run');
  for (const s of trending) {
    out.push(signalLine(s));
    out.push(`  context: ${s.context || 'n/a'}`);
  }
  out.push('');

  out.push('## RECURRING (seen in previous reports of this source)');
  if (!recurring.length) out.push(history.length ? '- none this run' : '- no previous reports of this source');
  for (const s of recurring) {
    const seen = occurrences(s.url);
    out.push(
      `- ${s.type} "${s.title}" · ${fmtMetrics(s.metrics)} | occurrences: ${seen.length + 1} | ` +
        `first seen: ${stampToLabel(seen[0]!.stamp)} | ${s.url}`,
    );
  }
  out.push('');

  out.push('## CHANGES SINCE LAST REPORT');
  if (!previous) {
    out.push(`- first ${input.source} report — no baseline to diff against`);
  } else {
    const currentUrls = new Map(allCurrent.map((s) => [s.url, s]));
    const added = allCurrent.filter((s) => !previous.metrics.has(s.url));
    const gone = [...previous.metrics.keys()].filter((u) => !currentUrls.has(u));
    const moved: string[] = [];
    for (const [url, before] of previous.metrics) {
      const now = currentUrls.get(url);
      if (!now) continue;
      const deltas = Object.entries(now.metrics)
        .filter(([k, v]) => before[k] !== undefined && before[k] !== v)
        .map(([k, v]) => `${k} ${before[k]} → ${v}`);
      if (deltas.length) moved.push(`${url} | ${deltas.join(' · ')}`);
    }
    out.push(`- baseline: ${stampToLabel(previous.stamp)}`);
    out.push(`- new: ${added.length}`);
    for (const s of added) out.push(`  - ${s.url}`);
    out.push(`- disappeared: ${gone.length}`);
    for (const u of gone) out.push(`  - ${u}`);
    out.push(`- moved: ${moved.length}`);
    for (const m of moved) out.push(`  - ${m}`);
  }
  out.push('');

  out.push('## RAW / UNCLASSIFIED');
  if (!input.raw.length) out.push('- none');
  for (const r of input.raw) out.push(`- ${r}`);
  out.push('');

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(path, out.join('\n'), 'utf8');

  return {
    path,
    keywordCount: keyword.length,
    trendingCount: trending.length,
    newCount: newSignals.length,
    recurringCount: recurring.length,
  };
}

/** Print a one-line summary and fail the process when a run produced no signals at all. */
export function finish(source: Source, r: ReportResult): void {
  console.log(
    `[${source}] wrote ${r.path} — keyword ${r.keywordCount}, trending ${r.trendingCount}, new ${r.newCount}, recurring ${r.recurringCount}`,
  );
  if (r.keywordCount + r.trendingCount === 0) {
    console.error(`[${source}] ZERO signals collected — treating as failure (see RAW section of the report)`);
    process.exitCode = 1;
  }
}
