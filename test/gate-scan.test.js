import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessTests } from '../src/gate.js';

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-scan-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

test('counts Rust unit tests declared inside a source module', () => {
  // The regression this locks down: filtering by filename missed every
  // `#[cfg(test)] mod tests`, which is where Rust puts its unit tests.
  const dir = project({
    'src/lib.rs': `
      pub fn add(a: u32, b: u32) -> u32 { a + b }

      #[cfg(test)]
      mod tests {
          use super::*;
          #[test]
          fn adds() { assert_eq!(add(2, 3), 5); }
          #[test]
          fn saturates() { assert!(add(0, 0) == 0); }
      }`,
    'src/parser.rs': `
      #[cfg(test)]
      mod tests {
          #[test]
          fn parses() { assert!(super::ok()); }
      }`,
  });
  try {
    const result = assessTests(dir);
    assert.equal(result.cases, 3, 'all three #[test] functions must be counted');
    assert.equal(result.files, 2, 'both source files hold tests');
    assert.ok(result.assertions >= 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('counts tests in a conventional tests/ directory too', () => {
  const dir = project({
    'tests/integration.rs': '#[test]\nfn works() { assert_eq!(1, 2 - 1); }\n#[test]\nfn also() { assert!(true == false); }',
  });
  try {
    assert.equal(assessTests(dir).cases, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a source file with no tests is not counted as a test file', () => {
  const dir = project({
    'src/main.rs': 'fn main() { println!("hello"); }',
    'src/lib.rs': '#[test]\nfn t() { assert_eq!(1, 0); }',
  });
  try {
    const result = assessTests(dir);
    assert.equal(result.files, 1, 'only the file containing a test counts');
    assert.equal(result.cases, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build output directories are never scanned', () => {
  const dir = project({
    'src/lib.rs': '#[test]\nfn real() { assert_eq!(a(), 1); }',
    'target/debug/build/generated.rs': '#[test]\nfn fake() { assert_eq!(0, 0); }',
    'node_modules/dep/index.js': "test('vendored', () => { expect(1).toBe(1); })",
  });
  try {
    const result = assessTests(dir);
    assert.equal(result.cases, 1, 'target/ and node_modules/ must be skipped');
    assert.equal(result.trivial, 0, 'vendored vacuous assertions must not be attributed to the project');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty project reports nothing rather than throwing', () => {
  const dir = project({ 'README.md': '# nothing here' });
  try {
    assert.deepEqual(assessTests(dir), { cases: 0, assertions: 0, trivial: 0, files: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
