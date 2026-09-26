// hn-collector — raw signals from the Hacker News Algolia API (no auth).
// Keyword pass: per target keyword, stories newest-first within days_back_hn and >= min_score_hn.
// Trending pass: highest-point stories in the same window, no keyword filter.
// Run: npx tsx src/collectors/hn-collector.ts
import { clean, daysAgo, decodeEntities, getJson, isoDay, loadConfig, sleep } from './common';
import { finish, writeReport, type Signal } from '../formatters/report-writer';

interface Hit {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at_i: number;
  story_text: string | null;
  _tags: string[];
}

interface SearchResponse {
  nbHits: number;
  hits: Hit[];
}

const API = 'https://hn.algolia.com/api/v1';
const raw: string[] = [];
let calls = 0;

// typoTolerance=false stops "n8n" matching "non"/"nin" (observed live 2026-09-24).
// queryType=prefixNone is meant to stop "ai" prefix-matching "air"; its effect was NOT confirmed live.
async function query(endpoint: 'search' | 'search_by_date', params: Record<string, string>, label: string): Promise<Hit[]> {
  const qs = new URLSearchParams({ tags: 'story', typoTolerance: 'false', queryType: 'prefixNone', ...params });
  if (calls > 0) await sleep(250);
  calls++;
  const res = await getJson<SearchResponse>(`${API}/${endpoint}?${qs}`);
  if (res.error || !res.body) {
    raw.push(`error ${label}: ${res.error ?? 'empty body'}`);
    return [];
  }
  raw.push(`${label} → ${res.body.hits.length} of ${res.body.nbHits}`);
  return res.body.hits;
}

function hitSignal(h: Hit, subject: string): Signal {
  const tags = h._tags ?? [];
  const type = tags.includes('show_hn') ? 'show_hn' : tags.includes('ask_hn') ? 'ask_hn' : 'story';
  const link = h.url ? `links to: ${h.url}` : clean(decodeEntities(h.story_text ?? ''), 160) || 'text post';
  return {
    type,
    subjects: [subject],
    title: clean(decodeEntities(h.title ?? ''), 180),
    date: isoDay(h.created_at_i * 1000),
    metrics: { points: h.points ?? 0, comments: h.num_comments ?? 0 },
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    context: `by ${h.author} · ${link}`,
  };
}

async function main() {
  const runAt = new Date();
  const { targets, settings } = loadConfig();
  const since = Math.floor(daysAgo(settings.days_back_hn, runAt).getTime() / 1000);
  raw.push(`window: stories created after ${isoDay(since * 1000)} · keyword min points: ${settings.min_score_hn}`);

  const keyword: Signal[] = [];
  for (const t of targets) {
    for (const kw of t.sources.keywords ?? []) {
      const hits = await query(
        'search_by_date',
        {
          query: kw,
          numericFilters: `created_at_i>${since},points>=${settings.min_score_hn}`,
          hitsPerPage: String(settings.max_results_per_query),
        },
        `keyword "${kw}"`,
      );
      for (const h of hits) keyword.push(hitSignal(h, t.id));
    }
  }

  const trending: Signal[] = [];
  const tr = settings.trending;
  if (tr?.enabled) {
    // /search with an empty query orders by popularity (points) — the velocity view of the window.
    const hits = await query(
      'search',
      {
        query: '',
        numericFilters: `created_at_i>${since},points>=${tr.hackernews.min_points}`,
        hitsPerPage: String(tr.hackernews.max_results),
      },
      `trending (points >= ${tr.hackernews.min_points})`,
    );
    for (const h of hits) trending.push(hitSignal(h, 'trending'));
  } else {
    raw.push('trending pass disabled in settings');
  }

  raw.push(`api calls: ${calls}`);
  finish('hackernews', writeReport({ source: 'hackernews', runAt, keyword, trending, raw }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
