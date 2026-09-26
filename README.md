# OSS External Opportunity Radar

Three small scheduled collectors that pull **raw public signals** from GitHub, Hacker News and
Stack Overflow, and commit them to this repo as Markdown reports. Reports pile up over time so
a person can later read them for patterns across sources and weeks.

The pipeline does **not** score, rank, classify, summarise or recommend anything, and it makes
no LLM calls. Every line in a report is an observation with a source URL. Interpretation happens
outside this repo.

## What runs

| Collector | Source | Schedule (UTC) | Auth |
|---|---|---|---|
| `src/collectors/github-collector.ts` | GitHub REST search API | `0 */6 * * *` | `GITHUB_TOKEN` (automatic in Actions) |
| `src/collectors/stackoverflow-collector.ts` | Stack Exchange API v2.3 | `10 */6 * * *` | `STACKEXCHANGE_KEY` repo secret (optional; raises quota 300 → 10,000/day) |
| `src/collectors/hn-collector.ts` | Hacker News Algolia API | `20 */6 * * *` | none |

Each collector makes two passes, both driven by [`config/watch-targets.yaml`](config/watch-targets.yaml):

- **Keyword pass**: every target's GitHub topics and queries, HN keywords, or SO tags.
- **Trending pass**: a velocity view that ignores keywords (young high-star repos, top-point
  HN stories, "hot" SO questions per tag).

Each workflow commits its report back to `main`. All three share one `concurrency` group and
`pull --rebase` before pushing, so overlapping runs cannot lose a report. Each can also be run
by hand from the Actions tab (`workflow_dispatch`).

## Reports

`data/reports/YYYY-MM-DD-HH-{github|hackernews|stackoverflow}.md`, one file per source per run.
Sections:

- **NEW SIGNALS**: keyword-pass items never seen in an earlier report of the same source
- **TRENDING**: everything from the trending pass
- **RECURRING**: current items that appeared before, with occurrence count and first-seen time
- **CHANGES SINCE LAST REPORT**: new / disappeared / metric moves versus the previous report of
  the *same* source only (never across sources)
- **RAW / UNCLASSIFIED**: the run log: every query, its hit count, errors, rate-limit waits, tag checks

A run that collects zero signals still writes its report (so the RAW log survives) but exits
non-zero, which turns the workflow red.

## Run locally

Requires Node 20+.

```bash
npm ci
cp .env.example .env   # optional: add GITHUB_TOKEN / STACKEXCHANGE_KEY
npx tsx src/collectors/hn-collector.ts
npx tsx src/collectors/stackoverflow-collector.ts
npx tsx src/collectors/github-collector.ts   # ~10 min without a token (search API: 10 req/min)
npm run typecheck
```

## Known limits

- **Stack Overflow volume is low.** In the September 2026 build test, all 17 watched tags returned
  zero unanswered questions and zero open bounties in the 7-day window. Spot checks: the newest
  `github` question was 13 days old and the newest unanswered `langchain` question was 3 months old.
  Trending ("hot") still returned items, but many were old questions with recent activity.
- **HN keyword matching is word-based**, not phrase-based, so multi-word keywords can match loosely.
- **GitHub search** caps each query at `max_results_per_query` results and can occasionally
  report `incomplete_results`. That shows up in the RAW section.
