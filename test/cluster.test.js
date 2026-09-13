import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cluster } from '../src/trends.js';

const item = (source, title, extra = {}) => ({
  source, title, score: 1, normalized: 1, weight: 1, meta: {}, ...extra,
});

test('the same story from two sources lands in one cluster', () => {
  const clusters = cluster([
    item('hackernews', 'Linux Zoom client proactively reading the X11 clipboard'),
    item('lobsters', 'Linux Zoom Client Proactively Reads X11 Clipboard'),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].items.length, 2);
});

test('unrelated stories stay in separate clusters', () => {
  const clusters = cluster([
    item('hackernews', 'Linux Zoom client reads the X11 clipboard'),
    item('lobsters', 'A new garbage collector for OCaml'),
    item('arxiv', 'Sparse attention kernels for long context inference'),
  ]);
  assert.equal(clusters.length, 3);
});

test('clustering keeps every input item exactly once', () => {
  const items = [
    item('hackernews', 'Bun compile times build visualizer'),
    item('lobsters', 'I made a build visualizer for Bun compile times'),
    item('github-rising', 'PRAXIST autonomous research system'),
    item('arxiv', 'Speculative decoding without a draft model'),
    item('huggingface', 'Qwen3.8-27B image text to text'),
  ];
  const clusters = cluster(items);
  const total = clusters.reduce((n, c) => n + c.items.length, 0);
  assert.equal(total, items.length, 'no item may be dropped or duplicated');
});

test('an empty input yields no clusters', () => {
  assert.deepEqual(cluster([]), []);
});

test('a lower threshold merges more aggressively than a higher one', () => {
  const items = [
    item('hackernews', 'rust async runtime scheduler'),
    item('lobsters', 'a scheduler for async rust'),
  ];
  assert.ok(cluster(items, 0.2).length <= cluster(items, 0.9).length);
});

test('clusters expose the union of their token sets', () => {
  const [only] = cluster([
    item('hackernews', 'safetensors checkpoint reader'),
    item('lobsters', 'safetensors checkpoint layer differ'),
  ]);
  assert.ok(only.tokens.has('safetensors'));
  assert.ok(only.tokens.has('reader'), 'tokens from the first item must survive');
  assert.ok(only.tokens.has('differ'), 'tokens from the merged item must be added');
});
