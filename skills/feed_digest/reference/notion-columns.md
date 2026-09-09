# Writing a Feed Digest row

Read this at the write step.

Database: `Feed Digest` under the `Work` page.
Data source: `collection://<FEED_DIGEST_DATA_SOURCE>`

One row per surviving post. `Why` is the column that earns the list its trust: name the
thing in `interests.md` it hits and what in the post makes it worth opening. "Relevant to
AI agents" is not a reason. `Verified` gets what the screener actually
established from inside the post and its thread — a specific fact, not "could not verify" as
a placeholder, and never a claim nobody checked.

**Every row gets all ten columns**: `Title`, `URL`, `Platform`, `Author`, `Engagement`,
`Captured`, `Score`, `Summary`, `Why`, `Verified`. `Platform` is one of x, reddit,
xiaohongshu, linkedin; `Author` is the handle or name the feed gave you; `Engagement` is
whatever that platform counts, as a number; `Captured` is this run's date.

The middle four go missing silently — nothing errors and the run still reports success —
and none of them can be recovered afterwards: the URL alone does not carry them, and
re-reading the post later records today's engagement rather than the number that made it
worth writing. So check the columns on the first row you write, not on the last.

**When the feed genuinely did not give you one, leave it empty and say so in the report.**
A LinkedIn share post can carry no identifiable author; a platform can expose no engagement
count. Empty is a fact about the source; an invented value is a lie that nothing downstream
can detect.

**When the post has a title, `Title` is that title, translated.** Reddit and Xiaohongshu
hand you one. Translate it as literally as Chinese will bear — same claim, same emphasis,
no angle of your own bolted on after a colon. The user has to be able to open the link and
recognise the row, and a title you rewrote cannot do that.

**When it has none — X, LinkedIn — write one.** "A self-hosted LLM in 60MB: the real value is
upstairs" is the failure to avoid: the half before the colon is fine, the half after it tells
the reader nothing. "the real value is…", "worth a look", "changes everything about…" are
placeholders where something specific should be. Whatever else you found interesting goes in
`Summary` and `Why`.

**`Summary` is what the post says, in one or two plain sentences.** Short enough to skim,
concrete enough to skip the row on. It is not a shorter `Why`: `Summary` says what the post
is about, `Why` says why it earned a slot.

**`Score` runs 0-100.** The width is the point: it exists so that things which differ can be
scored differently. When a third of the list lands on the same number the score has stopped
carrying information, and the list loses the ordering that makes it scannable.

**`URL` is always the post itself** — the thing you actually found, on the platform you
found it on, so the row stays checkable against its source. Often the thing worth reading
is somewhere else: a paper, a repo, a company page. Put those links in `Why` and say what
each one is. A row whose real payload is an arXiv link should say so in `Why` rather than
quietly swapping the URL, because the post and the paper are different claims — the post
is what the feed served you, and whether it represented the paper honestly is exactly what
the reader needs to be able to check.

Two mechanical notes: the URL column is addressed as `userDefined:URL`, not `URL`, because
`URL` is reserved. `Rating` and `Learned` are the user's and yours respectively — never
set `Rating` yourself.
