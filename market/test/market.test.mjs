/**
 * Channel (npm `dist-tags`) coverage for the market tooling: the format-1 rules
 * the validator enforces, and the builder that emits several channels from
 * pinned releases.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex } from '../build-index.mjs'
import { validateIndex } from '../validate-index.mjs'

const INDEX_URL = 'https://raw.githubusercontent.com/brendadeeznuts1111/dsh-bun-native/main/market/index.json'
const REPO = 'https://github.com/brendadeeznuts1111/dsh-bun-native'
const COMMIT_STABLE = '565d85700f912a1dd795def0adae906bef4c7176'
const COMMIT_OLDER = '967331cf0fbf1e88d02f677d7dd973c9bb1ad3ba'

/** One listed npm version. */
function npmVersion(version, publishTimestamp = 1794014498) {
  return { version, publishTimestamp, source: { type: 'npm' }, engines: { dsh: '*' } }
}

/** One index document holding `plugins`. */
function marketIndex(plugins) {
  return { format: 1, title: 'Example', plugins }
}

/** The message of the error `run` throws, or `''`. */
function errorOf(run) {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

/** A throwaway workspace root with both bundles and their locale metadata. */
function fixtureRoot({ native = '1.2.4', docs = '1.0.0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-market-'))
  for (const [dir, version, title] of [
    ['bun-native', native, 'Bun native'],
    ['bun-docs-mcp', docs, 'Bun docs MCP'],
  ]) {
    mkdirSync(join(root, dir, 'locale'), { recursive: true })
    writeFileSync(
      join(root, dir, 'package.json'),
      JSON.stringify({
        name: `@local/${dir}`,
        version,
        type: 'module',
        author: 'probe',
        homepage: 'https://example.com/readme',
        engines: { dsh: '>=0.2.2-rc.1' },
        repository: { directory: dir },
        keywords: ['probe'],
      }),
    )
    for (const language of ['en', 'zh']) {
      writeFileSync(join(root, dir, 'locale', `${language}.json`), JSON.stringify({ meta: { title, description: `${title} description` } }))
    }
  }
  return root
}

describe('dist-tags validation', () => {
  const listed = [npmVersion('1.2.0'), npmVersion('1.1.0')]

  test('accepts several channels and keeps their targets', () => {
    const parsed = validateIndex(marketIndex([{ name: '@example/one', versions: listed, 'dist-tags': { latest: '1.2.0', next: '1.1.0' } }]), INDEX_URL)
    expect(parsed.plugins[0].distTags).toEqual({ latest: '1.2.0', next: '1.1.0' })
  })

  test('accepts channel names such as latest, canary, beta and rc.1', () => {
    const names = ['latest', 'next', 'canary', 'beta', 'rc.1', 'main']
    const parsed = validateIndex(
      marketIndex([{ name: '@example/one', versions: listed, 'dist-tags': Object.fromEntries(names.map((name) => [name, '1.2.0'])) }]),
      INDEX_URL,
    )
    expect(Object.keys(parsed.plugins[0].distTags ?? {})).toEqual(names)
  })

  test('accepts a prerelease target', () => {
    const parsed = validateIndex(
      marketIndex([{ name: '@example/one', versions: [npmVersion('1.2.0'), npmVersion('1.3.0-rc.1')], 'dist-tags': { latest: '1.2.0', next: '1.3.0-rc.1' } }]),
      INDEX_URL,
    )
    expect(parsed.plugins[0].distTags?.next).toBe('1.3.0-rc.1')
  })

  test('records no channels when dist-tags is absent', () => {
    const parsed = validateIndex(marketIndex([{ name: '@example/one', versions: listed }]), INDEX_URL)
    expect(parsed.plugins[0].distTags).toBeUndefined()
  })

  test('rejects a channel whose target is not a listed version', () => {
    const message = errorOf(() => validateIndex(marketIndex([{ name: '@example/one', versions: listed, 'dist-tags': { next: '2.0.0' } }]), INDEX_URL))
    expect(message).toContain('$.plugins[0].dist-tags.next')
    expect(message).toContain('references undeclared version')
  })

  test('rejects an exact version as a channel name', () => {
    const message = errorOf(() => validateIndex(marketIndex([{ name: '@example/one', versions: listed, 'dist-tags': { '1.2.0': '1.2.0' } }]), INDEX_URL))
    expect(message).toContain('$.plugins[0].dist-tags.1.2.0')
    expect(message).toContain('not an exact version')
  })

  test('rejects a channel name that looks like a SemVer range', () => {
    for (const name of ['^1.0.0', '1.x', '>=1', 'v2', '~1.1', '1.2', '*', 'x']) {
      const message = errorOf(() => validateIndex(marketIndex([{ name: '@example/one', versions: listed, 'dist-tags': { [name]: '1.2.0' } }]), INDEX_URL))
      expect(message).toContain('not a SemVer range')
    }
  })

  test('accepts a tag that merely starts with a digit (npm allows 1abc)', () => {
    const parsed = validateIndex(marketIndex([{ name: '@example/one', versions: listed, 'dist-tags': { '1abc': '1.2.0' } }]), INDEX_URL)
    expect(parsed.plugins[0].distTags?.['1abc']).toBe('1.2.0')
  })

  test('rejects a non-string channel target', () => {
    const message = errorOf(() => validateIndex(marketIndex([{ name: '@example/one', versions: listed, 'dist-tags': { next: 1.2 } }]), INDEX_URL))
    expect(message).toContain('$.plugins[0].dist-tags.next')
  })
})

describe('builder channels', () => {
  test('lists every pinned release and records each channel', () => {
    const built = buildIndex({
      repo: REPO,
      branch: 'main',
      commit: COMMIT_STABLE,
      releaseSpecs: [`bun-native=1.2.4@${COMMIT_STABLE}#1794014498`, `bun-native=1.1.0@${COMMIT_OLDER}#1793000000`],
      tagSpecs: ['bun-native:latest=1.2.4', 'bun-native:legacy=1.1.0'],
      publishTimestamp: 1794014498,
      root: fixtureRoot(),
    })
    const native = built.plugins.find((plugin) => plugin.name === '@local/bun-native')
    expect(native?.['dist-tags']).toEqual({ latest: '1.2.4', legacy: '1.1.0' })
    expect(native?.versions.map((version) => version.version)).toEqual(['1.2.4', '1.1.0'])
    expect(native?.versions[0]?.source.commit).toBe(COMMIT_STABLE)
    expect(native?.versions[1]?.source.commit).toBe(COMMIT_OLDER)
    expect(native?.versions[1]?.publishTimestamp).toBe(1793000000)
    // The bundle without pins falls back to --commit and a single latest channel.
    const docs = built.plugins.find((plugin) => plugin.name === '@local/bun-docs-mcp')
    expect(docs?.['dist-tags']).toEqual({ latest: '1.0.0' })
    expect(docs?.versions[0]?.source.commit).toBe(COMMIT_STABLE)
    // The builder validates its own output before returning it.
    expect(() => validateIndex(built.index, built.indexUrl)).not.toThrow()
  })

  test('rejects a channel pointing at a version that is not pinned', () => {
    const message = errorOf(() =>
      buildIndex({
        repo: REPO,
        branch: 'main',
        releaseSpecs: [`bun-native=1.2.4@${COMMIT_STABLE}`],
        tagSpecs: ['bun-native:next=2.0.0'],
        publishTimestamp: 1794014498,
        root: fixtureRoot(),
      }),
    )
    expect(message).toContain('channel next points at 2.0.0')
  })

  test('requires the greatest pinned version to be the package.json version', () => {
    const message = errorOf(() =>
      buildIndex({
        repo: REPO,
        branch: 'main',
        releaseSpecs: [`bun-native=1.1.0@${COMMIT_OLDER}`],
        publishTimestamp: 1794014498,
        root: fixtureRoot({ native: '1.2.4' }),
      }),
    )
    expect(message).toContain('must be the bundle')
    expect(message).toContain('1.2.4')
  })

  test('rejects the same version pinned twice', () => {
    const message = errorOf(() =>
      buildIndex({
        repo: REPO,
        branch: 'main',
        releaseSpecs: [`bun-native=1.2.4@${COMMIT_STABLE}`, `bun-native=1.2.4@${COMMIT_OLDER}`],
        publishTimestamp: 1794014498,
        root: fixtureRoot(),
      }),
    )
    expect(message).toContain('repeats version 1.2.4')
  })

  test('rejects a bundle with neither a pin nor --commit', () => {
    const message = errorOf(() =>
      buildIndex({ repo: REPO, branch: 'main', releaseSpecs: [`bun-native=1.2.4@${COMMIT_STABLE}`], publishTimestamp: 1794014498, root: fixtureRoot() }),
    )
    expect(message).toContain('bun-docs-mcp: pass --commit')
  })

  test('rejects an unknown bundle in a pin', () => {
    const message = errorOf(() => buildIndex({ repo: REPO, branch: 'main', commit: COMMIT_STABLE, releaseSpecs: [`other-bundle=1.0.0@${COMMIT_STABLE}`], publishTimestamp: 1794014498, root: fixtureRoot() }))
    expect(message).toContain('unknown bundle')
  })
})
