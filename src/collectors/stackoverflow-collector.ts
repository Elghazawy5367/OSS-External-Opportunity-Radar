// stackoverflow-collector — raw signals from the Stack Exchange API v2.3 (site=stackoverflow).
// Keyword pass: per target tag, unanswered questions within days_back_stackoverflow + open bounties.
// Trending pass: per tag "hot" questions (or "activity" when use_hot_endpoint is false),
// interleaved across tags up to max_results.
// Run: npx tsx src/collectors/stackoverflow-collector.ts   (STACKEXCHANGE_KEY optional but recommended)
import { clean, daysAgo, decodeEntities, getJson, isoDay, loadConfig, sleep } from './common';
import { finish, writeReport, type Signal } from '../formatters/report-writer';

interface Question {
  question_id: number;
  title: string;
  link: string;
  tags: string[];
  score: number;
  view_count: number;
  answer_count: number;
  is_answered: boolean;
  accepted_answer_id?: number;
  bounty_amount?: number;
  creation_date: number;
  last_activity_date: number;
}

interface TagInfo {
  name: string;
  count: number;
}

interface Wrapper<T> {
  items: T[];
  has_more: boolean;
  quota_max: number;
  quota_remaining: number;
  backoff?: number;
  error_message?: string;
}

const API = 'https://api.stackexchange.com/2.3';
const key = process.env.STACKEXCHANGE_KEY;
const raw: string[] = [];
let calls = 0;
let quota = '';
let backoffUntil = 0;

async function se<T>(path: string, params: Record<string, string>, label: string): Promise<T[]> {
  const qs = new URLSearchParams({ site: 'stackoverflow', ...params, ...(key ? { key } : {}) });
  const wait = Math.max(backoffUntil - Date.now(), calls > 0 ? 150 : 0);
  if (wait) await sleep(wait);
  calls++;
  const res = await getJson<Wrapper<T>>(`${API}${path}?${qs}`);
  if (res.body?.backoff) {
    // The API requires honouring `backoff` before the next call to the same method.
    backoffUntil = Date.now() + res.body.backoff * 1000;
    raw.push(`API requested backoff ${res.body.backoff}s after ${label}`);
  }
  if (res.body) quota = `${res.body.quota_remaining}/${res.body.quota_max}`;
  if (res.error || !res.body) {
    raw.push(`error ${label}: ${res.error ?? 'empty body'}`);
    return [];
  }
  raw.push(`${label} → ${res.body.items.length}${res.body.has_more ? ' (more available)' : ''}`);
  return res.body.items;
}

function questionSignal(q: Question, subject: string, type: string): Signal {
  const metrics: Record<string, number> = { views: q.view_count, score: q.score, answers: q.answer_count };
  if (q.bounty_amount) metrics.bounty = q.bounty_amount;
  return {
    type,
    subjects: [subject],
    title: clean(decodeEntities(q.title), 180),
    date: isoDay(q.creation_date * 1000),
    metrics,
    url: q.link,
    context:
      `tags: ${q.tags.join(', ')} · accepted answer: ${q.accepted_answer_id ? 'yes' : 'no'} · ` +
      `last activity: ${isoDay(q.last_activity_date * 1000)}`,
  };
}

async function main() {
  const runAt = new Date();
  const { targets, settings } = loadConfig();
  const per = String(settings.max_results_per_query);
  const fromdate = String(Math.floor(daysAgo(settings.days_back_stackoverflow, runAt).getTime() / 1000));
  raw.push(`auth: ${key ? 'STACKEXCHANGE_KEY present' : 'no key (300 req/day per IP)'} · unanswered window: after ${isoDay(Number(fromdate) * 1000)}`);

  const tagOwners = new Map<string, string[]>();
  for (const t of targets) {
    for (const tag of t.sources.stackoverflow_tags ?? []) tagOwners.set(tag, [...(tagOwners.get(tag) ?? []), t.id]);
  }
  const tags = [...tagOwners.keys()];

  // Build-time tag check, repeated every run so renamed/merged tags stay visible in the report.
  const info = await se<TagInfo>(`/tags/${tags.map(encodeURIComponent).join(';')}/info`, { pagesize: '100' }, 'tag check');
  const found = new Set(info.map((i) => i.name));
  const missing = tags.filter((t) => !found.has(t));
  const extra = info.filter((i) => !tags.includes(i.name)).map((i) => `${i.name} (${i.count})`);
  raw.push(`tags found: ${info.map((i) => `${i.name} (${i.count})`).join(', ')}`);
  if (missing.length) raw.push(`configured tags not returned by /tags/info (absent or synonym): ${missing.join(', ')}`);
  if (extra.length) raw.push(`tag names returned that are not in config (likely synonym masters): ${extra.join(', ')}`);

  const keyword: Signal[] = [];
  for (const [tag, owners] of tagOwners) {
    const unanswered = await se<Question>(
      '/questions/unanswered',
      { tagged: tag, fromdate, sort: 'creation', order: 'desc', pagesize: per },
      `unanswered [${tag}]`,
    );
    const bounties = await se<Question>(
      '/questions/featured',
      { tagged: tag, sort: 'creation', order: 'desc', pagesize: per },
      `open bounties [${tag}]`,
    );
    for (const owner of owners) {
      for (const q of unanswered) keyword.push(questionSignal(q, owner, 'unanswered'));
      for (const q of bounties) keyword.push(questionSignal(q, owner, 'bounty'));
    }
  }

  const trending: Signal[] = [];
  const tr = settings.trending;
  if (tr?.enabled) {
    const sort = tr.stackoverflow.use_hot_endpoint ? 'hot' : 'activity';
    const perTag: Question[][] = [];
    for (const tag of tags) {
      perTag.push(
        await se<Question>('/questions', { tagged: tag, sort, order: 'desc', pagesize: String(tr.stackoverflow.max_results) }, `${sort} [${tag}]`),
      );
    }
    // Interleave by each tag's own API order so no tag dominates; no ranking of our own.
    const seen = new Set<number>();
    for (let i = 0; trending.length < tr.stackoverflow.max_results && perTag.some((l) => l[i]); i++) {
      for (const [j, list] of perTag.entries()) {
        const q = list[i];
        if (!q || seen.has(q.question_id) || trending.length >= tr.stackoverflow.max_results) continue;
        seen.add(q.question_id);
        trending.push(questionSignal(q, `trending:${tags[j]}`, sort));
      }
    }
  } else {
    raw.push('trending pass disabled in settings');
  }

  raw.push(`api calls: ${calls} · quota remaining: ${quota || 'unknown'}`);
  finish('stackoverflow', writeReport({ source: 'stackoverflow', runAt, keyword, trending, raw }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
