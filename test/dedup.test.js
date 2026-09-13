import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, similarity } from '../src/store.js';

test('tokenize drops stop words and short tokens', () => {
  const tokens = tokenize('A parser for the new Redis protocol');
  assert.ok(tokens.has('parser'));
  assert.ok(tokens.has('redis'));
  assert.ok(tokens.has('protocol'));
  assert.ok(!tokens.has('the'), 'stop words must be removed');
  assert.ok(!tokens.has('a'), 'single characters must be removed');
  assert.ok(!tokens.has('for'), '"for" is a stop word');
});

test('tokenize is case- and punctuation-insensitive', () => {
  assert.deepEqual(
    [...tokenize('X11 Clipboard, Audited!')].sort(),
    [...tokenize('x11 clipboard audited')].sort(),
  );
});

test('similarity is 1 for identical text and 0 for disjoint text', () => {
  assert.equal(similarity('rust build graph simulator', 'rust build graph simulator'), 1);
  assert.equal(similarity('rust build graph', 'culinary recipe database'), 0);
});

test('similarity is symmetric', () => {
  const a = 'safetensors checkpoint differ';
  const b = 'checkpoint diffing for safetensors models';
  assert.equal(similarity(a, b), similarity(b, a));
});

test('similarity is bounded to [0,1]', () => {
  const pairs = [
    ['a parser', 'a parser for json'],
    ['', 'anything at all'],
    ['one two three', 'three two one'],
  ];
  for (const [a, b] of pairs) {
    const score = similarity(a, b);
    assert.ok(score >= 0 && score <= 1, `${score} out of range for "${a}" vs "${b}"`);
  }
});

test('empty input never matches', () => {
  assert.equal(similarity('', ''), 0);
  assert.equal(similarity('', 'something'), 0);
});

test('near-duplicate project names score above the 0.45 cooldown threshold', () => {
  // These are the false negatives that would let the pipeline ship the same
  // idea twice, which is the failure the cooldown exists to prevent.
  const score = similarity(
    'ninja build graph simulator predicting speedups',
    'ninja graph simulator that predicts build speedups',
  );
  assert.ok(score >= 0.45, `expected a near-duplicate match, got ${score}`);
});

test('genuinely different projects score below the cooldown threshold', () => {
  const score = similarity(
    'x11 clipboard selection auditor',
    'safetensors checkpoint layer differ',
  );
  assert.ok(score < 0.45, `expected distinct projects, got ${score}`);
});
