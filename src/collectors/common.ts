// Shared plumbing for the three collectors: config loading, HTTP, small text helpers.
// No scoring or classification lives here — only fetching and cleaning raw fields.
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'yaml';

config({ quiet: true });

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Repository search by topic. Exactly one of created_within_days / pushed_within_days. */
export interface GithubRepoTopic {
  topic: string;
  created_within_days?: number;
  pushed_within_days?: number;
  min_stars: number;
}

/** Quoted-phrase repository search (D1): phrase is quoted and limited to `in`, with a star floor. */
export interface GithubRepoPhrase {
  phrase: string;
  in: string;
  created_within_days: number;
  min_stars: number;
}

/** Issue search with an engagement floor (D2). Exactly one of phrase / label. */
export interface GithubIssueQuery {
  phrase?: string;
  label?: string;
  in?: string;
  state: 'open' | 'closed';
  created_within_days: number;
  min_reactions?: number;
  min_comments?: number;
}

export type HnTag = 'story' | 'show_hn' | 'ask_hn';

export interface HnQuery {
  query: string;
  tag: HnTag;
  title_only?: boolean;
  min_points?: number;
}

export type SoPass = 'unanswered' | 'hot';

export interface SoTagEntry {
  tag: string;
  passes: SoPass[];
}

export interface TargetSources {
  github?: {
    repo_topics?: GithubRepoTopic[];
    repo_phrases?: GithubRepoPhrase[];
    issue_queries?: GithubIssueQuery[];
  };
  hackernews?: { queries?: HnQuery[] };
  stackoverflow?: { tags?: SoTagEntry[]; featured_sitewide?: boolean };
}

export interface Target {
  id: string;
  name: string;
  funnel_step?: string;
  evidence_level?: string;
  sources: TargetSources;
}

export const ECONOMIC_CATEGORIES = [
  'buyer_intent',
  'price_wtp',
  'procurement',
  'commercial_support',
  'hiring_labor',
  'fee_seller',
  'competition',
  'commercialization',
] as const;

export interface Settings {
  max_results_per_query: number;
  max_signals_per_target: number;
  days_back_hn: number;
  days_back_stackoverflow: number;
  min_score_hn: number;
  trending: {
    enabled: boolean;
    hackernews: { days_back: number; min_points: number; max_results: number };
    stackoverflow: { use_hot_endpoint: boolean; max_results: number };
  };
}

export interface WatchConfig {
  watch_targets_version: string;
  watch_targets_date?: string;
  targets: Target[];
  economic_keywords: Record<string, string[]>;
  settings: Settings;
}

const CONFIG_FILE = 'config/watch-targets.yaml';

function fail(where: string, msg: string): never {
  throw new Error(`${CONFIG_FILE}: ${where}: ${msg}`);
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function posNum(where: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(where, `expected a positive number, got ${JSON.stringify(v)}`);
  return v;
}

function nonNegNum(where: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(where, `expected a number >= 0, got ${JSON.stringify(v)}`);
  return v;
}

function nonEmptyStr(where: string, v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) fail(where, `expected a non-empty string, got ${JSON.stringify(v)}`);
  return v;
}

function list(where: string, v: unknown): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(where, 'expected a list');
  return v;
}

/** Fail loudly on a malformed config: a typo here must not silently become an empty query set. */
export function validateConfig(cfg: unknown): WatchConfig {
  if (!isRec(cfg)) fail('root', 'not a mapping');
  nonEmptyStr('watch_targets_version', cfg.watch_targets_version);
  if (!Array.isArray(cfg.targets) || cfg.targets.length === 0) fail('targets', 'no targets defined');
  const ids = new Set<string>();
  for (const [ti, t] of cfg.targets.entries()) {
    const tw = `targets[${ti}]`;
    if (!isRec(t)) fail(tw, 'not a mapping');
    const id = nonEmptyStr(`${tw}.id`, t.id);
    if (ids.has(id)) fail(tw, `duplicate target id "${id}"`);
    ids.add(id);
    nonEmptyStr(`${id}.name`, t.name);
    if (!isRec(t.sources)) fail(`${id}.sources`, 'missing');
    const g = t.sources.github;
    if (g !== undefined) {
      if (!isRec(g)) fail(`${id}.github`, 'not a mapping');
      for (const [i, e] of list(`${id}.github.repo_topics`, g.repo_topics).entries()) {
        const w = `${id}.github.repo_topics[${i}]`;
        if (!isRec(e)) fail(w, 'not a mapping');
        nonEmptyStr(`${w}.topic`, e.topic);
        nonNegNum(`${w}.min_stars`, e.min_stars);
        if ((e.created_within_days === undefined) === (e.pushed_within_days === undefined)) {
          fail(w, 'set exactly one of created_within_days / pushed_within_days');
        }
        posNum(`${w}.window`, e.created_within_days ?? e.pushed_within_days);
      }
      for (const [i, e] of list(`${id}.github.repo_phrases`, g.repo_phrases).entries()) {
        const w = `${id}.github.repo_phrases[${i}]`;
        if (!isRec(e)) fail(w, 'not a mapping');
        nonEmptyStr(`${w}.phrase`, e.phrase);
        nonEmptyStr(`${w}.in`, e.in);
        posNum(`${w}.created_within_days`, e.created_within_days);
        nonNegNum(`${w}.min_stars`, e.min_stars);
      }
      for (const [i, e] of list(`${id}.github.issue_queries`, g.issue_queries).entries()) {
        const w = `${id}.github.issue_queries[${i}]`;
        if (!isRec(e)) fail(w, 'not a mapping');
        if ((e.phrase === undefined) === (e.label === undefined)) fail(w, 'set exactly one of phrase / label');
        if (e.phrase !== undefined) {
          nonEmptyStr(`${w}.phrase`, e.phrase);
          nonEmptyStr(`${w}.in`, e.in);
        } else {
          nonEmptyStr(`${w}.label`, e.label);
        }
        if (e.state !== 'open' && e.state !== 'closed') fail(`${w}.state`, `expected open|closed, got ${JSON.stringify(e.state)}`);
        posNum(`${w}.created_within_days`, e.created_within_days);
        if (e.min_reactions !== undefined) nonNegNum(`${w}.min_reactions`, e.min_reactions);
        if (e.min_comments !== undefined) nonNegNum(`${w}.min_comments`, e.min_comments);
      }
    }
    const hn = t.sources.hackernews;
    if (hn !== undefined) {
      if (!isRec(hn)) fail(`${id}.hackernews`, 'not a mapping');
      for (const [i, e] of list(`${id}.hackernews.queries`, hn.queries).entries()) {
        const w = `${id}.hackernews.queries[${i}]`;
        if (!isRec(e)) fail(w, 'not a mapping');
        nonEmptyStr(`${w}.query`, e.query);
        if (e.tag !== 'story' && e.tag !== 'show_hn' && e.tag !== 'ask_hn') fail(`${w}.tag`, `expected story|show_hn|ask_hn, got ${JSON.stringify(e.tag)}`);
        if (e.min_points !== undefined) nonNegNum(`${w}.min_points`, e.min_points);
      }
    }
    const so = t.sources.stackoverflow;
    if (so !== undefined) {
      if (!isRec(so)) fail(`${id}.stackoverflow`, 'not a mapping');
      for (const [i, e] of list(`${id}.stackoverflow.tags`, so.tags).entries()) {
        const w = `${id}.stackoverflow.tags[${i}]`;
        if (!isRec(e)) fail(w, 'not a mapping');
        nonEmptyStr(`${w}.tag`, e.tag);
        const passes = list(`${w}.passes`, e.passes);
        if (passes.length === 0 || passes.some((p) => p !== 'unanswered' && p !== 'hot')) fail(`${w}.passes`, 'expected a non-empty list of unanswered|hot');
      }
    }
  }
  if (!isRec(cfg.economic_keywords)) fail('economic_keywords', 'missing');
  for (const [cat, kws] of Object.entries(cfg.economic_keywords)) {
    if (!(ECONOMIC_CATEGORIES as readonly string[]).includes(cat)) fail(`economic_keywords.${cat}`, 'unknown category');
    if (!Array.isArray(kws) || kws.some((k) => typeof k !== 'string' || !k.trim())) fail(`economic_keywords.${cat}`, 'expected a list of non-empty strings');
  }
  const s = cfg.settings;
  if (!isRec(s)) fail('settings', 'block missing');
  posNum('settings.max_results_per_query', s.max_results_per_query);
  posNum('settings.max_signals_per_target', s.max_signals_per_target);
  posNum('settings.days_back_hn', s.days_back_hn);
  posNum('settings.days_back_stackoverflow', s.days_back_stackoverflow);
  nonNegNum('settings.min_score_hn', s.min_score_hn);
  const tr = s.trending;
  if (!isRec(tr) || typeof tr.enabled !== 'boolean') fail('settings.trending', 'missing or enabled is not a boolean');
  if (!isRec(tr.hackernews) || !isRec(tr.stackoverflow)) fail('settings.trending', 'hackernews / stackoverflow blocks missing');
  posNum('settings.trending.hackernews.days_back', tr.hackernews.days_back);
  nonNegNum('settings.trending.hackernews.min_points', tr.hackernews.min_points);
  posNum('settings.trending.hackernews.max_results', tr.hackernews.max_results);
  posNum('settings.trending.stackoverflow.max_results', tr.stackoverflow.max_results);
  return cfg as unknown as WatchConfig;
}

export function loadConfig(): WatchConfig {
  const raw = readFileSync(join(ROOT, 'config', 'watch-targets.yaml'), 'utf8');
  return validateConfig(parse(raw));
}

/**
 * D4 per-target cap. Takes one list per query (in config order) and returns up to `cap` unique items,
 * round-robin across the lists so no single query fills the cap. Order inside each list is the source's own
 * sort order — no scoring. `total` is the number of unique items before capping, so callers can log truncation.
 */
export function capRoundRobin<T>(groups: T[][], cap: number, key: (item: T) => string): { kept: T[]; total: number } {
  const all = new Set<string>();
  for (const g of groups) for (const item of g) all.add(key(item));
  const seen = new Set<string>();
  const pos = groups.map(() => 0);
  const kept: T[] = [];
  let progressed = true;
  while (kept.length < cap && progressed) {
    progressed = false;
    for (const [i, g] of groups.entries()) {
      if (kept.length >= cap) break;
      while ((pos[i] ?? 0) < g.length) {
        const item = g[pos[i] ?? 0]!;
        pos[i] = (pos[i] ?? 0) + 1;
        const k = key(item);
        if (seen.has(k)) continue;
        seen.add(k);
        kept.push(item);
        progressed = true;
        break;
      }
    }
  }
  return { kept, total: all.size };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface HttpResult<T> {
  status: number;
  headers: Headers;
  body: T | null;
  error?: string;
}

/** GET a JSON endpoint with a timeout. Never throws — failures come back in `error`. */
export async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<HttpResult<T>> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let body: T | null = null;
    try {
      body = text ? (JSON.parse(text) as T) : null;
    } catch {
      return { status: res.status, headers: res.headers, body: null, error: `non-JSON response (${text.slice(0, 120)})` };
    }
    if (!res.ok) {
      const msg = (body as { message?: string; error_message?: string } | null);
      return { status: res.status, headers: res.headers, body, error: `HTTP ${res.status} ${msg?.message ?? msg?.error_message ?? ''}`.trim() };
    }
    return { status: res.status, headers: res.headers, body };
  } catch (e) {
    return { status: 0, headers: new Headers(), body: null, error: (e as Error).message };
  }
}

export function isoDay(d: Date | string | number): string {
  return new Date(d).toISOString().slice(0, 10);
}

export function daysAgo(n: number, from = new Date()): Date {
  return new Date(from.getTime() - n * 86_400_000);
}

/** Collapse whitespace, strip Markdown-hostile characters, and truncate. */
export function clean(text: string | null | undefined, max = 200): string {
  if (!text) return '';
  const s = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/\|/g, '/').replace(/"/g, "'").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export type CollectionStatus = 'SUCCESS' | 'SOURCE_ERROR' | 'RATE_LIMITED' | 'PARTIAL' | 'FAILED';

export interface CollectionResult {
  status: CollectionStatus;
  pages_requested: number;
  pages_succeeded: number;
  error_class?: string;
}
