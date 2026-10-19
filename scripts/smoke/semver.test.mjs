// Run with: pnpm test:scripts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { satisfies } from './semver.mjs'

test('stable versions follow caret/tilde/comparator rules', () => {
  assert.equal(satisfies('0.1.0', '^0.1.0'), true)
  assert.equal(satisfies('0.1.5', '^0.1.0'), true)
  assert.equal(satisfies('0.2.0', '^0.1.0'), false)
  assert.equal(satisfies('1.4.0', '^1.2.0'), true)
  assert.equal(satisfies('2.0.0', '^1.2.0'), false)
  assert.equal(satisfies('1.2.9', '~1.2.0'), true)
  assert.equal(satisfies('1.3.0', '~1.2.0'), false)
  assert.equal(satisfies('1.0.0', '>=1.0.0 <2.0.0'), true)
  assert.equal(satisfies('3.0.0', '^1.0.0 || ^3.0.0'), true)
  assert.equal(satisfies('1.0.0', '1.0.0'), true)
  assert.equal(satisfies('1.0.1', '1.0.0'), false)
  assert.equal(satisfies('5.0.0', '*'), true)
})

test('a prerelease never satisfies a range without a prerelease on the same tuple (npm rule)', () => {
  assert.equal(satisfies('0.1.1-alpha.0', '^0.1.0'), false)
  assert.equal(satisfies('2.0.0-alpha.2', '>=1.0.0'), false)
  assert.equal(satisfies('2.0.0-alpha.2', '*'), false)
  assert.equal(satisfies('1.2.4-beta.0', '~1.2.3'), false)
})

test('a prerelease satisfies a range that names a prerelease on the same major.minor.patch', () => {
  assert.equal(satisfies('2.0.0-alpha.1', '^2.0.0-alpha.1'), true)
  assert.equal(satisfies('2.0.0-alpha.2', '^2.0.0-alpha.1'), true)
  assert.equal(satisfies('2.0.0-alpha.0', '^2.0.0-alpha.1'), false)
  assert.equal(satisfies('2.0.1-alpha.0', '^2.0.0-alpha.1'), false)
  assert.equal(satisfies('2.0.0', '^2.0.0-alpha.1'), true)
  assert.equal(satisfies('0.1.1-alpha.0', '^0.1.1-alpha.0'), true)
  assert.equal(satisfies('0.1.1-alpha.3', '>=0.1.1-alpha.0 <0.2.0'), true)
  // The prerelease tuple must match a comparator in the SAME `||` alternative.
  assert.equal(satisfies('0.1.1-alpha.0', '^0.1.0 || ^9.0.0-alpha.0'), false)
})

test('unparseable versions never satisfy', () => {
  assert.equal(satisfies('not-a-version', '^1.0.0'), false)
})
