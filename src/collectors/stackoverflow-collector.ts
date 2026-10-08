import { capRoundRobin, clean, daysAgo, decodeEntities, getJson, isoDay, loadConfig, sleep, type CollectionResult, type CollectionStatus, type Target } from './common';
import { finish, writeReport, writeEconomicReport, type Signal } from '../formatters/report-writer';

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
let queriesAttempted = 0;
let queriesSucceeded = 0;

async function se<T>(path: string, params: Record<string, string>, label: string): Promise<T[]> {
  queriesAttempted++;
  const qs = new URLSearchParams({ site: 'stackoverflow', ...params, ...(key ? { key } : {}) });
  const wait = Math.max(backoffUntil - Date.now(), calls > 0 ? 150 : 0);
  if (wait) await sleep(wait);
  calls++;
  const res = await getJson<Wrapper<T>>(`${API}${path}?${qs}`);
  if (res.body?.backoff) {
    backoffUntil = Date.now() + res.body.backoff * 1000;
    raw.push(`API requested backoff ${res.body.backoff}s after ${label}`);
  }
  if (res.body) quota = `${res.body.quota_remaining}/${res.body.quota_max}`;
  if (res.error || !res.body) {
    raw.push(`error ${label}: ${res.error ?? 'empty body'}`);
    return [];
  }
  raw.push(`${label} → ${res.body.items.length}${res.body.has_more ? ' (more available)' : ''}`);
  queriesSucceeded++;
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
    date_type: 'created',
    metrics,
    url: q.link,
    context:
      `tags: ${q.tags.join(', ')} · accepted answer: ${q.accepted_answer_id ? 'yes' : 'no'} · ` +
      `last activity: ${isoDay(q.last_activity_date * 1000)}`,
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
    const per = String(settings.max_results_per_query);
    const fromdate = String(Math.floor(daysAgo(settings.days_back_stackoverflow, runAt).getTime() / 1000));
    raw.push(
      `auth: ${key ? 'STACKEXCHANGE_KEY present' : 'no key (300 req/day per IP)'} · config v${watchTargetsVersion} · ` +
        `unanswered window: created after ${isoDay(Number(fromdate) * 1000)}`,
    );

    const tags = [...new Set(targets.flatMap((t) => (t.sources.stackoverflow?.tags ?? []).map((e) => e.tag)))];
    if (tags.length) {
      const info = await se<TagInfo>(`/tags/${tags.map(encodeURIComponent).join(';')}/info`, { pagesize: '100' }, 'tag check');
      const found = new Set(info.map((i) => i.name));
      const missing = tags.filter((t) => !found.has(t));
      const extra = info.filter((i) => !tags.includes(i.name)).map((i) => `${i.name} (${i.count})`);
      raw.push(`tags found: ${info.map((i) => `${i.name} (${i.count})`).join(', ')}`);
      if (missing.length) raw.push(`configured tags not returned by /tags/info (absent or synonym): ${missing.join(', ')}`);
      if (extra.length) raw.push(`tag names returned that are not in config (likely synonym masters): ${extra.join(', ')}`);
    }

    for (const t of targets) {
      const so = t.sources.stackoverflow;
      if (!so) continue;
      const groups: Signal[][] = [];
      for (const e of so.tags ?? []) {
        if (!e.passes.includes('unanswered')) continue;
        const unanswered = await se<Question>(
          '/questions/unanswered',
          { tagged: e.tag, fromdate, sort: 'creation', order: 'desc', pagesize: per },
          `${t.id} unanswered [${e.tag}]`,
        );
        groups.push(unanswered.map((q) => questionSignal(q, t.id, 'unanswered')));
      }
      if (so.featured_sitewide) {
        const bounties = await se<Question>(
          '/questions/featured',
          { sort: 'creation', order: 'desc', pagesize: per },
          `${t.id} open bounties [site-wide]`,
        );
        groups.push(bounties.map((q) => questionSignal(q, t.id, 'bounty')));
      }
      const { kept, total } = capRoundRobin(groups, settings.max_signals_per_target, (s) => s.url);
      if (total > settings.max_signals_per_target) raw.push(`capped: ${t.id} ${total} -> ${settings.max_signals_per_target}`);
      keyword.push(...kept);
    }

    const tr = settings.trending;
    if (tr?.enabled) {
      const sort = tr.stackoverflow.use_hot_endpoint ? 'hot' : 'activity';
      // Hot pass runs only for tags whose `passes` include "hot" (T1), not for every configured tag.
      const hotTags = [...new Set(targets.flatMap((t) => (t.sources.stackoverflow?.tags ?? []).filter((e) => e.passes.includes('hot')).map((e) => e.tag)))];
      const perTag: Question[][] = [];
      for (const tag of hotTags) {
        perTag.push(
          await se<Question>('/questions', { tagged: tag, sort, order: 'desc', pagesize: String(tr.stackoverflow.max_results) }, `${sort} [${tag}]`),
        );
      }
      const seen = new Set<number>();
      for (let i = 0; trending.length < tr.stackoverflow.max_results && perTag.some((l) => l[i]); i++) {
        for (const [j, list] of perTag.entries()) {
          const q = list[i];
          if (!q || seen.has(q.question_id) || trending.length >= tr.stackoverflow.max_results) continue;
          seen.add(q.question_id);
          trending.push(questionSignal(q, `trending:${hotTags[j]}`, sort));
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

  raw.push(`api calls: ${calls} · quota remaining: ${quota || 'unknown'}`);
  const input = { source: 'stackoverflow' as const, runAt, keyword, trending, raw, collection, watchTargetsVersion };
  const result = writeReport(input);
  if (!result.written) {
    console.error(`[stackoverflow] collection ${status} — raw log:`);
    for (const msg of raw) console.error(`  ${msg}`);
  }
  const econResult = writeEconomicReport(input, economicKeywords);
  if (econResult.written) {
    console.log(`[stackoverflow] economic: ${econResult.path} — ${econResult.keywordCount} signals`);
  } else {
    console.error(`[stackoverflow] economic report suppressed (${status}, 0 economic matches)`);
  }
  finish('stackoverflow', result, status);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
