#!/usr/bin/env bun
/**
 * Build the format-1 plugin market index for the Bun DSH plugins.
 *
 * The index is the JSON document DSH's Discover tab and `plugin_market` tool
 * read. Format 1 is defined by the DSH repo Agent Note
 * `.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md`
 * and validated by `@deepseek-ai/dsh-plugin-market-index`; this script mirrors
 * the parts a publisher must satisfy and validates its own output.
 *
 * The index publishes both repository bundles:
 *   bun-native/    @local/bun-native
 *   bun-docs-mcp/  @local/bun-docs-mcp
 *
 * Single channel (one version per bundle, tagged `latest`):
 *   bun market/build-index.mjs --commit <40-hex> [--publish-timestamp <unix>]
 *
 * Several channels (npm dist-tags), one pin per listed version:
 *   bun market/build-index.mjs \
 *     --release bun-native=1.2.4@<40-hex>#1794014498 \
 *     --release bun-native=1.3.0-rc.1@<40-hex> \
 *     --tag bun-native:latest=1.2.4 --tag bun-native:next=1.3.0-rc.1
 *
 * `--commit` is shorthand for one release of every bundle at its current
 * package.json version, tagged `latest`; a bundle pinned with `--release`
 * ignores it. `--release` pins one version of one bundle to a commit (`#<unix>`
 * sets that version's publish time, otherwise `--publish-timestamp` applies).
 * `--tag <dir>:<channel>=<version>` records a channel; a bundle with no `--tag`
 * gets `latest` at its package.json version.
 *
 * In release mode the greatest listed version must be the bundle's current
 * package.json version: title, description, icon and `engines.dsh` come from
 * the working tree, and the format takes display metadata from the highest
 * listed version. Publish a channel by bumping the bundle, committing, then
 * pinning that commit here.
 *
 * Usage:
 *   bun market/build-index.mjs (--commit <40-hex> | --release <dir>=<version>@<40-hex>[#<unix>] ...)
 *     [--tag <dir>:<channel>=<version>] ... [--publish-timestamp <unix>]
 *     [--repo https://github.com/<owner>/<repo>] [--branch main] [--out market/index.json]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { validateIndex } from './validate-index.mjs'

const here = dirname(import.meta.path)
const root = resolve(here, '..')
const DEFAULT_REPO = 'https://github.com/brendadeeznuts1111/dsh-bun-native'

const COMMIT = /^[0-9a-f]{40}$/u
const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const SEMVER = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u')
const RELEASE_SPEC = /^([a-z0-9-]+)=([^@#]+)@([0-9a-f]{40})(?:#(\d+))?$/u
const TAG_SPEC = /^([a-z0-9-]+):([^=\s]+)=([^=\s]+)$/u
const MAX_PUBLISH_TIMESTAMP = 1e11

/** Read every value for a repeatable CLI option. */
function options(name) {
  const values = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== `--${name}`) continue
    const value = process.argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    values.push(value)
  }
  return values
}

/** Read one CLI option; the last occurrence wins. */
function option(name, fallback) {
  const values = options(name)
  return values.length === 0 ? fallback : values.at(-1)
}

/** One published bundle: repo directory, icon and index labels. */
const PLUGINS = [
  { dir: 'bun-native', icon: 'icons/bun-native.svg', labels: ['bun', 'offline'] },
  { dir: 'bun-docs-mcp', icon: 'icons/bun-docs-mcp.svg', labels: ['bun', 'docs', 'mcp'] },
]

/** Parse one `--release <dir>=<version>@<40-hex>[#<unix>]` value. */
function parseRelease(spec) {
  const match = RELEASE_SPEC.exec(spec)
  if (match === null) throw new Error(`--release must look like <dir>=<version>@<40-hex>[#<unix seconds>], got ${JSON.stringify(spec)}`)
  const [, dir, version, commit, rawTimestamp] = match
  if (!SEMVER.test(version)) throw new Error(`--release ${spec}: ${version} is not an exact SemVer version`)
  const publishTimestamp = rawTimestamp === undefined ? undefined : Number(rawTimestamp)
  if (publishTimestamp !== undefined && (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP)) {
    throw new Error(`--release ${spec}: publish time must be integer Unix seconds in [0, 10^11)`)
  }
  return { dir, version, commit, publishTimestamp }
}

/** Parse one `--tag <dir>:<channel>=<version>` value. */
function parseTag(spec) {
  const match = TAG_SPEC.exec(spec)
  if (match === null) throw new Error(`--tag must look like <dir>:<channel>=<version>, got ${JSON.stringify(spec)}`)
  const [, dir, channel, version] = match
  return { dir, channel, version }
}

/** Read a bundle's manifest and locale metadata from a workspace root. */
function readBundle(bundleRoot, { dir, icon, labels }) {
  const packageDir = join(bundleRoot, dir)
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const localeEn = JSON.parse(readFileSync(join(packageDir, 'locale', 'en.json'), 'utf8'))
  const localeZh = JSON.parse(readFileSync(join(packageDir, 'locale', 'zh.json'), 'utf8'))
  if (typeof pkg.engines?.dsh !== 'string' || !pkg.engines.dsh.trim()) throw new Error(`${dir}/package.json must declare engines.dsh for market listing`)
  if (pkg.repository?.directory !== dir) throw new Error(`${dir}/package.json repository.directory must be "${dir}"`)
  if (typeof localeEn.meta?.title !== 'string' || typeof localeEn.meta?.description !== 'string') throw new Error(`${dir}/locale/en.json needs meta.title and meta.description`)
  if (typeof localeZh.meta?.title !== 'string' || typeof localeZh.meta?.description !== 'string') throw new Error(`${dir}/locale/zh.json needs meta.title and meta.description`)
  return { dir, icon, labels, pkg, localeEn, localeZh }
}

/**
 * Build the index document. Pure: reads bundle metadata from the working tree
 * and returns the document without writing anything.
 * @returns {{ index: Record<string, unknown>, indexUrl: string, plugins: Record<string, unknown>[] }}
 */
export function buildIndex({ repo, branch, commit, releaseSpecs = [], tagSpecs = [], publishTimestamp, root: bundleRoot = root }) {
  const releases = releaseSpecs.map(parseRelease)
  const tags = tagSpecs.map(parseTag)
  for (const { dir } of [...releases, ...tags]) {
    if (!PLUGINS.some((plugin) => plugin.dir === dir)) throw new Error(`unknown bundle ${JSON.stringify(dir)}; expected one of ${PLUGINS.map((plugin) => plugin.dir).join(', ')}`)
  }

  const indexUrl = `https://raw.githubusercontent.com/${new URL(repo).pathname.replace(/^\//u, '')}/${branch}/market/index.json`

  const plugins = PLUGINS.map((descriptor) => {
    const bundle = readBundle(bundleRoot, descriptor)
    const { dir, pkg } = bundle
    const pinned = releases.filter((release) => release.dir === dir)
    const versions = pinned.length > 0 ? pinned : commit === undefined ? [] : [{ version: pkg.version, commit, publishTimestamp: undefined }]
    if (versions.length === 0) throw new Error(`${dir}: pass --commit <40-hex>, or --release ${dir}=<version>@<40-hex>`)

    const seen = new Set()
    for (const release of versions) {
      if (seen.has(release.version)) throw new Error(`${dir}: --release repeats version ${release.version}`)
      seen.add(release.version)
    }
    const sorted = [...versions].sort((left, right) => Bun.semver.order(right.version, left.version))
    if (sorted[0].version !== pkg.version) {
      throw new Error(`${dir}: the greatest listed version (${sorted[0].version}) must be the bundle's current package.json version (${pkg.version}); display metadata and engines come from the working tree`)
    }

    const channels = tags.filter((tag) => tag.dir === dir)
    const distTags = channels.length === 0 ? { latest: pkg.version } : Object.fromEntries(channels.map((tag) => [tag.channel, tag.version]))
    for (const [channel, version] of Object.entries(distTags)) {
      if (!seen.has(version)) throw new Error(`${dir}: channel ${channel} points at ${version}, which is not a listed version (${sorted.map((release) => release.version).join(', ')})`)
    }

    return {
      name: pkg.name,
      title: {
        en: bundle.localeEn.meta.title,
        zh: bundle.localeZh.meta.title,
      },
      description: {
        en: bundle.localeEn.meta.description,
        zh: bundle.localeZh.meta.description,
      },
      icon: descriptor.icon,
      author: pkg.author,
      homepage: pkg.homepage,
      repository: { url: repo, directory: dir },
      metadata: {
        category: 'developer-tools',
        labels: descriptor.labels,
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
        sortKeys: { published: Math.max(...sorted.map((release) => release.publishTimestamp ?? publishTimestamp)) },
      },
      'dist-tags': distTags,
      versions: sorted.map((release) => ({
        version: release.version,
        publishTimestamp: release.publishTimestamp ?? publishTimestamp,
        source: { type: 'git', url: repo, commit: release.commit, path: dir },
        engines: { dsh: pkg.engines.dsh },
      })),
    }
  })

  const index = {
    format: 1,
    title: { en: 'Bun DSH plugins', zh: 'Bun DSH 插件' },
    description: {
      en: 'Format-1 plugin market index for the Bun-native bundle and the Bun docs MCP connector.',
      zh: 'Bun 原生组合包与 Bun 文档 MCP 连接器的 format-1 插件市场索引。',
    },
    metadata: {
      categories: {
        'developer-tools': { title: { en: 'Developer tools', zh: '开发者工具' } },
      },
      labels: {
        bun: { title: { en: 'Bun', zh: 'Bun' } },
        offline: { title: { en: 'Offline', zh: '离线' } },
        docs: { title: { en: 'Docs', zh: '文档' } },
        mcp: { title: { en: 'MCP', zh: 'MCP' } },
      },
      sortKeys: {
        published: { title: { en: 'Published', zh: '发布时间' }, order: 'desc' },
      },
    },
    plugins,
  }

  // Validate before returning: a bad index is rejected as a whole by every reader.
  validateIndex(index, indexUrl)
  return { index, indexUrl, plugins }
}

function main() {
  const repo = option('repo', DEFAULT_REPO).replace(/\/+$/u, '')
  const branch = option('branch', 'main')
  const commit = option('commit', undefined)
  if (commit !== undefined && !COMMIT.test(commit)) throw new Error('--commit must be the lowercase 40-hex commit SHA that contains the bundles')
  const releaseSpecs = options('release')
  if (commit === undefined && releaseSpecs.length === 0) throw new Error('pass --commit <40-hex> for a single-channel build, or --release <dir>=<version>@<40-hex> pins for a multi-channel one')
  const publishTimestamp = Number(option('publish-timestamp', String(Math.floor(Date.now() / 1000))))
  if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) throw new Error('--publish-timestamp must be integer Unix seconds in [0, 10^11)')
  const out = resolve(option('out', join(here, 'index.json')))

  const built = buildIndex({ repo, branch, commit, releaseSpecs, tagSpecs: options('tag'), publishTimestamp })
  writeFileSync(out, `${JSON.stringify(built.index, null, 2)}\n`, 'utf8')
  console.log(`wrote ${out}`)
  for (const plugin of built.plugins) {
    const distTags = /** @type {Record<string, string>} */ (plugin['dist-tags'])
    console.log(`plugin    ${String(plugin.name)} (${Object.entries(distTags).map(([channel, version]) => `${channel}=${version}`).join(', ')})`)
    const versions = /** @type {{ version: string, source: { commit: string, path: string } }[]} */ (plugin.versions)
    for (const version of versions) console.log(`source    ${version.version} git ${repo}#${version.source.commit} path=/${version.source.path}`)
  }
  console.log(`index url ${built.indexUrl}`)
}

if (import.meta.main) main()
