# Build brief

You are building one complete open-source project, alone, in this directory,
in a single session. Nobody will fix it after you. What you leave on disk is
what gets published.

## The specification

**{{NAME}}** — {{TAGLINE}}

- **Language:** {{LANGUAGE}}
- **Problem:** {{PROBLEM}}
- **Technical core:** {{CORE}}
- **Deliverables:** {{DELIVERABLES}}
- **How correctness is proven:** {{VERIFICATION}}
- **Benchmark:** {{BENCHMARK}}

## Hard constraints

- **Stay inside this directory.** Everything you create, read or run lives
  here. Do not read, search or borrow from anywhere else on this machine —
  other projects on this disk are private and unrelated. If you need something,
  install it or write it.
- **You may install packages** (`npm install`, `pip`, `cargo add`) — the
  network is available for that. A TypeScript project installing `typescript`
  as a devDependency is entirely normal.
- **The finished project must not need the network to run.** No API calls at
  runtime, no API keys, no external services, no database. Generate any sample
  data with your own code.
- **Runtime dependencies: as close to zero as you can manage.** Standard
  library first. Build and test tooling is fine; every *runtime* dependency is
  one a reviewer will question.
- **A stranger must be able to clone and run it** with the documented commands
  and nothing else.
- Do not initialise git, do not create a remote, do not commit. That is
  handled outside this session.

## What "done" means

A quality gate runs automatically when you stop. It rejects the project — and
nothing gets published — unless all of this holds:

1. **The tests pass**, via the standard runner for the language
   (`npm test` / `pytest` / `cargo test`).
2. **The tests are real.** They exercise the core claim, its edge cases, and
   its failure modes. Tests that assert constants, or that only check the
   happy path, count as no tests at all. This is the single most common way a
   project fails review.
3. **The entry point runs** and does something visible and useful.
4. **The README is written for a stranger** (see below).
5. **No placeholders anywhere.** No `TODO`, no `FIXME`, no `NotImplemented`,
   no stub returning a hard-coded value, no commented-out block "for later".
   An unfinished function is a failed build.
6. **The benchmark, if the spec names one, exists and runs**, and its numbers
   are reproducible by the reader with one command.

## The README

The README is what a reviewer actually reads. Most of them read nothing else.

Required, in this order:

1. **Title and one-line description.**
2. **The problem** — 2-4 sentences. What hurts, for whom, and why the
   existing options do not solve it. Concrete.
3. **How it works** — the actual technical approach. Name the algorithm, the
   data structure, the strategy. This section is what separates a project from
   a homework assignment. Include a short worked example or a diagram if it
   earns its place.
4. **Install and usage** — copy-pasteable commands with their real output.
5. **Results** — the benchmark table or accuracy numbers, if the project makes
   a claim. Say how they were measured and on what hardware.
6. **Design notes** — the interesting decision you made and the trade-off you
   took. One or two paragraphs. Reviewers look for evidence of judgement, and
   this is where it lives.
7. **Limitations** — what it does not do, honestly. This section builds more
   credibility than any other.
8. **License** — MIT.

Write plainly. No marketing voice, no emoji headers, no "🚀 Blazing fast".
State what is true and let it stand.

## Also required

- `LICENSE` — MIT, copyright 2026 Ariel Belhamou.
- `.gitignore` appropriate to the language.
- `.github/workflows/ci.yml` — installs, tests, and lints on push and PR.
  **Pin the toolchain used for linting.** Running a linter in `-D warnings`
  mode against a floating `stable` means a new linter release breaks the build
  with no change to the repository: CI becomes a clock rather than a check.
  Tests may float; lints must not. For Rust, that is
  `dtolnay/rust-toolchain@<exact version>` for the clippy and fmt job.
- If you declare a minimum language version (`rust-version`, `engines.node`,
  `requires-python`), give CI a job that actually checks it. An untested
  minimum is a claim, not a fact.
- Inline comments only where the code is genuinely non-obvious: explain *why*,
  never *what*. Do not narrate the code.

## Order of work

You have up to about 45 minutes. Pace yourself against that, and prefer a
smaller thing that is complete to a larger thing that is not.

1. **Write the README first, as a design document.** Problem, approach, the
   commands you intend to support. Writing down how it works before building
   it is the cheapest way to find out that it does not, and it means an
   overrun leaves a documented project rather than an undocumented one.
   Instructions that say "as soon as the core is done" get deferred until
   there is no time left; this one does not.
2. Design and write the core. Test it hard before anything else.
3. Build the CLI or public API around the tested core.
4. Benchmark, if the spec calls for one, and record real measured numbers.
5. **Return to the README** and make every word of it true: replace the
   commands you intended with the ones that exist, paste real output, fill in
   the measured numbers, and write the design notes and limitations now that
   you know what they are.
6. Run the full test suite one final time and fix anything red.

Declare nothing you have not built. If `Cargo.toml` names two binaries or
`package.json` names a script, the file it points at must exist before you move
on — a manifest referring to a missing file fails the build for everyone who
clones it.

Do not report success on a suite you have not just watched pass.

If, partway through, the spec turns out to be unbuildable within the
constraints, do not fake it: build the largest genuinely working subset, and
state plainly in the README what is not covered. An honest smaller project
passes review. A padded one does not.
