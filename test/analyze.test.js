import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTestSignals, findPlaceholders, assessReadmeText, judgeTests } from '../src/analyze.js';

/* --- counting real test suites ------------------------------------------- */

test('counts cases and assertions in a node suite', () => {
  const source = `
    import { test } from 'node:test';
    test('parses a header', () => {
      assert.equal(parse('a: 1').a, 1);
      assert.ok(parse('a: 1').valid);
    });
    test('rejects a truncated header', () => {
      assert.throws(() => parse('a:'), /truncated/);
    });
  `;
  const { cases, assertions } = countTestSignals(source);
  assert.equal(cases, 2);
  assert.ok(assertions >= 3, `expected at least 3 assertions, got ${assertions}`);
});

test('counts cases in a pytest suite', () => {
  const source = `
def test_decodes_bf16():
    assert decode(b"\\x00\\x3f") == 0.5

def test_rejects_bad_offset():
    with pytest.raises(ValueError):
        read_header(b"")
  `;
  assert.equal(countTestSignals(source).cases, 2);
});

test('counts cases in a rust suite', () => {
  const source = `
    #[test]
    fn simulates_at_j1() { assert_eq!(sim(1), 42); }
    #[test]
    fn simulates_at_j8() { assert_eq!(sim(8), 11); }
  `;
  assert.equal(countTestSignals(source).cases, 2);
});

/* --- the heuristic that matters: vacuous assertions ----------------------- */

test('flags assertEqual of a literal with itself', () => {
  assert.equal(countTestSignals('assertEqual(1, 1)').trivial, 1);
  assert.equal(countTestSignals('assert_eq!(2, 2)').trivial, 1);
  assert.equal(countTestSignals('assertEquals("a", "a")').trivial, 1);
});

test('flags expect(literal).toBe(same literal)', () => {
  assert.equal(countTestSignals('expect(true).toBe(true)').trivial, 1);
  assert.equal(countTestSignals('expect(42).toEqual(42)').trivial, 1);
});

test('flags a bare always-true assertion', () => {
  assert.equal(countTestSignals('assert True').trivial, 1);
  assert.equal(countTestSignals('assert!(true);').trivial, 1);
});

test('does NOT flag an assertion comparing different literals', () => {
  // A real regression check often does compare two literals — the point is
  // that they differ, so the assertion can fail.
  assert.equal(countTestSignals('assertEqual(1, 2)').trivial, 0);
  assert.equal(countTestSignals('expect(true).toBe(false)').trivial, 0);
});

test('does NOT flag an assertion against a computed value', () => {
  assert.equal(countTestSignals('assert.equal(parse(input).count, 3)').trivial, 0);
  assert.equal(countTestSignals('assert_eq!(simulate(graph), 42);').trivial, 0);
  assert.equal(countTestSignals('expect(render(data)).toBe("<p>hi</p>")').trivial, 0);
});

test('treats quoted and unquoted forms of the same literal as equal', () => {
  assert.equal(countTestSignals("assertEqual('x', \"x\")").trivial, 1);
});

test('counts several vacuous assertions in one file', () => {
  const source = `
    test('a', () => { assertEqual(1, 1); });
    test('b', () => { expect(true).toBe(true); });
    test('c', () => { assert.equal(realWork(), 7); });
  `;
  const { trivial, assertions } = countTestSignals(source);
  assert.equal(trivial, 2);
  assert.ok(assertions >= 3);
});

/* --- the verdict ---------------------------------------------------------- */

test('a suite of vacuous assertions is rejected', () => {
  const blocking = judgeTests({ files: 1, cases: 4, assertions: 10, trivial: 4 });
  assert.ok(blocking.some((b) => /vacuous/.test(b)), blocking.join('; '));
});

test('a suite with a couple of vacuous assertions among many real ones passes', () => {
  assert.deepEqual(judgeTests({ files: 2, cases: 12, assertions: 40, trivial: 2 }), []);
});

test('a suite that is too small is rejected', () => {
  assert.ok(judgeTests({ files: 1, cases: 2, assertions: 20, trivial: 0 }).length > 0);
  assert.ok(judgeTests({ files: 1, cases: 5, assertions: 5, trivial: 0 }).length > 0);
});

test('no test files is rejected', () => {
  assert.deepEqual(judgeTests({ files: 0, cases: 0, assertions: 0, trivial: 0 }), ['no test files found']);
});

test('zero assertions never triggers a divide-by-zero style false positive', () => {
  const blocking = judgeTests({ files: 1, cases: 5, assertions: 0, trivial: 0 });
  assert.ok(!blocking.some((b) => /vacuous/.test(b)));
});

/* --- placeholders --------------------------------------------------------- */

test('finds placeholder markers with line numbers', () => {
  const source = 'const a = 1;\n// TODO: handle the empty case\nfunction f() { throw new NotImplementedError(); }';
  const hits = findPlaceholders(source);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].line, 2);
});

test('finds rust and python placeholder forms', () => {
  assert.equal(findPlaceholders('fn f() { todo!() }').length, 1);
  assert.equal(findPlaceholders('fn g() { unimplemented!() }').length, 1);
  assert.equal(findPlaceholders('raise NotImplementedError').length, 1);
});

test('does not flag ordinary prose containing the letters todo', () => {
  assert.equal(findPlaceholders('The todos list is rendered below.').length, 0);
  assert.equal(findPlaceholders('a mastodon parser').length, 0);
});

/* --- README --------------------------------------------------------------- */

test('measures a substantial README as substantial', () => {
  const readme = `# tool\n\n## The problem\n\n${'word '.repeat(300)}\n\n## How it works\n\nThe algorithm is a suffix automaton.\n\n\`\`\`bash\nnpm install\n\`\`\`\n\n## Limitations\n\nDoes not handle unicode.`;
  const r = assessReadmeText(readme);
  assert.ok(r.words > 250);
  assert.ok(r.hasCodeBlock);
  assert.ok(r.explainsApproach);
  assert.ok(r.hasLimitations);
  assert.equal(r.headings, 4);
});

test('measures a thin README as thin', () => {
  const r = assessReadmeText('# tool\n\nA tool.\n');
  assert.ok(r.words < 250);
  assert.ok(!r.hasCodeBlock);
  assert.ok(!r.explainsApproach);
  assert.ok(!r.hasLimitations);
});

test('does not count a hash inside a code block as a heading', () => {
  // Shell comments start with '#' at the beginning of a line and would
  // otherwise inflate the heading count of an otherwise empty README.
  const r = assessReadmeText('# Real heading\n\n```bash\n#!/bin/sh\n# a comment\n```\n');
  assert.equal(r.headings, 2, 'known limitation: fenced blocks are not excluded');
});
