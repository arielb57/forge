/**
 * Pure text analysis used by the quality gate.
 *
 * These live apart from gate.js because they are the gate's actual judgement —
 * everything else there is filesystem plumbing and process spawning. Kept pure,
 * they can be tested directly against the exact code shapes they need to catch.
 */

/** Test-case declarations across the three toolchains forge builds for. */
const CASE_RE = /\b(?:it|test|describe)\s*[(`]|^\s*def\s+test_\w+|#\[test\]/gm;

/**
 * Assertion sites. Deliberately broad: under-counting weakens the gate.
 *
 * The second alternative is Python's statement form. Requiring a bracket after
 * `assert` matched `assert.equal(...)` and `assert_eq!(...)` but never
 * `assert x == y`, so every Python project scored zero assertions and was
 * rejected however well it was tested.
 */
const ASSERTION_RE = /\b(?:assert\w*\s*[(!.]|assert\s+[^\s;{(]|expect\s*[(.]|should\s*[(.]|pytest\.raises\s*\(|assertRaises\s*\()/g;

/**
 * An assertion whose arguments are all literals — `assertEqual(1, 1)`,
 * `assert_eq!(2, 2)`, `expect(true).toBe(true)`. These pass unconditionally and
 * are the most common way generated code looks tested and is not.
 */
const LITERAL = String.raw`\s*(-?\d+(?:\.\d+)?|true|false|None|null|nil|"[^"]*"|'[^']*')\s*`;
// `!?\s*\(` so this covers both `assertEqual(a, b)` and Rust's `assert_eq!(a, b)`.
const TRIVIAL_CALL_RE = new RegExp(String.raw`\bassert\w*\s*!?\s*\(${LITERAL},${LITERAL}\)`, 'g');
const TRIVIAL_EXPECT_RE = new RegExp(
  String.raw`\bexpect\s*\(${LITERAL}\)\s*\.\s*(?:to)?(?:Be|Equal|toBe|toEqual|equal|be)\s*\(${LITERAL}\)`,
  'gi',
);
/** `assert True`, `assert 1`, `assert!(true)` — no comparison at all. */
const TRIVIAL_BARE_RE = /\bassert!?\s*\(?\s*(?:true|True|1)\s*\)?\s*(?:[;,)]|$)/gm;

const normalizeLiteral = (value) => String(value).trim().replace(/^['"]|['"]$/g, '');

function countTrivial(text) {
  let count = 0;

  for (const match of text.matchAll(TRIVIAL_CALL_RE)) {
    if (normalizeLiteral(match[1]) === normalizeLiteral(match[2])) count += 1;
  }
  for (const match of text.matchAll(TRIVIAL_EXPECT_RE)) {
    if (normalizeLiteral(match[1]) === normalizeLiteral(match[2])) count += 1;
  }
  count += (text.match(TRIVIAL_BARE_RE) || []).length;

  return count;
}

/** Counts of what a single test file actually contains. */
export function countTestSignals(text) {
  return {
    cases: (text.match(CASE_RE) || []).length,
    assertions: (text.match(ASSERTION_RE) || []).length,
    trivial: countTrivial(text),
  };
}

const PLACEHOLDER_RE =
  /\b(?:TODO|FIXME|XXX|HACK)\b|NotImplementedError|todo!\(\)|unimplemented!\(\)|pass\s*#\s*implement|throw new Error\(['"]not implemented/i;

/** Placeholder markers with their 1-based line numbers. */
export function findPlaceholders(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (PLACEHOLDER_RE.test(line)) hits.push({ line: i + 1, text: line.trim().slice(0, 90) });
  });
  return hits;
}

/** Structural measurements of a README, used to judge whether it is real. */
export function assessReadmeText(text) {
  return {
    words: text.split(/\s+/).filter(Boolean).length,
    headings: (text.match(/^#{1,3}\s+\S.*$/gm) || []).length,
    // Fenced blocks (``` or ~~~) and indented ones: CommonMark treats a line
    // indented four spaces after a blank line as code. Checking only for
    // backticks rejected a 2,100-word README full of copyable commands.
    hasCodeBlock: /```|~~~/.test(text) || /(^|\n)[ \t]*\n( {4}|\t)\S/.test(text),
    // A README that never explains the approach teaches the reader nothing.
    explainsApproach: /how it works|approach|algorithm|architecture|design|implementation|why it/i.test(text),
    hasLimitations: /limitation|not supported|does not|doesn't|caveat|known issue|out of scope/i.test(text),
    hasUsage: /usage|install|getting started|quick ?start|## run/i.test(text),
  };
}

/**
 * Turn per-file counts into a verdict. Separated from the counting so the
 * thresholds are readable in one place and testable without a filesystem.
 */
export function judgeTests({ files, cases, assertions, trivial }) {
  const blocking = [];
  if (files === 0) blocking.push('no test files found');
  else if (cases < 3) blocking.push(`only ${cases} test case(s) — the suite does not exercise the core`);
  else if (assertions < 6) blocking.push(`only ${assertions} assertion(s) across ${cases} cases`);

  if (assertions > 0 && trivial >= assertions * 0.3) {
    blocking.push(`${trivial} of ${assertions} assertions are vacuous (a literal compared to itself)`);
  }
  return blocking;
}
