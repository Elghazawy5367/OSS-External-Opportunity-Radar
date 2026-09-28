import { clean, daysAgo, getJson, isoDay, loadConfig, sleep, type CollectionResult, type CollectionStatus, type Target } from './common';
import { finish, writeReport, writeEconomicReport, type Signal } from '../formatters/report-writer';

interface Repo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  archived: boolean;
  created_at: string;
  pushed_at: string;
  topics?: string[];
}

interface Issue {
  title: string;
  html_url: string;
  repository_url: string;
  comments: number;
  created_at: string;
  state: string;
  body: string | null;
  reactions?: { total_count: number };
  pull_request?: unknown;
}

interface SearchResponse<T> {
  total_count: number;
  incomplete_results: boolean;
  items: T[];
}

const token = process.env.GITHUB_TOKEN;
const headers: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'oss-external-opportunity-radar',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};
const PACE_MS = token ? 2_200 : 6_500;

const raw: string[] = [];
let calls = 0;
let queriesAttempted = 0;
let queriesSucceeded = 0;
let hadRateLimit = false;

async function search<T>(kind: 'repositories' | 'issues', q: string, sort: string, perPage: number): Promise<T[]> {
  queriesAttempted++;
  const url =
    `https://api.github.com/search/${kind}?q=${encodeURIComponent(q)}` +
    `&sort=${sort}&order=desc&per_page=${perPage}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (calls > 0) await sleep(PACE_MS);
    calls++;
    const res = await getJson<SearchResponse<T>>(url, headers);
    const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '1');
    const reset = Number(res.headers.get('x-ratelimit-reset') ?? '0');
    const limited = res.status === 403 || res.status === 429;
    if (limited) {
      hadRateLimit = true;
      const retryAfter = Number(res.headers.get('retry-after') ?? '0');
      const waitMs = Math.min(Math.max(retryAfter * 1000, reset * 1000 - Date.now() + 1000, 5_000), 70_000);
      raw.push(`rate-limited on ${kind} "${q}" (HTTP ${res.status}); waited ${Math.round(waitMs / 1000)}s, attempt ${attempt + 1}`);
      await sleep(waitMs);
      continue;
    }
    if (res.error || !res.body) {
      raw.push(`error ${kind} "${q}": ${res.error ?? 'empty body'}`);
      return [];
    }
    if (res.body.incomplete_results) raw.push(`incomplete_results=true for ${kind} "${q}" (GitHub search timed out partially)`);
    if (remaining === 0 && reset) await sleep(Math.min(Math.max(reset * 1000 - Date.now() + 1000, 0), 70_000));
    raw.push(`${kind} "${q}" → ${res.body.items.length} of ${res.body.total_count}`);
    queriesSucceeded++;
    return res.body.items;
  }
  raw.push(`gave up on ${kind} "${q}" after 3 rate-limited attempts`);
  return [];
}

function repoSignal(r: Repo, subject: string, type = 'repo'): Signal {
  const bits = [
    clean(r.description, 160) || 'no description',
    r.language ? `lang: ${r.language}` : '',
    `created: ${isoDay(r.created_at)}`,
    `pushed: ${isoDay(r.pushed_at)}`,
    r.archived ? 'ARCHIVED' : '',
  ].filter(Boolean);
  return {
    type,
    subjects: [subject],
    title: r.full_name,
    date: isoDay(r.created_at),
    date_type: 'created',
    metrics: { stars: r.stargazers_count, forks: r.forks_count, open_issues: r.open_issues_count },
    url: r.html_url,
    context: bits.join(' · '),
  };
}

function issueSignal(i: Issue, subject: string): Signal {
  const repo = i.repository_url.replace('https://api.github.com/repos/', '');
  return {
    type: i.pull_request ? 'pull_request' : 'issue',
    subjects: [subject],
    title: clean(i.title, 160),
    date: isoDay(i.created_at),
    date_type: 'created',
    metrics: { comments: i.comments, reactions: i.reactions?.total_count ?? 0 },
    url: i.html_url,
    context: `repo: ${repo} · state: ${i.state} · ${clean(i.body, 160) || 'no body'}`,
  };
}

async function main() {
  const runAt = new Date();
  const keyword: Signal[] = [];
  const trending: Signal[] = [];
  let status: CollectionStatus = 'SUCCESS';
  let errorClass: string | undefined;
  let targets: Target[] = [];

  try {
    const config = loadConfig();
    targets = config.targets;
    const settings = config.settings;
    const per = settings.max_results_per_query;
    const since = isoDay(daysAgo(settings.days_back_github, runAt));
    raw.push(`auth: ${token ? 'GITHUB_TOKEN present' : 'anonymous (10 search req/min)'} · window: pushed/created after ${since}`);

    for (const t of targets) {
      for (const topic of t.sources.github_topics ?? []) {
        const q = `topic:${topic} pushed:>${since} stars:>=${settings.min_stars_fork_watch}`;
        for (const r of await search<Repo>('repositories', q, 'stars', per)) keyword.push(repoSignal(r, t.id));
      }
      for (const phrase of t.sources.github_search_queries ?? []) {
        const rq = `${phrase} in:name,description,readme pushed:>${since}`;
        for (const r of await search<Repo>('repositories', rq, 'stars', per)) keyword.push(repoSignal(r, t.id));
        const iq = `"${phrase}" is:issue created:>${since}`;
        for (const i of await search<Issue>('issues', iq, 'created', per)) keyword.push(issueSignal(i, t.id));
      }
    }

    const tr = settings.trending;
    if (tr?.enabled) {
      const created = isoDay(daysAgo(tr.github.created_within_days, runAt));
      for (const topic of tr.github.topics_filter) {
        const q = `topic:${topic} created:>${created} stars:>=${tr.github.min_stars}`;
        for (const r of await search<Repo>('repositories', q, tr.github.sort_by, per)) {
          trending.push(repoSignal(r, `trending:${topic}`, 'trending_repo'));
        }
      }
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
      status = hadRateLimit ? 'RATE_LIMITED' : 'SOURCE_ERROR';
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
  const result = writeReport({ source: 'github', runAt, keyword, trending, raw, collection });
  if (!result.written) {
    console.error(`[github] collection ${status} — raw log:`);
    for (const msg of raw) console.error(`  ${msg}`);
  }
  const econResult = writeEconomicReport({ source: 'github', runAt, keyword, trending, raw, collection }, targets);
  if (econResult.written) {
    console.log(`[github] economic: ${econResult.path} — ${econResult.keywordCount} signals`);
  } else {
    console.error(`[github] economic report suppressed (${status}, 0 economic matches)`);
  }
  finish('github', result, status);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
