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

**The comments are the whole point of the read level.** A post is its author's best case for
itself; the replies are where that case survives or falls apart, and they are the only reliable
way to tell a write-up from an ad for its writer. LinkedIn is the exception — there is no tool
that reads one LinkedIn post, so `linkedin-feed-reader` pulls and screens in a single step, on
body text alone, and is told to be stricter because of what it cannot see.

**The control sample is the part most pipelines skip.** The screen throws away nine in ten and
nothing looks at them again, so half the question goes unmeasured: the rating loop only ever
sees rows that got *written*, which means every correction the system receives is about a false
positive. So the rejects get numbered in feed order and every ⌊total ÷ 10⌋-th one is read anyway,
under the same standard. Mechanically, not by picking the promising ones — the moment you choose,
the sample measures your judgement a second time instead of testing it.

**An empty run is a real outcome.** Once the list contains filler it has to be skimmed, and then
it is just another feed.

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

### Why one agent owns all of it

`criteria-keeper` runs first, alone, and nothing else in a run edits those documents. Two
reasons:

**The run is judged by what the file says now.** The skill reads `interests.md` *after* the
keeper returns, never before, so a rating you left last night is in force this morning rather
than next week.

**Feedback is a distillation, not a log.** The rules that make that work are all in
`agents/criteria-keeper.md`, and they are the actual design:

- **Rewrite, never append.** `interests.md` has a 200-line ceiling. At the ceiling a new idea has
  to displace an older one, and that is what forces the distillation. The archive is Notion,
  where every comment stays attached to its row forever.
- **Never paste the user's words into the file.** Find the instruction that produced the
  behaviour and rewrite *that*. Pasting is how a criteria file becomes a pile of accumulated
  demands nobody can apply.
- **Test the change against the 👍 rows first.** If the rule you are about to write would have
  rejected something the user marked 👍, it is too strong. Weaken it, or wait for more evidence.
- **Retire examples as well as add them.** An example the prose now states outright comes out.
  The examples section is a set of live boundary calls, not a record of everything ever rated.
- **Never set `Rating`.** That column is the user's. The agent sets `Learned` on rows it has
  consumed, and that is the only mark it makes.

### The third channel: Run Log

The digest database only holds rows that got *written*. A run that pulled 344 posts and cut them
to 9 leaves behind the same five rows as a genuinely thin day, and its terminal report goes to a
log file nobody opens.

So `run-logger` writes one row per run into a `Run Log` database: the five-level funnel **per
channel**, the bugs, the minutes, and what the run changed. Its rules matter more than they look:

- **Always write the row.** Validation failures get recorded *in* the row, never returned as a
  refusal. A malformed report is one problem; a run with no trace is that problem plus no
  evidence it ever ran.
- **A channel that did not run is `—` plus a reason, never `0 → 0 → 0 → 0 → 0`.** Zero means the
  channel ran and produced nothing, which is evidence about the channel. `—` means nobody asked
  it. Collapsing them is how a channel gets retired for a drought it was never given a chance to
  end.
- **The funnel must narrow.** `written ≤ read ≤ shortlisted ≤ new ≤ pulled`, checked per channel.
  When it doesn't, the line is written verbatim and a bug is filed — repairing the numbers here
  would hide the miscount instead of surfacing it.

## Why post bodies cannot reach the main loop

Every server runs two profiles over one codebase. The **director** finds things; the **explorer**
reads them.

| server | director has | explorer has |
|---|---|---|
| reddit | feeds, `search`, subreddit info | `get_post` `get_post_comments` |
| x | timeline, `search`, profiles, trending | `get_post` |
| xiaohongshu | `list_feeds` `search`, profiles | `get_post` |

The line is bounded vs unbounded. A director tool answers in one line per item — title, author,
engagement, URL, an excerpt capped at 2,000 characters. An explorer tool returns a whole body and
a whole comment tree, which has no ceiling at all. Before the renderers went in, one `list_feeds`
call returned 56,831 characters of JSON.

**Only the director profiles are registered globally.** The explorer profiles are declared inside
the frontmatter of `agents/post-screener.md.in` and exist nowhere else, so the main loop has no
tool to read a post body with. That is a capability boundary the harness enforces, not a rule in
a prompt: the orchestrator cannot flood its own context because it cannot fetch anything that
would.

### Why this is not a plugin

It was one, and being one is what broke the boundary. Plugin-shipped agents ignore the
`mcpServers` frontmatter field ("for security reasons", per the plugins reference) — reasonably,
since `command:` is an arbitrary executable. But that field is the only mechanism that gives a
subagent a server the main conversation lacks, so as a plugin the explorer profiles had to be
registered globally and the boundary degraded into an instruction. Permissions cannot patch it
either: `deny` is inherited by subagents, so denying the main loop denies the screener with it
(tested, not assumed).

The price is real and paid in the other direction: no version, no `claude plugin validate`, an
install script instead of one symlink, and absolute paths baked into generated files — which is
why `agents/post-screener.md.in` is a template rendered at install time, and why `make install`
has to be re-run whenever the repo moves.

## Layout

```
skills/feed_digest/
  SKILL.md                     the orchestrator: the funnel, level by level
  interests.md                 the standard — the file that rewrites itself
  reference/notion-columns.md  read at the write step; the two columns that fail silently
agents/
  criteria-keeper.md           the only writer of the criteria. Runs first.
  linkedin-feed-reader.md      the whole LinkedIn channel: pulls and screens in one step
  post-screener.md.in          reads one post + its comments. Template: it declares explorers.
  run-logger.md                one row per run. Runs last.
scripts/
  install.sh                   symlinks skills, renders agents, registers director servers
  run-feed-digest.sh           the launchd entry point
  feed-digest.plist.in         08:07, 12:23, 19:11, weekdays
servers/                       source only — no node_modules, no venvs, no built binaries
  mcp_servers/reddit_server/   Python, two profiles
  x/                           TypeScript, Playwright
  linkedin/                    Python, Selenium
  xiaohongshu/                 Go, HTTP on :18060
.claude/settings.json          the deny list: nothing that posts, likes or messages
```

`servers/x/`, `servers/linkedin/` and `servers/xiaohongshu/` are de-vendored forks of
`@barresider/x-mcp`, `stickerdaniel/linkedin-mcp-server` and `xpzouying/xiaohongshu-mcp`,
maintained independently — there is no upstream sync.

## Details worth knowing

**Xiaohongshu is the odd one out.** It speaks HTTP on `:18060`, so it has to be running before
Claude Code can reach it; the other three are spawned on demand. `run-feed-digest.sh` adopts a
healthy server if one is up and only kills what it started itself — `pkill` there was reaching
into other Claude sessions on the same machine.

**launchd, not cron.** Missed runs are not lost: a `StartCalendarInterval` job fires on the next
wake, coalescing missed intervals into one. Two things that fail silently otherwise: `USER` and
`LOGNAME` must be set in the plist or Claude Code cannot reach its Keychain credentials and comes
up "Not logged in", and the repo must not live under `~/Desktop`, `~/Documents` or `~/Downloads`,
where TCC refuses launchd entry with a bare "Operation not permitted" and exit 126.

**The schedule is deliberately off the hour.** 08:07, 12:23, 19:11 — a request stream that lands
exactly at `:00` is the easiest kind of machine rhythm for a platform to notice.

**No network means no run.** Writing an empty digest would read as "nothing good today", which is
a different and much worse claim than "I could not look".

## A warning about the three social servers

All three impersonate a logged-in session, which every one of those platforms forbids. LinkedIn
enforces it hardest and specifically targets browser automation: read-only scraping is enough to
get an account restricted, and first-offence suspensions happen. Use a throwaway account, cap
daily volume rather than just per-minute rate, and do not run around the clock — a request stream
with no circadian rhythm is the easiest thing in the world to spot. Screeners are capped at three
in flight for the same reason, and because each one drives its own browser.

Every tool that posts, messages or reacts is in `deny` in `.claude/settings.json`. That file is
project-scoped, so the deny list only applies inside this repo — running `/feed_digest` from
elsewhere leaves those write tools reachable. Copy the list into `~/.claude/settings.json` to
have it everywhere.
