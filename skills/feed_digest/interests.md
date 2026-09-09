# Screening criteria

This file is the foundation of `/feed_digest`. It updates itself: at the top of every run the
agent digests the rows you rated in the Notion `Feed Digest` into new examples, and retires old
examples that the prose above now states outright and that no longer teach a boundary. The prose
itself changes only when two or more ratings point at the same cause. Changes go into git, and
`git log -p skills/feed_digest/interests.md` shows how the standard drifted.

You can edit this file directly at any time. What you write by hand counts exactly as much as
what the agent writes.

**Ceiling of 200 lines; at the ceiling you rewrite, you do not append.** The `Comment` you leave
in Notion stays attached to that row forever — that is the archive. This file is the distillate,
not a log. One comment does not change anything here; it takes two or more pointing at the same
cause. And before writing the change, test it against the rows already marked 👍: if the new rule
would have rejected any of them, it has overshot, so weaken it or leave it out for now.

---

## What I care about

- **Company intelligence.** Fast-growing AI startups — funding, hiring, team moves, what the
  founders are actually building. Especially the ones at the stage where the growth expectation
  is already legible and the failure odds are low. **This is the top priority.**
- **Open source projects.** Interesting AI products. Finding a good open source project is like
  finding a good startup — **on a par with company intelligence** — and one whose team is hiring
  ranks higher still: hiring means it is no longer a side project, it is a company taking shape.
- **AI agent technical trends.** Agents that write code internally rather than dispatching to
  other agents; MCP and other services built for agents rather than for people; dev tools for AI
  agents; how a long-horizon agent holds its state together.
- **Startup judgement.** Post-mortems on specific ideas, above all "why this idea does not hold
  up" — more useful than success stories, which are too heavily survivorship-biased.
- **Product taste.** Simple, organized, futuristic, close to the user, large user base, consumer.
  The reference points are search, Notion, Google Search.
- **The Bay Area / YC ecosystem.**

## What I do not want to see

- **Self-promotion dressed as a lesson.** Underneath it is an ad funnelling traffic to the
  author's own product. **Funding amounts, feature lists and "the problem we are solving" are all
  the founder's own account, and do not count** — startup projects need careful vetting, and the
  overwhelming majority of them are worthless. A startup earns a place on the list because
  someone is already using it, or because the pain it addresses stands up independently of the
  post, never because the founder writes well or just closed a round.
- TikTok-style content, short video, anything whose selling point is instant gratification.
- "10 AI tools to boost your productivity" listicles with no judgement added.
- AI PPT generators and that whole class of short bets against the model: a better model ships
  and the product is dead.
- Generic B2B SaaS discussion.
- **Model release posts.** Benchmarks, parameter counts, licences, architecture details — there
  are far too many of these, unless the model is genuinely significant. Trying to rescue a
  release post with production data from the comments or an open licence does not work: a post is
  whatever its main body is.

---

## Reddit subscriptions

The Reddit server uses an anonymous client with no logged-in session, so it cannot see your
subscriptions. Hence the manual list.

```
r/LocalLLaMA  r/MachineLearning  r/ExperiencedDevs
r/ycombinator  r/startups  r/SaaS  r/cscareerquestions
```

---

## Examples

The examples below are here to settle boundary calls.

### Selected

- "Edviro (YC S26): a world model for building energy, starting in schools" · "interesting
  startup model, not vague grandstanding, a real pain point" — a specific wedge, a pain that
  genuinely exists in the physical world, hard enough constraints
- "Sequoia's David Cahn: the money and the team are in place, now what" · startup judgement, and
  built as a reversal rather than as a success story

### Rejected

- "Turnstone (YC W26): a second brain for your agent, on your own Mac" · "pointless, another
  infra play, nobody will use it" — coming out of YC and having a clean shape do not save it;
  one more layer of agent infrastructure is not itself a pain point
- "Wafer AI raises a $40M Series A for infrastructure that auto-tunes inference deployment" ·
  "company intelligence really is the top priority, but this company is all air. Describing a
  product is not having one, and saying what you want to build is not the market accepting it" —
  the funding number and the four-layer optimisation feature list are all self-reported, with no
  sign of usage or customers
- "Vespper DOCX MCP: an MCP service purpose-built for agents editing Word documents" ·
  fundamentally the founder's own launch post; "3x faster / 2x cheaper" is a self-reported
  internal benchmark with no third-party usage behind it
- "GLM-5.3-Flash released: a 320B MoE under MIT" · "I don't follow model releases much, there are
  too many, unless the model is significant"
- "Qwen3.8-Flash-Next released: QSA sparse attention" · same. This one was originally taken in on
  the strength of real production data in the comments, which does not hold — the body of the
  post is a model release, so it is a model release post
