import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './log.js';

const exec = promisify(execFile);

/**
 * The quality gate is what stops the pipeline from becoming a repository mill.
 * Anything it rejects never reaches the review queue, let alone GitHub.
 *
 * Checks are graded: BLOCKING failures reject the project outright, WARNINGS
 * are reported and travel with the project into review so a human sees them.
 */

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.py', '.rs', '.go']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', '__pycache__', 'dist', 'build', '.venv', 'venv']);

function walk(dir, root = dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, out, depth + 1);
    else out.push({ path: full, rel: relative(root, full) });
  }
  return out;
}

async function run(command, args, cwd, timeoutMs = 600_000) {
  try {
    const { stdout, stderr } = await exec(command, args, {
      cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err) {
    return {
      ok: false,
      output: `${err.stdout || ''}${err.stderr || ''}${err.message}`,
      timedOut: err.killed === true,
    };
  }
}

function detectToolchain(dir) {
  if (existsSync(join(dir, 'package.json'))) return 'node';
  if (existsSync(join(dir, 'Cargo.toml'))) return 'rust';
  if (
    existsSync(join(dir, 'pyproject.toml')) ||
    existsSync(join(dir, 'setup.py')) ||
    existsSync(join(dir, 'requirements.txt')) ||
    walk(dir).some((f) => extname(f.rel) === '.py')
  ) return 'python';
  return null;
}

/** Install dependencies and run the language's standard test command. */
async function runTests(dir, toolchain) {
  switch (toolchain) {
    case 'node': {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const hasDeps =
        Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length > 0;
      if (hasDeps) {
        const install = await run('npm', ['install', '--no-audit', '--no-fund'], dir, 420_000);
        if (!install.ok) return { ...install, phase: 'install' };
      }
      if (!pkg.scripts?.test) return { ok: false, output: 'package.json declares no test script', phase: 'test' };
      return { ...(await run('npm', ['test'], dir)), phase: 'test' };
    }
    case 'python': {
      // uv is present and fast; fall back to the interpreter's own module runner.
      const withUv = await run('uv', ['run', '--quiet', 'pytest', '-q'], dir, 420_000);
      if (withUv.ok) return { ...withUv, phase: 'test' };
      const direct = await run('python3', ['-m', 'pytest', '-q'], dir, 420_000);
      if (direct.ok) return { ...direct, phase: 'test' };
      // Report whichever attempt got furthest rather than the last one blindly.
      const chosen = withUv.output.length > direct.output.length ? withUv : direct;
      return { ...chosen, phase: 'test' };
    }
    case 'rust':
      return { ...(await run('cargo', ['test', '--quiet'], dir, 600_000)), phase: 'test' };
    default:
      return { ok: false, output: 'no recognised toolchain', phase: 'detect' };
  }
}

/**
 * Tests that pass mean nothing if they assert nothing. This looks for the
 * shape of a real suite: enough cases, enough assertions, and assertions that
 * are not merely comparing two literals.
 */
function assessTests(dir) {
  const files = walk(dir).filter((f) => {
    const name = f.rel.toLowerCase();
    return (
      SOURCE_EXTENSIONS.has(extname(f.rel)) &&
      (name.includes('test') || name.includes('spec') || name.startsWith('tests/'))
    );
  });

  if (files.length === 0) return { cases: 0, assertions: 0, trivial: 0, files: 0 };

  let cases = 0;
  let assertions = 0;
  let trivial = 0;

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file.path, 'utf8');
    } catch { continue; }

    cases += (text.match(/\b(?:it|test|def test_|#\[test\]|describe)\s*[(\w]/g) || []).length;
    assertions += (text.match(/\b(?:assert\w*|expect|should)\s*[(!.]/g) || []).length;
    // assert_eq!(2, 2) / assertEqual(1, 1) / expect(true).toBe(true)
    trivial += (text.match(/assert\w*[(!]\s*(\d+|true|false|"[^"]*")\s*,?\s*(\d+|true|false|"[^"]*")?\s*\)/g) || [])
      .filter((m) => {
        const nums = m.match(/\d+|true|false/g) || [];
        return nums.length >= 2 && nums[0] === nums[1];
      }).length;
  }

  return { cases, assertions, trivial, files: files.length };
}

const PLACEHOLDER_RE = /\b(TODO|FIXME|XXX|HACK)\b|NotImplementedError|todo!\(\)|unimplemented!\(\)|throw new Error\(['"]not implemented/i;

function findPlaceholders(dir) {
  const hits = [];
  for (const file of walk(dir)) {
    if (!SOURCE_EXTENSIONS.has(extname(file.rel)) && extname(file.rel) !== '.md') continue;
    let text;
    try {
      text = readFileSync(file.path, 'utf8');
    } catch { continue; }
    text.split('\n').forEach((line, i) => {
      if (PLACEHOLDER_RE.test(line)) hits.push(`${file.rel}:${i + 1} ${line.trim().slice(0, 90)}`);
    });
  }
  return hits;
}

function assessReadme(dir) {
  const path = ['README.md', 'readme.md', 'Readme.md'].map((n) => join(dir, n)).find(existsSync);
  if (!path) return { exists: false };

  const text = readFileSync(path, 'utf8');
  const lower = text.toLowerCase();
  const headings = (text.match(/^#{1,3}\s+.+$/gm) || []).length;

  return {
    exists: true,
    words: text.split(/\s+/).filter(Boolean).length,
    headings,
    hasCodeBlock: /```/.test(text),
    // A README that never explains the approach is a README nobody learns from.
    explainsApproach: /how it works|approach|algorithm|architecture|design|implementation/i.test(text),
    hasLimitations: /limitation|not supported|does not|caveat|known issue/i.test(lower),
    hasUsage: /usage|install|getting started|quick ?start/i.test(lower),
  };
}

export async function runGate(dir, spec) {
  const blocking = [];
  const warnings = [];

  const toolchain = detectToolchain(dir);
  if (!toolchain) {
    return { passed: false, blocking: ['no recognisable project (no package.json, Cargo.toml or Python sources)'], warnings: [], toolchain: null };
  }

  const sourceFiles = walk(dir).filter((f) => SOURCE_EXTENSIONS.has(extname(f.rel)));
  if (sourceFiles.length < 2) blocking.push(`only ${sourceFiles.length} source file(s) — nothing was really built`);

  log.info(`gate: running ${toolchain} test suite`);
  const tests = await runTests(dir, toolchain);
  if (!tests.ok) {
    const tail = tests.output.split('\n').filter(Boolean).slice(-12).join('\n');
    blocking.push(`${tests.phase} failed${tests.timedOut ? ' (timed out)' : ''}:\n${tail}`);
  }

  const suite = assessTests(dir);
  if (suite.files === 0) blocking.push('no test files found');
  else if (suite.cases < 3) blocking.push(`only ${suite.cases} test case(s) — the suite does not exercise the core`);
  else if (suite.assertions < 6) blocking.push(`only ${suite.assertions} assertion(s) across ${suite.cases} cases`);
  if (suite.trivial > 0 && suite.trivial >= suite.assertions * 0.3) {
    blocking.push(`${suite.trivial} of ${suite.assertions} assertions compare a literal to itself`);
  }

  const placeholders = findPlaceholders(dir);
  if (placeholders.length > 0) {
    blocking.push(`${placeholders.length} placeholder(s) left in the code:\n  ${placeholders.slice(0, 6).join('\n  ')}`);
  }

  const readme = assessReadme(dir);
  if (!readme.exists) blocking.push('no README.md');
  else {
    if (readme.words < 250) blocking.push(`README is ${readme.words} words — too thin for a stranger to use this`);
    if (!readme.hasCodeBlock) blocking.push('README has no code block — no usage a reader can copy');
    if (!readme.explainsApproach) blocking.push('README never explains how it works');
    if (!readme.hasUsage) warnings.push('README has no clear install/usage section');
    if (!readme.hasLimitations) warnings.push('README states no limitations — reviewers read that section first');
  }

  if (!existsSync(join(dir, 'LICENSE'))) warnings.push('no LICENSE file');
  if (!existsSync(join(dir, '.gitignore'))) warnings.push('no .gitignore');
  if (!existsSync(join(dir, '.github', 'workflows'))) warnings.push('no CI workflow');

  if (spec?.benchmark && spec.benchmark !== 'null') {
    const hasBench = walk(dir).some((f) => /bench|perf/i.test(f.rel));
    if (!hasBench) warnings.push('the spec promised a benchmark and none is present');
  }

  const passed = blocking.length === 0;
  const report = {
    passed,
    blocking,
    warnings,
    toolchain,
    stats: {
      sourceFiles: sourceFiles.length,
      testFiles: suite.files,
      testCases: suite.cases,
      assertions: suite.assertions,
      readmeWords: readme.words || 0,
      testsPassed: tests.ok,
    },
    testOutput: tests.output.split('\n').filter(Boolean).slice(-25).join('\n'),
  };

  if (passed) log.ok(`gate passed: ${suite.cases} tests, ${suite.assertions} assertions, ${readme.words}-word README`);
  else log.error(`gate rejected ${spec?.name || dir}: ${blocking.length} blocking issue(s)`);
  for (const w of warnings) log.warn(`  warning: ${w}`);

  return report;
}
