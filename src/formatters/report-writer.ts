import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, type CollectionResult, type CollectionStatus, type Target } from '../collectors/common';

export type Source = 'github' | 'hackernews' | 'stackoverflow';

export interface Signal {
  type: string;
  subjects: string[];
  title: string;
  date: string;
  date_type?: string;
  metrics: Record<string, number>;
  url: string;
  context: string;
}

export interface ReportInput {
  source: Source;
  runAt: Date;
  keyword: Signal[];
  trending: Signal[];
  raw: string[];
  collection: CollectionResult;
}

export interface ReportResult {
  path: string;
  keywordCount: number;
  trendingCount: number;
  newCount: number;
  recurringCount: number;
  written: boolean;
}

const REPORTS_DIR = join(ROOT, 'data', 'reports');
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

function safeFilename(base: string): string {
  if (!existsSync(base)) return base;
  let n = 1;
  while (existsSync(base.replace('.md', `-rerun-${n}.md`))) n++;
  return base.replace('.md', `-rerun-${n}.md`);
}

interface PastReport {
  stamp: string;
  metrics: Map<string, Record<string, number>>;
}

function parseReport(text: string): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  let section = '';
  for (const line of text.split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      section = h[1]!.trim().split(' (')[0]!.split(' — ')[0]!;
      continue;
    }
    if (!SIGNAL_SECTIONS.has(section) || !line.startsWith('- ')) continue;
    const url = line.match(/\| (https?:\/\/\S+)\s*$/)?.[1];
    if (!url) continue;
    const metrics: Record<string, number> = {};
    const unquoted = line.replace(/"[^"]*"/g, '').replace(/first seen: [^|]*/, '');
    for (const m of unquoted.matchAll(/\b([a-z_]+): (-?\d+)\b/g)) {
      if (m[1] !== 'occurrences') metrics[m[1]!] = Number(m[2]);
    }
    out.set(url, { ...out.get(url), ...metrics });
  }
  return out;
}

function loadHistory(source: Source, currentFile: string): PastReport[] {
  const re = new RegExp(`^(\\d{4}-\\d{2}-\\d{2}-\\d{2})-${source}(-rerun-\\d+)?\\.md$`);
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

function collectorVersion(): string {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch { return 'unknown'; }
}

function watchTargetsVersion(): string {
  try {
    return statSync(join(ROOT, 'config', 'watch-targets.yaml')).mtime.toISOString().slice(0, 10);
  } catch { return 'unknown'; }
}

export function writeReport(input: ReportInput): ReportResult {
  const st = stamp(input.runAt);
  const baseFileName = `${st}-${input.source}.md`;
  const basePath = join(REPORTS_DIR, baseFileName);
  const path = safeFilename(basePath);
  const actualFileName = path.split(/[/\\]/).pop()!;

  const keyword = dedupe(input.keyword);
  const trending = dedupe(input.trending);
  const history = loadHistory(input.source, actualFileName);
  const previous = history.at(-1);
  const occurrences = (url: string) => history.filter((h) => h.metrics.has(url));

  const newSignals = keyword.filter((s) => occurrences(s.url).length === 0);
  const allCurrent = dedupe([...keyword, ...trending]);
  const recurring = allCurrent.filter((s) => occurrences(s.url).length > 0);

  const hasSignals = keyword.length + trending.length > 0;
  if (!hasSignals && input.collection.status !== 'SUCCESS') {
    return { path, keywordCount: keyword.length, trendingCount: trending.length, newCount: newSignals.length, recurringCount: recurring.length, written: false };
  }

  const out: string[] = [];
  out.push(`# RADAR REPORT — ${input.source} — ${stampToLabel(st)}`);
  out.push('');
  out.push('```');
  out.push(`run_time: ${input.runAt.toISOString()}`);
  out.push(`source: ${input.source}`);
  out.push(`collection_status: ${input.collection.status}`);
  out.push(`signals_found: ${keyword.length + trending.length}`);
  out.push(`pages_requested: ${input.collection.pages_requested}`);
  out.push(`pages_succeeded: ${input.collection.pages_succeeded}`);
  out.push(`watch_targets_version: ${watchTargetsVersion()}`);
  out.push(`collector_version: ${collectorVersion()}`);
  out.push('```');
  out.push('');
  out.push(
    `run: ${input.runAt.toISOString()} · keyword signals: ${keyword.length} · trending: ${trending.length} · ` +
      `new: ${newSignals.length} · recurring: ${recurring.length} · previous ${input.source} reports: ${history.length}`,
  );
  out.push('');

  const targetGroups = new Map<string, Signal[]>();
  for (const s of newSignals) {
    const target = s.subjects[0] ?? 'uncategorized';
    if (!targetGroups.has(target)) targetGroups.set(target, []);
    targetGroups.get(target)!.push(s);
  }
  if (targetGroups.size === 0) {
    out.push('## NEW SIGNALS');
    out.push('- No signals found in this window');
    out.push('');
  } else {
    for (const [target, signals] of targetGroups) {
      out.push(`## NEW SIGNALS — ${target}`);
      for (const s of signals) {
        out.push(signalLine(s));
        out.push(`  context: ${s.context || 'n/a'}`);
      }
      out.push('');
    }
  }

  out.push('## TRENDING (velocity signals — from trending pass, not keyword match)');
  if (!trending.length) out.push('- No signals found in this window');
  for (const s of trending) {
    out.push(signalLine(s));
    out.push(`  context: ${s.context || 'n/a'}`);
  }
  out.push('');

  out.push('## RECURRING (seen in previous reports of this source)');
  if (!recurring.length) out.push(history.length ? '- No signals found in this window' : '- no previous reports of this source');
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

  return { path, keywordCount: keyword.length, trendingCount: trending.length, newCount: newSignals.length, recurringCount: recurring.length, written: true };
}

// ─── ECONOMIC PASS ──────────────────────────────────────────────────────────

const CATEGORY_SIGNAL_TYPE: Record<string, string> = {
  buyer_intent: 'BUYER',
  price_wtp: 'PRICE',
  procurement: 'PROCUREMENT_STAGE',
  commercial_support: 'OFFER',
  hiring_labor: 'BUYER',
  fee_seller: 'PRICE',
  competition: 'SUPPLY_INTENSITY',
  commercialization: 'COMMERCIAL_INTENT',
};

const CATEGORY_FIELD_TIER: Record<string, string> = {
  buyer_intent: 'buyer_tier',
  price_wtp: 'price_tier',
  procurement: 'procurement_tier',
  commercial_support: 'seller_tier',
  hiring_labor: 'buyer_tier',
  fee_seller: 'seller_tier',
  competition: 'intent_tier',
  commercialization: 'intent_tier',
};

const MONETARY_RE = /\$\d|€\d|\d+\s*(usd|eur|gbp|per month|per year|\/mo|\/yr|\/month|\/year)/i;

function detectMonetaryValue(text: string): boolean {
  return MONETARY_RE.test(text);
}

function detectAmountType(text: string): string | undefined {
  if (!detectMonetaryValue(text)) return undefined;
  const lower = text.toLowerCase();
  if (/\bstarting\b|\bfrom\s+\$|\bbase\s+price\b|\bminimum\b/.test(lower)) return 'BASE';
  if (/\bup\s+to\b|\bmaximum\b|\bceiling\b|\bcap\b/.test(lower)) return 'CEILING';
  if (/\bawarded\b|\bcontract\s+value\b/.test(lower)) return 'AWARDED';
  if (/\bquoted?\b/.test(lower)) return 'QUOTED';
  if (/\blisted\b|\basking\b/.test(lower)) return 'LISTED';
  return 'ESTIMATED';
}

interface EconomicMatch {
  signal: Signal;
  matched_categories: Map<string, string[]>;
  signal_type: string;
  evidence_tier: string;
  per_field_tiers: Record<string, string>;
  amount_type?: string;
}

function findEconomicMatches(signals: Signal[], targets: Target[]): EconomicMatch[] {
  const allKeywords = new Map<string, string[]>();
  for (const t of targets) {
    for (const [category, keywords] of Object.entries(t.economic_keywords ?? {})) {
      const existing = allKeywords.get(category) ?? [];
      for (const kw of keywords) {
        if (!existing.includes(kw.toLowerCase())) existing.push(kw.toLowerCase());
      }
      allKeywords.set(category, existing);
    }
  }

  const matches: EconomicMatch[] = [];
  for (const s of signals) {
    const text = `${s.title} ${s.context}`.toLowerCase();
    const matchedCategories = new Map<string, string[]>();

    for (const [category, keywords] of allKeywords) {
      const matched = keywords.filter((kw) => text.includes(kw));
      if (matched.length > 0) matchedCategories.set(category, matched);
    }

    if (matchedCategories.size === 0) continue;

    const firstCategory = [...matchedCategories.keys()][0]!;
    const signalType = CATEGORY_SIGNAL_TYPE[firstCategory] ?? 'COMMERCIAL_INTENT';

    const perFieldTiers: Record<string, string> = {};
    for (const category of matchedCategories.keys()) {
      const fieldName = CATEGORY_FIELD_TIER[category];
      if (fieldName) {
        const hasMoney = (category === 'price_wtp' || category === 'fee_seller') && detectMonetaryValue(text);
        const tier = hasMoney ? 'E3' : 'E1';
        const prev = perFieldTiers[fieldName];
        if (!prev || parseInt(tier.slice(1)) > parseInt(prev.slice(1))) {
          perFieldTiers[fieldName] = tier;
        }
      }
    }

    const tierValues = Object.values(perFieldTiers).map((t) => parseInt(t.slice(1)));
    const evidenceTier = tierValues.length > 0 ? `E${Math.min(...tierValues)}` : 'E1';

    matches.push({
      signal: s,
      matched_categories: matchedCategories,
      signal_type: signalType,
      evidence_tier: evidenceTier,
      per_field_tiers: perFieldTiers,
      amount_type: detectAmountType(text),
    });
  }

  return matches;
}

function economicSignalLine(m: EconomicMatch): string {
  const perField = Object.entries(m.per_field_tiers)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
  const matchedKws = [...m.matched_categories.values()]
    .flat()
    .map((k) => `"${k}"`)
    .join(', ');
  const amountStr = m.amount_type ? ` | amount_type: ${m.amount_type}` : '';
  return `- ${m.signal_type} | ${m.evidence_tier} | ${perField} | "${m.signal.title}" | ${m.signal.date} | matched: ${matchedKws}${amountStr} | ${m.signal.url}`;
}

export function writeEconomicReport(input: ReportInput, targets: Target[]): ReportResult {
  const st = stamp(input.runAt);
  const baseFileName = `${st}-${input.source}-economic.md`;
  const basePath = join(REPORTS_DIR, baseFileName);
  const path = safeFilename(basePath);

  const allSignals = dedupe([...input.keyword, ...input.trending]);
  const matches = findEconomicMatches(allSignals, targets);

  const hasSignals = matches.length > 0;
  if (!hasSignals && input.collection.status !== 'SUCCESS') {
    return { path, keywordCount: 0, trendingCount: 0, newCount: 0, recurringCount: 0, written: false };
  }

  const out: string[] = [];
  out.push(`# ECONOMIC REPORT — ${input.source} — ${stampToLabel(st)}`);
  out.push('');
  out.push('```');
  out.push(`run_time: ${input.runAt.toISOString()}`);
  out.push(`source: ${input.source}`);
  out.push(`collection_status: ${input.collection.status}`);
  out.push(`economic_signals_found: ${matches.length}`);
  out.push(`observation_signals_scanned: ${allSignals.length}`);
  out.push(`pages_requested: ${input.collection.pages_requested}`);
  out.push(`pages_succeeded: ${input.collection.pages_succeeded}`);
  out.push(`watch_targets_version: ${watchTargetsVersion()}`);
  out.push(`collector_version: ${collectorVersion()}`);
  out.push('```');
  out.push('');
  out.push(
    `run: ${input.runAt.toISOString()} · economic signals: ${matches.length} · observation signals scanned: ${allSignals.length}`,
  );
  out.push('');

  out.push('## OBSERVED');
  out.push('');
  if (matches.length === 0) {
    out.push('No economic signals found in this window.');
    out.push('');
  } else {
    const byType = new Map<string, EconomicMatch[]>();
    for (const m of matches) {
      if (!byType.has(m.signal_type)) byType.set(m.signal_type, []);
      byType.get(m.signal_type)!.push(m);
    }
    for (const [signalType, typeMatches] of byType) {
      out.push(`### ${signalType}`);
      for (const m of typeMatches) {
        out.push(economicSignalLine(m));
        out.push(`  context: ${m.signal.context || 'n/a'}`);
      }
      out.push('');
    }
  }

  out.push('## MODELED');
  out.push('No modeled signals in collection output.');
  out.push('');

  out.push('## RAW / UNCLASSIFIED');
  if (!input.raw.length) out.push('- none');
  for (const r of input.raw) out.push(`- ${r}`);
  out.push('');

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(path, out.join('\n'), 'utf8');

  return { path, keywordCount: matches.length, trendingCount: 0, newCount: matches.length, recurringCount: 0, written: true };
}

export function finish(source: Source, r: ReportResult, status: CollectionStatus): void {
  if (!r.written) {
    console.error(`[${source}] collection ${status} — report suppressed`);
    process.exitCode = 1;
    return;
  }
  const statusNote = status !== 'SUCCESS' ? ` (${status})` : '';
  console.log(
    `[${source}] wrote ${r.path}${statusNote} — keyword ${r.keywordCount}, trending ${r.trendingCount}, new ${r.newCount}, recurring ${r.recurringCount}`,
  );
}
