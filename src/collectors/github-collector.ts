import { capRoundRobin, clean, daysAgo, getJson, isoDay, loadConfig, sleep, type CollectionResult, type CollectionStatus, type Target } from './common';
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

/** A signal plus the report section it belongs to. Created-window topic queries are the velocity ("trending") pass. */
interface Tagged {
  signal: Signal;
  bucket: 'keyword' | 'trending';
}

const sinceDay = (days: number, runAt: Date) => isoDay(daysAgo(days, runAt));

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
    const per = settings.max_results_per_query;
    raw.push(`auth: ${token ? 'GITHUB_TOKEN present' : 'anonymous (10 search req/min)'} · config v${watchTargetsVersion} · windows are per query`);

    for (const t of targets) {
      const g = t.sources.github;
      if (!g) continue;
      const groups: Tagged[][] = [];

      for (const e of g.repo_topics ?? []) {
        const velocity = e.created_within_days !== undefined;
        const win = velocity
          ? `created:>${sinceDay(e.created_within_days!, runAt)}`
          : `pushed:>${sinceDay(e.pushed_within_days!, runAt)}`;
        const items = await search<Repo>('repositories', `topic:${e.topic} ${win} stars:>=${e.min_stars}`, 'stars', per);
        groups.push(items.map((r) => ({
          signal: repoSignal(r, t.id, velocity ? 'trending_repo' : 'repo'),
          bucket: velocity ? 'trending' : 'keyword',
        })));
      }

      for (const e of g.repo_phrases ?? []) {
        const q = `"${e.phrase}" in:${e.in} created:>${sinceDay(e.created_within_days, runAt)} stars:>=${e.min_stars}`;
        const items = await search<Repo>('repositories', q, 'stars', per);
        groups.push(items.map((r) => ({ signal: repoSignal(r, t.id), bucket: 'keyword' as const })));
      }

      for (const e of g.issue_queries ?? []) {
        const subject = e.label ? `label:${e.label}` : `"${e.phrase}" in:${e.in}`;
        const q =
          `${subject} is:issue is:${e.state} created:>${sinceDay(e.created_within_days, runAt)}` +
          (e.min_reactions !== undefined ? ` reactions:>=${e.min_reactions}` : '') +
          (e.min_comments !== undefined ? ` comments:>=${e.min_comments}` : '');
        const items = await search<Issue>('issues', q, e.min_reactions !== undefined ? 'reactions' : 'created', per);
        groups.push(items.map((i) => ({ signal: issueSignal(i, t.id), bucket: 'keyword' as const })));
      }

      const { kept, total } = capRoundRobin(groups, settings.max_signals_per_target, (x) => x.signal.url);
      if (total > settings.max_signals_per_target) raw.push(`capped: ${t.id} ${total} -> ${settings.max_signals_per_target}`);
      for (const x of kept) (x.bucket === 'trending' ? trending : keyword).push(x.signal);
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
  const input = { source: 'github' as const, runAt, keyword, trending, raw, collection, watchTargetsVersion };
  const result = writeReport(input);
  if (!result.written) {
    console.error(`[github] collection ${status} — raw log:`);
    for (const msg of raw) console.error(`  ${msg}`);
  }
  const econResult = writeEconomicReport(input, economicKeywords);
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
