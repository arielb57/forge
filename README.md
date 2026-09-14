# forge

Mines the day's engineering trends, decides what is worth building, builds it, and refuses to let it through unless the tests actually prove something.

```
$ forge run

▸ preflight ok — 9.6 GB free, driver claude-cli
▸ collecting trend sources
· hackernews: 40 items   · show-hn: 19 items      · github-rising: 30 items
· lobsters: 25 items     · huggingface: 20 items  · arxiv: 0 items
✓ 123 candidate trends from 134 items across 6 sources

· trend 1: Linux Zoom Client Proactively Reads X11 Clipboard      [hackernews, lobsters]
· trend 2: Hacker News, without AI                                [show-hn]
· trend 3: I made a build visualizer for Bun's compile times      [hackernews, lobsters]
· trend 4: We must pace the frontier                              [hackernews]
· trend 5: Why are AI agents lying, cheating and coordinating?    [hackernews]

▸ ideating 6 specs from 5 trends
· rejected trend "Hacker News, without AI": The core is topic classification of
  titles. Doing it honestly needs a labelled real-world dataset the build agent
  can't get offline, and without that the test suite could only prove a keyword
  list matches its own keywords. That's a filter wrapper, not a project.
✓ 6/6 specs passed validation

▸ building xselaudit (typescript)
· gate: running node test suite
✓ gate passed: 131 tests, 316 assertions, 2936-word README
✓ xselaudit is ready for review
```

That run is real. What it and its successor produced:

| project | language | what it does | tests | assertions |
|---|---|---|---:|---:|
| [xselaudit](https://github.com/arielb57/xselaudit) | TypeScript | Records X11 traffic through a proxy and reports which clients read the clipboard without a paste — classifying each read as user-initiated, proactive, self or unexplained | 131 | 316 |
| [buildcrit](https://github.com/arielb57/buildcrit) | Rust | Causal profiling for Ninja builds: which edge, if faster, would actually shorten wall-clock time. Prunes with proven upper bounds and certifies when the pruned ranking equals the exhaustive one | 48 | 229 |

Both have zero runtime dependencies and green CI on Ubuntu. Both carry a `.forge.json` manifest recording that this pipeline produced them.

## The problem

Trend feeds tell you what people are talking about. They do not tell you what is worth building, and the gap between the two is where most side projects die — you read something interesting, you build a thin wrapper around it, and three weeks later nobody has looked at it including you.

The failure is not a lack of ideas. It is that nothing between the idea and the repository enforces a standard. Nobody checks whether the tests test anything. Nobody checks whether the README explains the approach or just lists the commands. Nobody says *no* to an idea that was never going to be interesting.

forge is that missing layer. It reads six sources, ranks what it finds, turns the survivors into specifications, builds them, and then tries hard to reject its own output.

## How it works

Four stages. Each one throws away most of what the previous one produced.

### 1. Collection — six sources, one axis

Hacker News, Show HN, GitHub's fastest-rising new repositories, Lobsters, Hugging Face trending models, and arXiv's cs.LG/cs.AI/cs.SE feeds. Roughly 130 items on a normal day. Sources are collected concurrently and independently: a source that is down, rate-limited or has changed its schema drops out of the run rather than ending it.

Their scores are not comparable. Hugging Face counts downloads in the millions; Lobsters counts upvotes in the dozens. Ranking raw scores puts every Hugging Face model above every discussion on the internet.

So each item is ranked **within its own source** and keeps only its percentile. A story at the top of Lobsters and a model at the top of Hugging Face both score 1.0, and the comparison becomes meaningful.

### 2. Clustering — corroboration is the signal

Items are clustered by Jaccard similarity over their title tokens (single-link, threshold 0.34). The cluster score is:

```
score = Σ (percentile × source_weight × recency) × (1 + log₂(distinct_sources) × 0.6)
```

The last factor is the point of the whole stage. One front page is one front page. The same story surfacing independently on Hacker News *and* Lobsters *and* GitHub is a real shift in attention. Corroboration is deliberately sub-linear — three sources beats one substantially, but not by 3×, or every cluster collapses toward whichever story got picked up most widely.

Recency decays with a 10-day half-life, floored at 0.35: old things get quieter, never silent.

### 3. Ideation — mostly saying no

The ranked trends go to a model with a brief whose largest section is a list of things that are not projects: wrappers, clones, tutorials, boilerplate, dashboards with no computation underneath, anything whose entire value is a prompt string.

What gets through needs a technical core — something that has to be *worked out*. An algorithm with a measurable property. A parser with a spec to match. A differential tester. A measurement that produces a number nobody had before.

The brief insists that a trend is raw material, not a subject. "Everyone is upset that Zoom reads the X11 clipboard" is not a project; what it *tells* you is that clipboard access on Linux is an under-inspected attack surface, and that yields an auditing tool. Ideation is asked for twice as many specs as will be built, is expected to reject trends outright, and every spec is checked against everything shipped in the last 45 days before it can proceed.

### 4. The quality gate — the part that matters

The gate is why this is not a repository mill. It runs after every build and blocks publication on any of:

| Check | Rejects when |
|---|---|
| Test suite | The standard runner fails, or times out |
| Test substance | Fewer than 3 cases, or fewer than 6 assertions |
| Test honesty | ≥30% of assertions compare a literal to itself |
| Lint | The project's own linter fails — `cargo fmt` and `clippy -D warnings`, `npm run lint`, `ruff` |
| Entry point | The CLI crashes on `--help`, or prints nothing at all |
| Placeholders | Any `TODO`, `FIXME`, `NotImplementedError`, `todo!()`, `unimplemented!()` |
| README depth | Under 250 words, no code block, or never explains the approach |
| Substance | Fewer than 2 source files |

Warnings — a missing LICENSE, no CI, no limitations section, a promised benchmark that never appeared — do not block, but they travel with the project into review so a human sees them.

`assertEqual(1, 1)` passing is the single most common way generated code looks finished and is not. The gate counts assertions, then counts how many of them compare two identical literals, and rejects the suite if too many do.

**Does the gate's standard actually hold?** One way to find out is to break a project on purpose and see whether its own suite notices. Widening `xselaudit`'s input window by a factor of a thousand — a change that compiles cleanly and quietly turns every proactive clipboard read into a legitimate-looking one, which is the exact bug that would make the tool useless — failed four tests, among them *"the input window is configurable and inclusive at its edge"* and *"input between the notification and the read (outside the window) makes it unexplained, not proactive"*. That is what the assertion counting is a proxy for.

The lint and entry-point checks were both added after a project got past the gate and should not have. One passed with green tests and then failed its own CI on a clippy lint — the gate ran the test suite and nothing else, while the workflow it had just written ran `clippy -D warnings`. Whatever CI enforces, the gate now enforces first. The other gap was simpler: nothing ever ran the program. A library whose tests pass while its CLI panics on startup is worse than one that fails loudly, because it looks finished.

## Nothing publishes itself

`forge run` ends at a review queue and stops. Publishing is a separate command you type:

```bash
forge review              # what passed the gate, with its stats and warnings
forge ship <name>         # create the repo and push — only after you have read it
```

This is deliberate, for two reasons. An unattended process that writes code and pushes it to the public internet is a bad thing to build regardless of how good the gate is. And more practically: a repository you have not read is a repository you cannot defend when somebody asks you about it.

The build agent runs under a narrow allowlist: it can write files and run package managers and test runners, and nothing else. It has no git access — publishing is forge's job, not the model's.

It also has no filesystem search tools, which is not an oversight. `Glob` and `Grep` take an explicit path and honour no workspace boundary; the first real run proved it, when an agent that could not find a TypeScript compiler went looking across the whole disk and started reading an unrelated private project. A project being built from an empty directory has nothing to search, so removing them costs nothing.

The agent may install packages during a build — that is ordinary — but the finished project must run with no network at all.

Commits are split into logical stages (scaffold → core → tests → docs) because that is the order the work happens in, and each message names the modules it actually contains — `Implement wire, state, classify` rather than `Implement core`. Identical commit messages across every repository is the loudest automation tell there is.

They are never backdated. Faking a development history is falsifying a record, and better commit messages for real staged content is not the same thing.

## Install

Requires Node 20+, and either the [Claude Code CLI](https://claude.com/claude-code) or an `ANTHROPIC_API_KEY`.

```bash
git clone https://github.com/arielb57/forge
cd forge
npm test                  # no dependencies to install — there are none
```

## Usage

```bash
forge trends              # today's ranked trends, then stop
forge ideate              # the specs those trends produce, then stop
forge run                 # the whole pipeline, into the review queue
forge run --target 1      # build one project instead of three
forge run --dry-run       # go through the motions, build nothing
forge run --repeat 5      # five consecutive runs, sweeping artefacts between

forge review              # what is waiting for you
forge show <name>         # one project's full gate report
forge gate <name>         # re-run the gate after editing by hand
forge ship <name>         # publish to GitHub

forge clean               # delete build artefacts of published projects
forge doctor              # can this machine run a build?
forge status              # ledger summary
```

Run it daily:

```bash
./scripts/schedule.sh install 09:00
./scripts/schedule.sh status
```

The scheduled job runs `forge run` only. It cannot publish.

## Configuration

Optional `forge.config.json` in the project root:

```json
{
  "owner": "arielb57",
  "projectsPerDay": 3,
  "topicCooldownDays": 45,
  "buildTimeoutMinutes": 25,
  "driver": "claude-cli",
  "model": "opus"
}
```

The review gate is not configurable. Turning it off means editing `src/config.js` on purpose.

Two drivers ship:

- **`claude-cli`** — drives the Claude Code CLI with `--allowedTools` scoped to file edits and build commands.
- **`anthropic-api`** — the Anthropic SDK with its own agent loop, for running without a Claude Code subscription. Every path is confined to the project directory and every command is matched against an allowlist before it runs.

## Design notes

**Why rank within a source instead of normalising scores.** The obvious approach is a z-score per source. It fails because these distributions are not remotely normal — Hacker News points are roughly log-distributed with a very long tail, Hugging Face downloads span six orders of magnitude, and arXiv has no popularity signal at all. Percentile rank makes no distributional assumption. It costs the *magnitude* of a signal, which sounds like a loss and is not: for "should I build something about this", the difference between the #1 and #2 story matters and the difference between 4,000 and 8,000 upvotes does not.

**Why single-link clustering.** It is the wrong algorithm on paper — single-link chains, so A~B and B~C pulls in A~C even when A and C are unrelated. With a 0.34 threshold on short title token sets that chaining almost never fires, and single-link catches the case that actually matters: the same story titled differently on two sites. Something like HDBSCAN would be more principled and would need an embedding model, a dependency, and a lot more code, to make a decision that gets thrown away if the trend is stale.

**Why the gate is heuristic rather than a model judging its own output.** Asking a model "is this good?" produces agreement, not judgement. Counting assertions, running the suite, and grepping for `todo!()` produces facts. The heuristics are crude and they are checkable, which is the trade this project wants — a gate you cannot argue with is worth more than a gate that is usually right.

**Why zero dependencies.** Not minimalism for its own sake: the pipeline runs unattended on a schedule, and every dependency is a way for a run at 09:00 to fail for reasons unrelated to the run. Node 20's standard library covers all of it.

## Limitations

- **The projects are model-generated.** forge decides *what* to build and proves the result works; a language model writes the code. The gate raises the floor a great deal and does not make the output equivalent to hand-written work. Anything published from here should say so.
- **The gate measures shape, not insight.** It can tell that 96 assertions exist and that none of them compare `1` to `1`. It cannot tell whether they test the interesting cases. Reading the code is not optional, which is why publishing requires a human.
- **Build scope is capped by the session.** Roughly 20 minutes, offline, no credentials. That rules out anything needing an API key, a database, or a service — a real constraint on what kinds of project can exist here.
- **arXiv is quiet at weekends** by design (`skipDays`), so Saturday and Sunday runs are five sources, not six.
- **Trend sources are third-party APIs** and change without notice. `scripts/check-sources.js` runs in CI to catch that.
- **Deduplication is lexical.** Two projects described in entirely different words will not be caught as duplicates by a Jaccard threshold.

## License

MIT
