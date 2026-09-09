# post-digest

A reading list that builds itself. Three times a day, unattended, it pulls the recommendation
feeds from X, Reddit, Xiaohongshu and LinkedIn, screens a few hundred posts down to a handful,
and writes them into a Notion database with a reason attached to every row.

The interesting part is not the scraping. It is that **the standard it screens by is a file the
system rewrites itself.** You rate rows in Notion; the next run folds those ratings back into
the criteria and commits the change. `git log -p skills/feed_digest/interests.md` is a record of
how one person's taste drifted over months.

> Extracted from a larger toolkit to be readable on its own. It will not run out of the box —
> dependencies are not vendored, the three social servers need logged-in sessions, and every
> Notion identifier is a `<PLACEHOLDER>` where a real page or data-source id used to be. Read
> it, don't clone-and-go.

## The loop

```
                     comments on `Digest Controls`
                     (six docs, mirrored to Notion)
                                 │
                                 ▼
  ┌───────────────────── one run ────────────────────────┐
  │  criteria-keeper  ──►  the funnel  ──►  run-logger   │
  └───────┬───────────────────┬────────────────┬─────────┘
          │                   │                │
     rewrites             writes rows     writes one row
   interests.md               │                │
          ▲                   ▼                ▼
          │           ┌─────────────┐    ┌──────────┐
          │           │ Feed Digest │    │ Run Log  │
          │           └──────┬──────┘    └──────────┘
          │                  │
          │        you rate a row: 👍 😐 👎
          └──────────────────┘
                next run folds it in

  the funnel, inside one run:

   4 feeds ─► dedup ─► cheap screen ─► post-screener ─► Notion row
    ~350      against    title only    body + COMMENTS    with a Why
              the DB          │
                              ▼
                     every 10th reject read anyway
                     (measures what the screen threw away)
```

A run is three phases: `criteria-keeper` first, the funnel, `run-logger` last.

### The funnel

Each level costs more than the last, so the expensive ones go last.

| level | what happens | cost |
|---|---|---|
| **pull** | 70 X-following + 30 X-for-you + 15 × subreddit + ~35 Xiaohongshu + 100 LinkedIn | one call each |
| **dedup** | drop URLs already in the database | one paged query |
| **cheap screen** | title, author, engagement, excerpt. Reject only for "not a subject they care about" | free, main loop |
| **read** | `post-screener` opens the post **and its comment tree** | a browser per post, 3 in flight |
| **write** | one Notion row, ten columns, a `Why` naming what it hit | one call per row |

## The Notion feedback path

This is the part worth reading the code for. Two channels come back from Notion, they are not
the same claim, and exactly one agent is allowed to act on either.

### Channel 1 — rate a row

Every digest row has a `Rating` column: **👍 useful / 😐 so-so / 👎 not useful**, plus a free-text
`Comment`. Rating one takes a second and is the only input the system asks for.

- **👍 / 👎 are about subject.** Each one lands in the examples section of `interests.md` as
  itself, immediately.
- **The prose above the examples changes only when two or more point at the same cause.** One 👎
  is one post; rewriting a standard from it is how the file swings past what you meant.
- **😐 changes nothing at all.** It says the post was on topic and still did not earn its slot —
  a reading on the bar. The user moves the bar, not the agent. It gets counted and reported, and
  that is it.

### Channel 2 — comment on the control page

A Notion page called `Digest Controls` mirrors every file the run is governed by — the skill,
the criteria, and each agent prompt. Commenting on one is you talking about the *document*, at
the level the document is written, so it is acted on the first time rather than needing a second
data point.

One page per file, six of them: `SKILL.md`, `interests.md`, and the four agent prompts —
including `criteria-keeper.md` itself, so you can comment on the feedback mechanism through the
feedback mechanism. The page ↔ file map lives in `agents/criteria-keeper.md` and nowhere else; a
caller holding its own copy would be a second place for it to go stale.

The mirror is one-way: `criteria-keeper` edits the file, then republishes it over the page. A
thread it has acted on gets a reply `✅ Changed: <which instruction changed, and what it said
before>`; a reply *underneath* that ✅ makes the thread live again and outranks what it decided
last time. A complaint with no wanted behaviour attached gets `❓ <the question>` and is left
open — nobody is awake to answer at 8am, and a standard bent the wrong way costs more than one
carried to tomorrow.
