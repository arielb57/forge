import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statfsSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { log } from './log.js';

const exec = promisify(execFile);

/**
 * Checks run before a daily build starts.
 *
 * A scheduled job fails at 09:00 with nobody watching, so the failure has to be
 * legible hours later from a log line. Each check reports what is wrong and how
 * to fix it, rather than letting the run die halfway through with an ENOSPC
 * from deep inside npm.
 */

/** A single Node project's node_modules and a Rust target/ both run to hundreds of MB. */
const MIN_FREE_GB = 3;
const COMFORTABLE_FREE_GB = 8;

function freeSpaceGb(path) {
  const { bsize, bavail } = statfsSync(path);
  return (bsize * bavail) / 1024 ** 3;
}

async function has(command, args = ['--version']) {
  try {
    await exec(command, args, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function preflight({ requirePublisher = false } = {}) {
  const problems = [];
  const warnings = [];

  mkdirSync(config.workspace, { recursive: true });

  const free = freeSpaceGb(config.workspace);
  if (free < MIN_FREE_GB) {
    problems.push(
      `only ${free.toFixed(1)} GB free — a build needs headroom for node_modules or target/. ` +
      'Free some space (npm cache clean --force is a safe start) before running.',
    );
  } else if (free < COMFORTABLE_FREE_GB) {
    warnings.push(`${free.toFixed(1)} GB free — enough for a run or two, not for a week of them`);
  }

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) problems.push(`Node ${process.versions.node} is too old — forge needs 20 or newer`);

  if (config.driver === 'claude-cli') {
    if (!(await has('claude'))) {
      problems.push('the claude CLI is not on PATH — install it, or set driver to "anthropic-api"');
    }
  } else if (config.driver === 'anthropic-api' && !process.env.ANTHROPIC_API_KEY) {
    problems.push('driver is "anthropic-api" but ANTHROPIC_API_KEY is not set');
  }

  // Build toolchains: missing ones do not stop a run, they narrow what the
  // quality gate can verify, so ideation should know to avoid that language.
  const available = {
    node: true,
    python: (await has('python3')) && ((await has('uv')) || (await has('pytest'))),
    rust: await has('cargo'),
  };
  for (const [language, ok] of Object.entries(available)) {
    if (!ok) warnings.push(`no working ${language} toolchain — projects in that language will fail the gate`);
  }

  if (requirePublisher) {
    if (!(await has('gh', ['--version']))) problems.push('the gh CLI is not installed — needed to publish');
    else if (!(await has('gh', ['auth', 'status']))) problems.push('gh is not authenticated — run: gh auth login');
  }

  for (const w of warnings) log.warn(`preflight: ${w}`);

  if (problems.length > 0) {
    for (const p of problems) log.error(`preflight: ${p}`);
    throw new Error(`preflight failed with ${problems.length} problem(s)`);
  }

  log.ok(`preflight ok — ${free.toFixed(1)} GB free, driver ${config.driver}`);
  return { free, available, warnings };
}
