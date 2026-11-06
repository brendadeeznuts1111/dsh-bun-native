import { expect, test } from 'bun:test'

test('arithmetic still works', () => {
  expect(1 + 1).toBe(2)
})

test('the Bun global is present', () => {
  expect(typeof Bun.version).toBe('string')
  expect(typeof Bun.file).toBe('function')
})
