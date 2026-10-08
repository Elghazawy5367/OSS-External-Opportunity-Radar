import { capRoundRobin, clean, daysAgo, decodeEntities, getJson, isoDay, loadConfig, sleep, type CollectionResult, type CollectionStatus, type Target } from './common';
import { finish, writeReport, writeEconomicReport, type Signal } from '../formatters/report-writer';

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
let queriesAttempted = 0;
let queriesSucceeded = 0;

async function query(endpoint: 'search' | 'search_by_date', params: Record<string, string>, label: string): Promise<Hit[]> {
  queriesAttempted++;
  // Per-query `tags` (e.g. "story,show_hn") overrides the default; typo tolerance and prefix matching stay off.
  const qs = new URLSearchParams({ tags: 'story', typoTolerance: 'false', queryType: 'prefixNone', ...params });
  if (calls > 0) await sleep(250);
  calls++;
  const res = await getJson<SearchResponse>(`${API}/${endpoint}?${qs}`);
  if (res.error || !res.body) {
    raw.push(`error ${label}: ${res.error ?? 'empty body'}`);
    return [];
  }
  raw.push(`${label} → ${res.body.hits.length} of ${res.body.nbHits}`);
  queriesSucceeded++;
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
    date_type: 'created',
    metrics: { points: h.points ?? 0, comments: h.num_comments ?? 0 },
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    context: `by ${h.author} · ${link}`,
  };
}

async function main() {
  const runAt = new Date();
  const keyword: Signal[] = [];
  const trending: Signal[] = [];
  let status: CollectionStatus = 'SUCCESS';
  let errorClass: string | undefined;
  let targets: Target[] = [];
  let economicKeywords: Record<string, string[]> = {};
  let watchTargetsVersion = 'unknown';

  try {
    const config = loadConfig();
    targets = config.targets;
    economicKeywords = config.economic_keywords;
    watchTargetsVersion = config.watch_targets_version;
    const settings = config.settings;
    const since = Math.floor(daysAgo(settings.days_back_hn, runAt).getTime() / 1000);
    raw.push(`config v${watchTargetsVersion} · window: stories created after ${isoDay(since * 1000)} · default min points: ${settings.min_score_hn}`);

    for (const t of targets) {
      const groups: Signal[][] = [];
      for (const e of t.sources.hackernews?.queries ?? []) {
        const points = e.min_points ?? settings.min_score_hn;
        const hits = await query(
          'search_by_date',
          {
            query: e.query,
            tags: e.tag === 'story' ? 'story' : `story,${e.tag}`,
            ...(e.title_only ? { restrictSearchableAttributes: 'title' } : {}),
            numericFilters: `created_at_i>${since},points>=${points}`,
            hitsPerPage: String(settings.max_results_per_query),
          },
          `${t.id} [${e.tag}${e.title_only ? ', title' : ''}] "${e.query}" p>=${points}`,
        );
        groups.push(hits.map((h) => hitSignal(h, t.id)));
      }
      const { kept, total } = capRoundRobin(groups, settings.max_signals_per_target, (s) => s.url);
      if (total > settings.max_signals_per_target) raw.push(`capped: ${t.id} ${total} -> ${settings.max_signals_per_target}`);
      keyword.push(...kept);
    }

    const tr = settings.trending;
    if (tr?.enabled) {
      const trendingSince = Math.floor(daysAgo(tr.hackernews.days_back, runAt).getTime() / 1000);
      const hits = await query(
        'search',
        {
          query: '',
          numericFilters: `created_at_i>${trendingSince},points>=${tr.hackernews.min_points}`,
          hitsPerPage: String(tr.hackernews.max_results),
        },
        `trending (points >= ${tr.hackernews.min_points}, last ${tr.hackernews.days_back}d)`,
      );
      for (const h of hits) trending.push(hitSignal(h, 'trending'));
    } else {
      raw.push('trending pass disabled in settings');
    }
  } catch (e) {
    status = 'FAILED';
    errorClass = (e as Error).constructor.name;
    raw.push(`fatal: ${(e as Error).message}`);
  }

  if (status !== 'FAILED') {
    if (queriesSucceeded === 0 && queriesAttempted > 0) {
      status = 'SOURCE_ERROR';
    } else if (queriesSucceeded < queriesAttempted) {
      status = 'PARTIAL';
    }
  }

  const collection: CollectionResult = {
    status,
    pages_requested: queriesAttempted,
    pages_succeeded: queriesSucceeded,
    error_class: errorClass,
  };

  raw.push(`api calls: ${calls}`);
  const input = { source: 'hackernews' as const, runAt, keyword, trending, raw, collection, watchTargetsVersion };
  const result = writeReport(input);
  if (!result.written) {
    console.error(`[hackernews] collection ${status} — raw log:`);
    for (const msg of raw) console.error(`  ${msg}`);
  }
  const econResult = writeEconomicReport(input, economicKeywords);
  if (econResult.written) {
    console.log(`[hackernews] economic: ${econResult.path} — ${econResult.keywordCount} signals`);
  } else {
    console.error(`[hackernews] economic report suppressed (${status}, 0 economic matches)`);
  }
  finish('hackernews', result, status);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
