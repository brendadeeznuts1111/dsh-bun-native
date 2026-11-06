/**
 * `Bun.YAML` cyclic anchors and aliases.
 *
 * Bun's 1.4 announcement card:
 * https://bun.com/images/blog/bun-1.4/tweets/yaml-cyclic-anchors.jpg
 *
 *   "In the next version of Bun — Bun.YAML.parse supports cyclic anchors &
 *    aliases"
 *
 * with a tweet example whose `quote_tweet` aliases its own parent mapping and a
 * chained access `tweet.quote_tweet.quote_tweet.quote_tweet.text`. Verified on
 * Bun 1.4.4: aliases resolve to the *same object* (real cycles, not copies),
 * and `Bun.YAML.stringify` turns a cycle back into `&root` / `*root` so the
 * cycle survives a round-trip.
 *
 * Separate suites per behaviour: cyclic maps, plain anchor/alias identity,
 * merge keys, cyclic arrays, cycle serialization, plain serialization, and the
 * catalog claim.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The exact example from the announcement image. */
const TWEET_YAML = `tweet: &tweet
  text: |
    In the next version of Bun

    Bun.YAML.parse supports cyclic anchors & aliases
  quote_tweet: *tweet
`

type Tweet = { text: string; quote_tweet: Tweet }
type Anchors = { base: { x: number }; copy: { x: number }; list: number[]; list_copy: number[] }
type List = Array<string | List>

describe('Bun.YAML cyclic map anchors', () => {
  test('the anchored tweet aliases itself', () => {
    const { tweet } = Bun.YAML.parse(TWEET_YAML) as { tweet: Tweet }
    expect(tweet.quote_tweet).toBe(tweet)
  })

  test('chained alias traversal reaches the block scalar text', () => {
    const { tweet } = Bun.YAML.parse(TWEET_YAML) as { tweet: Tweet }
    expect(tweet.quote_tweet.quote_tweet.quote_tweet.text).toBe('In the next version of Bun\n\nBun.YAML.parse supports cyclic anchors & aliases\n')
  })

  test('the tweet keeps exactly its two keys', () => {
    const { tweet } = Bun.YAML.parse(TWEET_YAML) as { tweet: Tweet }
    expect(Object.keys(tweet)).toEqual(['text', 'quote_tweet'])
  })
})

describe('Bun.YAML anchor and alias identity', () => {
  test('an aliased mapping is the same object, not a copy', () => {
    const parsed = Bun.YAML.parse('base: &b\n  x: 1\ncopy: *b\n') as Anchors
    expect(parsed.copy).toBe(parsed.base)
  })

  test('an aliased sequence is the same array, not a copy', () => {
    const parsed = Bun.YAML.parse('list: &l [1, 2]\nlist_copy: *l\n') as Anchors
    expect(parsed.list_copy).toBe(parsed.list)
  })

  test('a scalar alias carries the value', () => {
    const parsed = Bun.YAML.parse('x: &v 5\ny: *v\n') as { x: number; y: number }
    expect(parsed.y).toBe(5)
  })
})

describe('Bun.YAML merge keys', () => {
  test('a merge key copies properties without sharing identity', () => {
    const parsed = Bun.YAML.parse('base: &b\n  x: 1\nderived:\n  <<: *b\n  y: 2\n') as { base: { x: number }; derived: { x: number; y: number } }
    expect(parsed.derived).toEqual({ x: 1, y: 2 })
    expect(parsed.derived).not.toBe(parsed.base)
  })
})

describe('Bun.YAML cyclic arrays', () => {
  test('an anchored sequence that includes its own alias is self-referential', () => {
    const parsed = Bun.YAML.parse('list: &l\n  - one\n  - *l\n') as { list: List }
    expect(parsed.list[1]).toBe(parsed.list)
  })
})

interface CyclicNode {
  name: string
  self?: CyclicNode
}

describe('Bun.YAML stringify cycles', () => {
  test('a self-referencing object serializes with an anchor and alias', () => {
    const cyclic: CyclicNode = { name: 'node' }
    cyclic.self = cyclic
    const text = Bun.YAML.stringify(cyclic)
    expect(text).toContain('&root')
    expect(text).toContain('*root')
  })

  test('parse(stringify(cycle)) restores the self reference', () => {
    const cyclic: CyclicNode = { name: 'node' }
    cyclic.self = cyclic
    const round = Bun.YAML.parse(Bun.YAML.stringify(cyclic)) as CyclicNode
    expect(round.name).toBe('node')
    expect(round.self).toBe(round)
  })

  test('a cyclic array round-trips as a cycle', () => {
    const list: List = ['one']
    list.push(list)
    const round = Bun.YAML.parse(Bun.YAML.stringify(list)) as List
    expect(round[0]).toBe('one')
    expect(round[1]).toBe(round)
  })
})

describe('Bun.YAML stringify plain values', () => {
  test('plain values serialize and parse back', () => {
    const text = Bun.YAML.stringify({ a: 1, list: [1, 2] })
    expect(Bun.YAML.parse(text)).toEqual({ a: 1, list: [1, 2] })
  })
})

describe('Bun.YAML parse inputs', () => {
  test('parses UTF-8 bytes and a DataView', () => {
    const bytes = new TextEncoder().encode('abc: def')
    expect(Bun.YAML.parse(bytes)).toEqual({ abc: 'def' })
    expect(Bun.YAML.parse(new DataView(bytes.buffer))).toEqual({ abc: 'def' })
  })

  test('parses an in-memory Blob but rejects a file-backed Blob', async () => {
    expect(Bun.YAML.parse(new Blob(['abc: def']))).toEqual({ abc: 'def' })

    const dir = mkdtempSync(join(tmpdir(), 'bun-yaml-'))
    const file = join(dir, 'sample.yaml')
    writeFileSync(file, 'abc: def\n')
    try {
      expect(() => Bun.YAML.parse(Bun.file(file))).toThrow(/File blob cannot be used here/)
      expect(Bun.YAML.parse(await Bun.file(file).text())).toEqual({ abc: 'def' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns an array for a multi-document stream', () => {
    expect(Bun.YAML.parse('---\na: 1\n---\nb: 2\n')).toEqual([{ a: 1 }, { b: 2 }])
  })
})

describe('Bun.YAML stringify options', () => {
  test('omitting space emits flow style; space emits block style', () => {
    const input = { abc: 'def', num: 123 }
    expect(Bun.YAML.stringify(input)).toBe('{abc: def,num: 123}')
    expect(Bun.YAML.stringify(input, null, 2)).toBe('abc: def\nnum: 123')
  })

  test('clamps numeric space to 10 and uses the first 10 characters of a string', () => {
    expect(Bun.YAML.stringify({ a: { b: 1 } }, null, 20)).toBe(`a:\n${' '.repeat(10)}b: 1`)
    expect(Bun.YAML.stringify({ a: { b: 1 } }, null, '--')).toBe('a:\n--b: 1')
  })

  test('rejects a replacer argument', () => {
    const stringify = Bun.YAML.stringify as unknown as (value: unknown, replacer: unknown) => string
    expect(() => stringify({ a: 1 }, () => 1)).toThrow(/does not support the replacer/)
  })

  test('double-quotes scalars that would parse as numbers or keywords', () => {
    expect(Bun.YAML.stringify('abc')).toBe('abc')
    expect(Bun.YAML.stringify('123')).toBe('"123"')
    expect(Bun.YAML.stringify('true')).toBe('"true"')
    expect(Bun.YAML.stringify('yes')).toBe('"yes"')
  })
})

describe('catalog documents cyclic anchors', () => {
  test('the Bun.YAML catalog summary mentions cyclic anchors', () => {
    const catalog = JSON.parse(readFileSync(new URL('../data/bun-globals.json', import.meta.url), 'utf8')) as {
      apis: Array<{ name: string; summary: string }>
    }
    const entry = catalog.apis.find((api) => api.name === 'Bun.YAML')
    expect(entry).toBeDefined()
    expect(entry?.summary).toContain('cyclic anchors')
  })
})
