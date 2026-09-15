import { join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { totalmem, cpus } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Values a user is likely to change live in forge.config.json (git-ignored, optional). */
const DEFAULTS = {
  /** GitHub account that owns the published repositories. */
  owner: 'arielb57',

  /** How many projects a single daily run is allowed to produce. */
  projectsPerDay: 3,

  /** How many trends to surface before ideation narrows them down. */
  trendsPerDay: 5,

  /**
   * Ideation asks for more specs than we build, so the quality gate can reject
   * a project without the whole day coming up empty.
   */
  ideaOversample: 2,

  /** Where generated repositories are built and kept. */
  workspace: join(ROOT, 'workspace'),

  /**
   * Ledger + dedup index. Overridable so the test suite can exercise the store
   * against a throwaway directory instead of the real ledger.
   */
  dataDir: process.env.FORGE_DATA_DIR || join(ROOT, 'data'),

  /**
   * A topic that shipped less than this many days ago is not eligible again.
   * Repeating yourself is the fastest way to make a portfolio look automated.
   */
  topicCooldownDays: 45,

  /**
   * Wall-clock budget for a single project build.
   *
   * Measured, not guessed: a 24-file project with 131 tests and a 2900-word
   * README was cut off at 40 minutes having already finished the work — the
   * agent was wrapping up when SIGTERM arrived. `forge continue` recovers that
   * case, but the budget should not routinely need it.
   */
  buildTimeoutMinutes: 55,

  /** LLM driver: 'claude-cli' (subscription) or 'anthropic-api' (API key). */
  driver: process.env.FORGE_DRIVER || 'claude-cli',

  /** Model alias passed through to whichever driver is active. */
  model: process.env.FORGE_MODEL || 'opus',

  /**
   * Publishing is never automatic. The pipeline builds into a review queue and
   * stops; `forge ship` pushes a reviewed project to GitHub. Nothing reaches a
   * public URL without a human running that command.
   */
  requireReviewBeforePublish: true,

  /** Repositories are created public — the whole point is the portfolio. */
  visibility: 'public',
};

function loadOverrides() {
  const path = join(ROOT, 'forge.config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`forge.config.json is not valid JSON: ${err.message}`);
  }
}

const overrides = loadOverrides();

/**
 * Cap Cargo's parallelism for everything forge starts — the build agent's own
 * `cargo test` and the gate's. By default Cargo runs one rustc per core, each
 * several hundred MB, and on an 8 GB machine already hosting other Claude
 * sessions that got a whole production loop killed for lack of memory in the
 * middle of a Rust build. Set before any child process is spawned, so both the
 * agent and the gate inherit it. An explicit CARGO_BUILD_JOBS still wins.
 */
if (!process.env.CARGO_BUILD_JOBS) {
  const gb = totalmem() / 1024 ** 3;
  process.env.CARGO_BUILD_JOBS = String(overrides.cargoJobs ?? (gb <= 8 ? 2 : gb <= 16 ? 4 : cpus().length));
}

// The review gate is a safety property, not a preference: a config file cannot
// switch it off. Removing it means editing this file, deliberately.
delete overrides.requireReviewBeforePublish;

export const config = { ...DEFAULTS, ...overrides, root: ROOT };
export { ROOT };
