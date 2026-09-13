import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson } from '../src/llm/index.js';

test('parses bare JSON', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
});

test('parses JSON inside a fenced block', () => {
  assert.deepEqual(parseJson('```json\n{"specs":[]}\n```'), { specs: [] });
});

test('parses JSON inside an unlabelled fence', () => {
  assert.deepEqual(parseJson('```\n[1,2,3]\n```'), [1, 2, 3]);
});

test('recovers JSON wrapped in prose', () => {
  const raw = 'Here are the specs you asked for:\n{"specs":[{"name":"a"}]}\nHope that helps.';
  assert.deepEqual(parseJson(raw), { specs: [{ name: 'a' }] });
});

test('handles braces inside strings without truncating', () => {
  const raw = 'note: {"tagline":"handles { and } safely","n":2}';
  assert.deepEqual(parseJson(raw), { tagline: 'handles { and } safely', n: 2 });
});

test('handles escaped quotes inside strings', () => {
  const raw = '{"problem":"the \\"obvious\\" fix does not work"}';
  assert.equal(parseJson(raw).problem, 'the "obvious" fix does not work');
});

test('handles nested objects and arrays', () => {
  const raw = 'prefix {"specs":[{"deliverables":["a","b"],"meta":{"deep":{"x":1}}}]} suffix';
  assert.equal(parseJson(raw).specs[0].meta.deep.x, 1);
});

test('prefers an array when the payload is an array', () => {
  assert.deepEqual(parseJson('output: [{"name":"one"}]'), [{ name: 'one' }]);
});

test('throws a descriptive error when there is no JSON at all', () => {
  assert.throws(() => parseJson('I could not complete that request.'), /could not parse JSON/);
});

test('throws rather than returning a partial object on truncated JSON', () => {
  assert.throws(() => parseJson('{"specs":[{"name":"unterminated'), /could not parse JSON/);
});
