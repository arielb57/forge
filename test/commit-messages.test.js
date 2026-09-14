import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStage } from '../src/publish.js';

const spec = { name: 'xselaudit', language: 'typescript' };

test('the core commit names the modules it contains', () => {
  const message = describeStage('core', ['src/wire.ts', 'src/state.ts', 'src/classify.ts'], spec);
  assert.match(message, /wire/);
  assert.match(message, /state/);
  assert.match(message, /classify/);
});

test('uninformative module names are dropped', () => {
  // "Implement lib, mod, index" tells a reader nothing.
  const message = describeStage('core', ['src/lib.rs', 'src/mod.rs', 'src/dominators.rs'], { name: 'includecost', language: 'rust' });
  assert.match(message, /dominators/);
  assert.doesNotMatch(message, /\blib\b/);
  assert.doesNotMatch(message, /\bmod\b/);
});

test('a stage of only uninformative files falls back to the project name', () => {
  const message = describeStage('core', ['src/main.rs', 'src/lib.rs'], { name: 'buildcrit', language: 'rust' });
  assert.equal(message, 'Implement buildcrit');
});

test('the scaffold commit names the project and its language', () => {
  assert.equal(describeStage('scaffold', ['Cargo.toml', 'LICENSE'], spec), 'Set up xselaudit as a typescript project');
});

test('non-source files never appear in a message', () => {
  const message = describeStage('core', ['src/parser.rs', 'src/data.json', 'src/notes.md'], spec);
  assert.match(message, /parser/);
  assert.doesNotMatch(message, /data|notes/);
});

test('two different projects get two different histories', () => {
  const a = describeStage('core', ['src/wire.ts', 'src/classify.ts'], spec);
  const b = describeStage('core', ['src/dag.rs', 'src/sim.rs'], { name: 'buildcrit', language: 'rust' });
  assert.notEqual(a, b, 'identical commit messages across repositories is the tell this avoids');
});

test('the message stays short even for a large stage', () => {
  const many = Array.from({ length: 20 }, (_, i) => `src/module${i}.rs`);
  assert.ok(describeStage('core', many, spec).length < 90);
});

test('a test stage names what it covers, not the test files', () => {
  const message = describeStage(
    'tests',
    ['src/extractors.test.ts', 'src/normalize.test.ts', 'src/fuzz.test.ts'],
    { name: 'hostsplit', language: 'typescript' },
  );
  assert.match(message, /extractors/);
  assert.match(message, /normalize/);
  assert.doesNotMatch(message, /\.test|_test/, 'the ".test" suffix is noise in a commit subject');
});

test('duplicate coverage targets are not repeated', () => {
  const message = describeStage(
    'tests',
    ['src/parse.test.ts', 'tests/parse.spec.ts'],
    { name: 'x', language: 'typescript' },
  );
  assert.equal(message, 'Test parse');
});
