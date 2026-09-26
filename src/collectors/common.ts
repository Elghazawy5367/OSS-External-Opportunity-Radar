// Shared plumbing for the three collectors: config loading, HTTP, small text helpers.
// No scoring or classification lives here — only fetching and cleaning raw fields.
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'yaml';

config({ quiet: true });

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface TargetSources {
  github_topics?: string[];
  github_search_queries?: string[];
  keywords?: string[];
  stackoverflow_tags?: string[];
}

export interface Target {
  id: string;
  name: string;
  evidence_level?: string;
  sources: TargetSources;
}

export interface Settings {
  max_results_per_query: number;
  days_back_github: number;
  days_back_hn: number;
  days_back_stackoverflow: number;
  min_stars_fork_watch: number;
  min_score_hn: number;
  trending: {
    enabled: boolean;
    github: { sort_by: string; created_within_days: number; min_stars: number; topics_filter: string[] };
    hackernews: { min_points: number; max_results: number };
    stackoverflow: { use_hot_endpoint: boolean; max_results: number };
  };
}

export interface WatchConfig {
  targets: Target[];
  settings: Settings;
}

export function loadConfig(): WatchConfig {
  const raw = readFileSync(join(ROOT, 'config', 'watch-targets.yaml'), 'utf8');
  const cfg = parse(raw) as WatchConfig;
  if (!Array.isArray(cfg?.targets) || cfg.targets.length === 0) {
    throw new Error('config/watch-targets.yaml: no targets defined');
  }
  if (!cfg.settings) throw new Error('config/watch-targets.yaml: settings block missing');
  return cfg;
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
