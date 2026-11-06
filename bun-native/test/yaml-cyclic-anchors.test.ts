/**
 * `Bun.YAML` cyclic anchors and aliases.
 *
 * Bun's 1.4 announcement card (blog image `yaml-cyclic-anchors.jpg`):
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
import { readFileSync } from 'node:fs'

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
