#!/usr/bin/env node
/**
 * Health check for the seven trend collectors.
 *
 * Every source is a third-party API that can change its schema without notice.
 * This script fails loudly when a source stops returning usable items, so the
 * breakage surfaces in CI rather than as a quietly thinner daily run.
 */
import { SOURCES } from '../src/sources/index.js';

const results = await Promise.allSettled(
  SOURCES.map(async (source) => {
    const started = Date.now();
    const items = await source.collect();
    return { name: source.name, count: items.length, ms: Date.now() - started, sample: items[0] };
  }),
);

let unhealthy = 0;
const rows = [];

results.forEach((result, i) => {
  const name = SOURCES[i].name;
  if (result.status === 'rejected') {
    rows.push({ source: name, status: 'FAIL', items: 0, note: String(result.reason?.message || result.reason).slice(0, 70) });
    unhealthy += 1;
    return;
  }

  const { count, ms, sample } = result.value;
  // arXiv publishes nothing at weekends by design; zero items there is normal.
  const emptyIsExpected = name === 'arxiv';

  if (count === 0) {
    rows.push({ source: name, status: emptyIsExpected ? 'EMPTY' : 'FAIL', items: 0, note: emptyIsExpected ? 'no submissions (weekend?)' : 'returned no items' });
    if (!emptyIsExpected) unhealthy += 1;
    return;
  }

  const malformed = !sample?.title || !sample?.url || typeof sample?.score !== 'number';
  if (malformed) {
    rows.push({ source: name, status: 'FAIL', items: count, note: 'items are missing title/url/score — schema changed?' });
    unhealthy += 1;
    return;
  }

  rows.push({ source: name, status: 'ok', items: count, note: `${ms}ms` });
});

console.table(rows);

if (unhealthy > 0) {
  console.error(`\n${unhealthy} source(s) unhealthy`);
  process.exit(1);
}
console.log('\nall sources healthy');
