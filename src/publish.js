import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

const exec = promisify(execFile);

async function git(args, cwd) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function gh(args) {
  const { stdout } = await exec('gh', args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

export async function checkGhAuth() {
  try {
    await exec('gh', ['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commits are split along the lines the work actually took: core, then tests,
 * then documentation and CI. This is not cosmetic — a reviewer reading the
 * history should be able to see the order the project was reasoned about.
 *
 * Timestamps are whatever the clock says. Backdating commits to fake a longer
 * development history would be falsifying a record, and this tool does not.
 */
const COMMIT_PLAN = [
  {
    message: 'Add project scaffold and license',
    paths: ['LICENSE', '.gitignore', 'package.json', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'requirements.txt'],
  },
  {
    message: 'Implement core',
    paths: ['src', 'lib', 'bin', 'cmd'],
  },
  {
    message: 'Add test suite',
    paths: ['test', 'tests', '__tests__', 'spec', 'benches', 'benchmark', 'bench'],
  },
  {
    message: 'Add documentation and CI',
    paths: ['README.md', 'docs', '.github', 'examples', 'CONTRIBUTING.md'],
  },
];

async function stagedCount(dir) {
  const out = await git(['diff', '--cached', '--name-only'], dir);
  return out ? out.split('\n').filter(Boolean).length : 0;
}

async function commitInStages(dir, spec) {
  await git(['init', '-q', '-b', 'main'], dir);

  for (const stage of COMMIT_PLAN) {
    const present = stage.paths.filter((p) => existsSync(join(dir, p)));
    if (present.length === 0) continue;
    await git(['add', '--', ...present], dir);
    if ((await stagedCount(dir)) === 0) continue;
    await git(['commit', '-q', '-m', stage.message], dir);
  }

  // Anything the plan did not name — stray config, extra folders — goes last.
  await git(['add', '-A'], dir);
  if ((await stagedCount(dir)) > 0) {
    await git(['commit', '-q', '-m', `Complete ${spec.name}`], dir);
  }

  const count = await git(['rev-list', '--count', 'HEAD'], dir);
  return Number(count);
}

/**
 * Push a reviewed project to GitHub. Called only by `forge ship`, only after a
 * human has looked at the project. Never called by the daily pipeline.
 */
export async function publishProject(spec, dir, { visibility = config.visibility, dryRun = false } = {}) {
  if (!(await checkGhAuth())) {
    throw new Error('gh is not authenticated — run: gh auth login');
  }

  const repo = `${config.owner}/${spec.name}`;

  if (dryRun) {
    log.info(`dry run: would create ${repo} (${visibility}) and push`);
    return { dryRun: true, repo };
  }

  // Refuse to touch a repository that already exists — silently force-pushing
  // over someone's work, including your own, is not an acceptable failure mode.
  try {
    await gh(['repo', 'view', repo, '--json', 'name']);
    throw new Error(`${repo} already exists — rename the project or delete the repo first`);
  } catch (err) {
    if (!/Could not resolve|not found|404/i.test(String(err.stderr || err.message))) {
      if (String(err.message).includes('already exists')) throw err;
    }
  }

  const commits = await commitInStages(dir, spec);
  log.info(`${commits} commits prepared`);

  log.step(`creating ${repo} (${visibility})`);
  await gh([
    'repo', 'create', repo,
    `--${visibility}`,
    '--source', dir,
    '--remote', 'origin',
    '--description', spec.tagline.slice(0, 350),
    '--push',
  ]);

  const topics = [...new Set(spec.topics || [])]
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, ''))
    .filter((t) => t.length > 1 && t.length <= 35)
    .slice(0, 20);

  if (topics.length > 0) {
    try {
      await gh(['repo', 'edit', repo, ...topics.flatMap((t) => ['--add-topic', t])]);
    } catch (err) {
      log.warn(`could not set topics: ${err.message}`);
    }
  }

  const url = `https://github.com/${repo}`;
  log.ok(`published ${url}`);
  return { repo, url, commits, topics };
}

/** Written into each shipped project so the ledger and the repo agree. */
export function writeManifest(dir, spec, gate) {
  writeFileSync(
    join(dir, '.forge.json'),
    `${JSON.stringify({
      name: spec.name,
      tagline: spec.tagline,
      language: spec.language,
      topics: spec.topics || [],
      trendOrigin: spec.trend_origin || null,
      gate: { stats: gate?.stats, warnings: gate?.warnings },
      generatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}
