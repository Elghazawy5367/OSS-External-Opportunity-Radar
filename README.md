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
| `src/collectors/github-collector.ts` | GitHub REST search API | `17 */6 * * *` | repo secret `OSS_RADAR_GITHUB_PAT`, falling back to the automatic `GITHUB_TOKEN` |
| `src/collectors/hn-collector.ts` | Hacker News Algolia API | `37 */6 * * *` | none |
| `src/collectors/stackoverflow-collector.ts` | Stack Exchange API v2.3 | `47 */6 * * *` | `STACKEXCHANGE_KEY` repo secret (optional; raises the quota from 300 to 10,000 requests/day) |

Each workflow commits its reports back to `main`. All three share one `concurrency` group and
`pull --rebase` before pushing, so overlapping runs cannot lose a report. Each can also be run
by hand from the Actions tab (`workflow_dispatch`).

## What is watched

Everything is driven by [`config/watch-targets.yaml`](config/watch-targets.yaml) (currently
**version 2.0**). It defines five watch targets, each a step in a "what could an unknown person
enter?" funnel, plus one global list of economic keywords:

| Target | Question it asks | Sources |
|---|---|---|
| `rising-oss` | What capability just became free or cheap, and is adoption following? | GitHub (young topic repos, "open source alternative" phrases), HN |
| `recurring-pain` | What do many unrelated users keep struggling with? | HN, Stack Overflow (unanswered, business-tool tags) |
| `last-mile-gaps` | Where is the engine built but the human layer (RTL/Arabic, translation) missing? | GitHub, HN, Stack Overflow |
| `entry-rails` | Where can someone list, get found and get paid on a platform without code? | GitHub (Obsidian / Chrome / WordPress plugin topics), HN `Show HN`, Stack Overflow bounties |
| `money-movement` | Where is money changing hands: price increases, shutdowns? | Hacker News only |

How a query is written matters more than which words it uses, so every query carries its own
floors and window:

- **GitHub repositories**: quoted phrase limited to name + description, a star floor and a
  `created` window; or a topic with a window and star floor.
- **GitHub issues**: quoted phrase (title, or title + body), open state, window, and a
  reactions / comments floor where the config sets one.
- **Hacker News**: tag (`story`, `show_hn`, `ask_hn`), optional title-only search, points floor.
- **Stack Overflow**: tag with its passes (`unanswered`, `hot`), plus site-wide open bounties.
- **Per-target cap**: at most `max_signals_per_target` (40) signals per target, per source, per
  run, taken round-robin across that target's queries in the source's own sort order. Truncation
  is never silent: it is logged in the report as `capped: <target> <n> -> <cap>`.
- **Trending**: a velocity view next to the keyword pass. On GitHub it is the created-window
  topic queries; on Hacker News it is the top-point stories of the last days, with no keyword
  (global, not a target); on Stack Overflow it is "hot" questions for the tags that ask for it.

The config is validated on every run; a malformed file fails loudly instead of silently
collecting nothing. Every query in the current config was probed against the live APIs before it
was adopted. The previous four-target config is kept as
[`config/watch-targets.v1-backup.yaml`](config/watch-targets.v1-backup.yaml) for comparison.

## Reports

Two files per source per run, in `data/reports/`:

- `YYYY-MM-DD-HH-{github|hackernews|stackoverflow}.md` — the **observation** report
- `YYYY-MM-DD-HH-{source}-economic.md` — the **economic** report

A re-run in the same hour never overwrites: it writes `...-rerun-N.md`.

Both start with a machine-readable header: `run_time`, `source`, `collection_status`
(`SUCCESS`, `PARTIAL`, `RATE_LIMITED`, `SOURCE_ERROR` or `FAILED`), signal counts,
`pages_requested` / `pages_succeeded`, `watch_targets_version` and `collector_version`.

**Observation report** sections:

- **NEW SIGNALS — {target}**: items never seen in an earlier report of the same source, grouped by target
- **TRENDING**: everything from the trending pass
- **RECURRING**: current items that appeared before, with occurrence count and first-seen time
- **CHANGES SINCE LAST REPORT**: new / disappeared / metric moves versus the previous report of
  the *same* source only (never across sources)
- **RAW / UNCLASSIFIED**: the run log: every query, its hit count, caps, errors, rate-limit waits

**Economic report**: the signals of that run whose text contains a keyword from the global
`economic_keywords` list (whole-word match, optional plural). Sections: **OBSERVED** (new items,
grouped by signal type, each with an evidence tier and the matched keywords), **OBSERVED —
RECURRING** (already listed in an earlier economic report; one line each),
**MODELED** (empty placeholder: nothing is modeled in this pipeline) and **RAW**. Star, fork
and issue counts are deliberately left out: popularity is not evidence of demand.

A run that collects nothing and is not `SUCCESS` writes no report and exits non-zero, which
turns the workflow red. A `SUCCESS` run with zero signals still writes its report.

## Run locally

Requires Node 20+.

```bash
npm ci
cp .env.example .env   # optional: add GITHUB_TOKEN / STACKEXCHANGE_KEY
npx tsx src/collectors/hn-collector.ts
npx tsx src/collectors/stackoverflow-collector.ts
npx tsx src/collectors/github-collector.ts   # about 2 minutes without a token (search API: 10 req/min)
npm run typecheck
```

To try changes without touching `data/reports/`, copy the reports somewhere else and point the
run at the copy (history, diffs and recurrence are read from that folder):

```bash
OSS_RADAR_REPORTS_DIR=/path/to/scratch-copy npx tsx src/collectors/hn-collector.ts
```

Never put tokens or keys in repository **Variables** (they are stored in plain text); use
**Secrets** or a local, gitignored `.env`.

## Known limits

- **Scheduled runs are best-effort.** GitHub documents that `schedule` events can be delayed under load
  (including at the start of every hour) and that queued runs may be dropped. Measured here from
  2026-09-28 to 2026-10-08: 7–12 of 44 six-hour slots per workflow had no run, and runs that did happen
  started a median 3.4–4.2 hours after their cron time. The cron minutes (17 / 37 / 47) avoid the start of
  the hour for that reason. Collection windows are days long, so a late or missed run costs snapshot
  frequency, not signals; run a workflow by hand from the Actions tab to fill a gap.
- **Stack Overflow volume is very low.** On 2026-10-07 every watched tag had 7 or fewer questions
  created in the last 30 days, and many had none. Expect a handful of signals per run. The API
  cannot sort or filter by view count, so there is no "high-view" floor.
- **The economic lens is thin.** The keyword list is deliberately tight; at the time of writing it
  matches a handful of Hacker News titles per run and nothing on GitHub or Stack Overflow.
- **GitHub issue search has no repository-stars filter**, so "established apps only" cannot be
  expressed; issue queries use title restrictions and engagement floors instead.
- **Hacker News search** matches words, not phrases, unless title-only mode is set; thin topics
  (Arabic, RTL, marketplaces) only produce volume over long windows.
- **GitHub search** caps each query at `max_results_per_query` results and can occasionally
  report `incomplete_results`; that shows up in the RAW section.
- **Target changes reset the baseline.** The first report after a config change lists the old
  targets' items as "disappeared"; that is expected.
