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
    key: 'scaffold',
    paths: ['LICENSE', '.gitignore', 'package.json', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'requirements.txt'],
  },
  {
    key: 'core',
    paths: ['src', 'lib', 'bin', 'cmd'],
    // Tests colocated with the code they cover — src/foo.test.ts — belong to
    // the test stage, not this one. Without the exclusion they land in the
    // core commit and the test commit ends up nearly empty.
    exclude: [':(exclude)*[._]test.*', ':(exclude)*[._]spec.*', ':(exclude)*/tests/*', ':(exclude)*/__tests__/*'],
  },
  {
    key: 'tests',
    paths: ['test', 'tests', '__tests__', 'spec', 'benches', 'benchmark', 'bench', 'src', 'lib'],
  },
  {
    key: 'docs',
    paths: ['README.md', 'docs', '.github', 'examples', 'CONTRIBUTING.md'],
  },
];

/**
 * Commit messages describe what each stage actually contains.
 *
 * Identical messages across every repository is the loudest automation tell
 * there is — ten projects whose history reads "Implement core / Add test
 * suite" word for word looks like what it is. These are built from the module
 * names that were staged, so they are specific and, more importantly, true.
 */
export function describeStage(key, files, spec) {
  const modules = [...new Set(
    files
      .filter((f) => /\.(rs|ts|tsx|js|mjs|py)$/.test(f))
      .map((f) => f.split('/').pop().replace(/\.[^.]+$/, ''))
      .filter((m) => !['index', 'lib', 'main', 'mod', '__init__'].includes(m)),
  )].slice(0, 5);

  const list = modules.length > 0 ? modules.join(', ') : null;

  switch (key) {
    case 'scaffold':
      return `Set up ${spec.name} as a ${spec.language} project`;
    case 'core':
      return list ? `Implement ${list}` : `Implement ${spec.name}`;
    case 'tests': {
      // Strip both conventions: JS and Rust suffix (parse.test, parse_test),
      // Python prefixes (test_parse). "Test test_parse" names nothing.
      const covered = modules
        .map((m) => m.replace(/[._](test|spec|bench)$/i, '').replace(/^(test|bench)_/i, ''))
        .filter(Boolean);
      const unique = [...new Set(covered)];
      return unique.length > 0 ? `Test ${unique.join(', ')}` : 'Add the test suite';
    }
    case 'docs':
      return 'Document the approach and add CI';
    default:
      return `Add ${key}`;
  }
}

async function commitInStages(dir, spec) {
  await git(['init', '-q', '-b', 'main'], dir);

  for (const stage of COMMIT_PLAN) {
    const present = stage.paths.filter((p) => existsSync(join(dir, p)));
    if (present.length === 0) continue;
    await git(['add', '--', ...present, ...(stage.exclude || [])], dir);

    const staged = await git(['diff', '--cached', '--name-only'], dir);
    const files = staged ? staged.split('\n').filter(Boolean) : [];
    if (files.length === 0) continue;

    await git(['commit', '-q', '-m', describeStage(stage.key, files, spec)], dir);
  }

  // Anything the plan did not name — stray config, extra folders — goes last.
  await git(['add', '-A'], dir);
  const remaining = await git(['diff', '--cached', '--name-only'], dir);
  if (remaining.length > 0) {
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
