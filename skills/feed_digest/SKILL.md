---
name: feed_digest
description: Pull the recommendation feeds from X, Reddit, RedNote and LinkedIn, screen them down to what is actually worth reading, and write the result to the Feed Digest database in Notion. Use when the user says "/feed_digest", or on a scheduled run.
---

# Feed Digest

You are replacing four scroll sessions with one list: the handful of things from X, Reddit,
RedNote and LinkedIn worth this person's attention, each with a reason attached.

The standard is `skills/feed_digest/interests.md`, their own account of what they care about
— not your taste. An empty run is a real outcome. Filler is the one failure that destroys the
list: once it has to be skimmed, it is just another feed.

Three steps: `criteria-keeper`, the funnel, `run-logger`.

## Start

**`date -Iseconds` first.** `run-logger` needs the run's start time, and by the end it cannot
be recovered.

**Then dispatch `criteria-keeper` with `DIGEST: Feed Digest`, and wait.** It is the only
thing that edits the documents this run is judged by — the control-page comments, the rated
rows, the mirrors — and it holds the page ↔ file list itself, so there is nothing else to
send it.

**Then read `skills/feed_digest/interests.md`** — after `criteria-keeper` returns, never
before: this run is judged by what it says now. Its `NOTABLE` lines go to `run-logger`
verbatim.

## The funnel

Each level costs more than the last, so the expensive ones go last; how much survives each
is yours to judge.

### Pull

All four platforms. Reddit is not like the others — the server uses an anonymous client, so
there is no personalised front page; use the subreddit list in `interests.md`.

| | tool | how much |
|---|---|---|
| x following | `scrape_timeline(type="following", maxPosts=70)` | 70, or the whole feed if shorter |
| x for you | `scrape_timeline(type="for-you", maxPosts=30)` | 30 |
| reddit | `get_subreddit_hot_posts(subreddit, limit=15)` per sub | 15 × subs listed |
| linkedin | dispatch `linkedin-feed-reader` | it pulls and screens in one step |
| rednote | `list_feeds()` | whatever the first screen hydrates, ~35. No parameter, no scrolling. |

X is two feeds and they fail in opposite directions — following goes stale, for-you drifts
toward whatever is popular. Take them in two calls; a post in both stays a following post,
and the overlap is how much for-you is actually adding.

Ask for the full amount every run. Anything you never pull cannot be screened.

### Drop what you have already delivered

Query the database for recent URLs and skip anything already there. This runs three times a
day against slow feeds; without it the same post arrives every morning.

The query has two ways of not answering, and both look like an answer. It can **fail** — past
the workspace's query cap it errors or returns 429; retry, and if it still will not answer,
treat the run as deduped against nothing and say so. It can **come back full** — the result is
one page, so exactly 100 rows is the page ending, not the database ending. Ask by date, a week
back, and keep asking for the next page until one comes back short. A dedup that stopped at
the newest hundred re-delivers older posts, and they do not even look like duplicates: each
comes back rewritten with a different title and score.

### Screen on metadata

Title, author, engagement, excerpt — no browser, so be generous. **Aim to pass 20–30 posts.**
As an adjective "generous" has not held: one run cut 344 to 9 here, and only 3 of the 9
survived reading.

Reject for one reason: this is not about anything they care about. Never reject because the
claim looks thin, the number looks inflated, or the author looks like they are selling
something — none of that is knowable from a title, and finding it out is the job of the level
below. A platform that returned a full feed and contributed nothing needs a written reason.

### Sample what you rejected

The screen throws away nine in ten and nothing looks at them again, so half the question goes
unmeasured. The `Rating` loop cannot close it — it only sees rows that got written, so every
correction this skill receives is about a false positive.

Concatenate the rejects in feed order — X following, X for you, Reddit, RedNote, LinkedIn
— number them, take every ⌊total ÷ 10⌋-th. Mechanically: the moment you pick the ones that
look promising, the sample measures your judgement a second time instead of testing it. A draw
already in the database is skipped for the next one along.

Those ten go to the read level under the same standard, and one worth writing gets written.
What accumulates is the `sample` line in `FUNNEL` — drawn, read, would-have-been-written; each
cut's reason goes in the terminal report and stops there. Zero misses in one run of ten is not
evidence there are none.

### Read the survivors

Dispatch `post-screener`, at most three at a time — each drives a browser, X rate-limits
concurrent sessions on one account, and RedNote launches a Chromium per request. Give each
the URL and `interests.md` in full — the examples are where the boundary calls live, and a
screener working from a summary of the standard is judging by something you rewrote.

Three at a time is a rate limit, not a time budget. Thirty posts is ten rounds and over an
hour, which is fine — nobody is waiting. Do not shrink the shortlist to finish sooner.

LinkedIn never reaches this level: `linkedin-feed-reader` already screened it, and its rejects
join the pile the sample is drawn from.

### Write

Data source `collection://<FEED_DIGEST_DATA_SOURCE>`, one row per survivor.
**Read `reference/notion-columns.md` before writing the first one** — it holds the ten
columns and the two that fail silently, and checking those on the last row is too late.

## Ending the run

Report to the user: what each feed returned, what you dropped and roughly why, what made it
through, and what went unread because a platform was cooling down — that last one is the
difference between "nothing good today" and "I couldn't look".

**The funnel as numbers, per platform**, one table, every level, including levels that dropped
nothing: pulled → already delivered → shortlisted → read → written. **X gets two rows at every
level**, following and for-you, or the split measures nothing; their overlap goes on its own
line. Then the control sample on its own line — drawn, read, how many would have made it, and
for each the reason the screen cut it. That reason is the only thing that says what to change.
Every level except this report is invisible from outside: a run that cut 344 to 9 leaves
behind the same five rows as a genuinely thin day.

When a post dies for a reason that is not about the post — a tool returned someone else's
content, a note put its argument in images, a platform was cooling down — count it separately
and name it. Those are bugs, not the feed's bad day. If a platform failed outright, say which
and keep going: three feeds and an honest note beats no run at all.

**Log the run.** The report above goes to `~/.local/state/feed-digest/`, which nobody reads
and tomorrow's run cannot. Dispatch `run-logger` once, at the very end — even when the run
went badly, especially then: a run that failed early and wrote no row is indistinguishable
from a run that never fired.

`agents/run-logger.md` defines the report it expects; send exactly that, with
`DIGEST: Feed Digest` and one `FUNNEL` line for each of `x-following`, `x-foryou`, `reddit`,
`rednote`, `linkedin`, `sample` — all six every run, a channel that never ran written as
`—  (why)` rather than as zero. `NOTABLE` takes what this run changed and what it wants, five
lines at most, including `criteria-keeper`'s lines verbatim.
