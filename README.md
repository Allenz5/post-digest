# post-digest

A reading list that builds itself. Three times a day, unattended, it pulls the recommendation
feeds from X, Reddit, RedNote and LinkedIn, screens a few hundred posts down to a handful,
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
  ┌──────────────── one run ─────────────────┐
  │   criteria-keeper   ──►   the funnel     │
  └────────┬─────────────────────┬───────────┘
           │                     │
      rewrites              writes rows
    interests.md                 │
           ▲                     ▼
           │             ┌─────────────┐
           │             │ Feed Digest │
           │             └──────┬──────┘
           │                    │
           │     you rate a row: 👍 😐 👎
           │     or comment on it
           └────────────────────┘
                 next run folds it in

  the funnel, inside one run:

   4 feeds ─► dedup ─► cheap screen ─► post-screener ─► Notion row
    ~350      against    title only    body + COMMENTS    with a Why
              the DB          │
                              ▼
                     every 10th reject read anyway
                     (measures what the screen threw away)
```

A run is two phases: `criteria-keeper` first, then the funnel.

### The funnel

Each level costs more than the last, so the expensive ones go last.

| level | what happens | cost |
|---|---|---|
| **pull** | 70 X-following + 30 X-for-you + 15 × subreddit + ~35 RedNote + 100 LinkedIn | one call each |
| **dedup** | drop URLs already in the database | one paged query |
| **cheap screen** | title, author, engagement, excerpt. Reject only for "not a subject they care about" | free, main loop |
| **read** | `post-screener` opens the post **and its comment tree** | a browser per post, 3 in flight |
| **write** | one Notion row, ten columns, a `Why` naming what it hit | one call per row |

### The feedback loop

Two things come back from Notion, and they are not the same claim.

**Rate a row** — 👍 useful / 😐 so-so / 👎 not useful. A 👍 or 👎 goes into the examples section
of `interests.md` immediately. The prose above the examples changes only when two ratings point
at the same cause. 😐 changes nothing: it says the post was on topic and still missed the bar,
and the user moves the bar, not the agent.

**Comment on a control page** — one Notion page mirrors each file the run is governed by: the
skill, the criteria, and the four agent prompts. A comment there is about the document itself,
so it is acted on the first time rather than waiting for a second data point.

`criteria-keeper` runs first and is the only thing that edits any of it. Three rules do the
work: **rewrite, never append** (`interests.md` has a 200-line ceiling, so a new idea has to
displace an older one); **never paste the user's words in** — rewrite the instruction that
produced the behaviour; and **test the change against the 👍 rows first**, because a rule that
would have rejected one of those has overshot.
