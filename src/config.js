import { join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

  /** Ledger + dedup index. */
  dataDir: join(ROOT, 'data'),

  /**
   * A topic that shipped less than this many days ago is not eligible again.
   * Repeating yourself is the fastest way to make a portfolio look automated.
   */
  topicCooldownDays: 45,

  /** Wall-clock budget for a single project build, in minutes. */
  buildTimeoutMinutes: 40,

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

// The review gate is a safety property, not a preference: a config file cannot
// switch it off. Removing it means editing this file, deliberately.
delete overrides.requireReviewBeforePublish;

export const config = { ...DEFAULTS, ...overrides, root: ROOT };
export { ROOT };
