#!/usr/bin/env bun
/**
 * Validate a format-1 DSH plugin market index.
 *
 * This is a faithful port of the rules in
 * `@deepseek-ai/dsh-plugin-market-index` (the validator DSH itself runs), so a
 * document accepted here is accepted by the Discover tab and `plugin_market`.
 * It ships only rules the shipped validator enforces; unknown members are
 * ignored, exactly as the reader ignores them.
 *
 * Usage:
 *   bun market/validate-index.mjs market/index.json [index-url]
 */

import { readFileSync } from 'node:fs'

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const PACKAGE_NAME_MAX_LENGTH = 214
const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const SEMVER = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u')
const COMMIT = /^[0-9a-f]{40}$/u
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const MAX_INLINE_ICON_BYTES = 32 * 1024
const MAX_PUBLISH_TIMESTAMP = 1e11

export class IndexValidationError extends Error {
  constructor(path, reason) {
    super(`${path} ${reason}`)
    this.name = 'IndexValidationError'
    this.path = path
    this.reason = reason
  }
}

function fail(path, reason) {
  throw new IndexValidationError(path, reason)
}

function objectAt(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object')
  return value
}

function stringAt(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a string with a non-whitespace character')
  return value
}

function optional(object, key, path, read) {
  return Object.hasOwn(object, key) ? read(object[key], `${path}.${key}`) : undefined
}

function localizedText(value, path) {
  if (typeof value === 'string') return stringAt(value, path)
  const object = objectAt(value, path)
  const text = {}
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(`${path}.${language}`, 'must be keyed by a lowercase language id')
    text[language] = stringAt(member, `${path}.${language}`)
  }
  if (!Object.hasOwn(text, 'en')) fail(path, 'must contain en')
  return text
}

function declarations(value, path, read) {
  const result = {}
  for (const [id, member] of Object.entries(objectAt(value, path))) {
    if (id === '') fail(path, 'must not declare an empty id')
    result[id] = read(objectAt(member, `${path}.${id}`), `${path}.${id}`)
  }
  return result
}

function declaration(object, path) {
  return { title: localizedText(object.title, `${path}.title`) }
}

function sortKeyDeclaration(object, path) {
  if (object.order !== 'asc' && object.order !== 'desc') fail(`${path}.order`, 'must be "asc" or "desc"')
  return { title: localizedText(object.title, `${path}.title`), order: object.order }
}

function indexMetadata(value, path) {
  const object = value === undefined ? {} : objectAt(value, path)
  return {
    categories: optional(object, 'categories', path, (member, at) => declarations(member, at, declaration)) ?? {},
    labels: optional(object, 'labels', path, (member, at) => declarations(member, at, declaration)) ?? {},
    sortKeys: optional(object, 'sortKeys', path, (member, at) => declarations(member, at, sortKeyDeclaration)) ?? {},
  }
}

function declaredId(value, path, declared) {
  const id = stringAt(value, path)
  if (!Object.hasOwn(declared, id)) fail(path, `references undeclared id ${JSON.stringify(id)}`)
  return id
}

function pluginMetadata(value, path, index) {
  const object = value === undefined ? {} : objectAt(value, path)
  const category = optional(object, 'category', path, (member, at) => declaredId(member, at, index.categories))
  const keywords = optional(object, 'keywords', path, (member, at) => {
    if (!Array.isArray(member)) fail(at, 'must be an array')
    return member.map((keyword, position) => {
      if (typeof keyword !== 'string') fail(`${at}[${String(position)}]`, 'must be a string')
      return keyword
    })
  }) ?? []
  const labels = optional(object, 'labels', path, (member, at) => {
    if (!Array.isArray(member)) fail(at, 'must be an array')
    const ids = member.map((label, position) => declaredId(label, `${at}[${String(position)}]`, index.labels))
    if (new Set(ids).size !== ids.length) fail(at, 'must not repeat a label')
    return ids
  }) ?? []
  const sortKeys = optional(object, 'sortKeys', path, (member, at) => {
    const values = {}
    for (const [id, sortValue] of Object.entries(objectAt(member, at))) {
      declaredId(id, `${at}.${id}`, index.sortKeys)
      if (typeof sortValue !== 'number' || !Number.isFinite(sortValue)) fail(`${at}.${id}`, 'must be a finite number')
      values[id] = sortValue
    }
    return values
  }) ?? {}
  return {
    ...(category === undefined ? {} : { category }),
    keywords,
    labels,
    sortKeys,
  }
}

function httpUrl(value, path, protocols) {
  const text = stringAt(value, path)
  let url
  try {
    url = new URL(text)
  } catch {
    fail(path, 'must be an absolute URL')
  }
  if (!protocols.includes(url.protocol)) fail(path, `must use ${protocols.join(' or ')}`)
  if (url.username !== '' || url.password !== '') fail(path, 'must not contain credentials')
  if (url.href.includes('?') || url.href.includes('#')) fail(path, 'must not contain a query or fragment')
  return url
}

function homepageUrl(value, path) {
  const text = stringAt(value, path)
  if (!URL.canParse(text)) fail(path, 'must be an absolute URL')
  const url = new URL(text)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(path, 'must use https: or http:')
  return url.href
}

function gitUrl(value, path) {
  const url = httpUrl(value, path, ['https:'])
  if (url.href !== value) fail(path, 'must be a canonical URL')
  if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) fail(path, 'must name a repository with at least two path segments')
  if (/\.(?:tgz|tar\.gz)$/iu.test(url.pathname)) fail(path, 'must name a repository, not a tarball')
  return url.href
}

function packagePath(value, path) {
  const text = stringAt(value, path)
  if (text.split('/').some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    fail(path, 'must be a relative directory of letters, digits, and ._@+- segments without . or ..')
  }
  return text
}

function repository(value, path) {
  const object = objectAt(value, path)
  const url = httpUrl(object.url, `${path}.url`, ['https:', 'http:']).href
  const directory = optional(object, 'directory', path, packagePath)
  return { url, ...(directory === undefined ? {} : { directory }) }
}

function source(value, path) {
  const object = objectAt(value, path)
  switch (object.type) {
    case 'npm': {
      const registry = optional(object, 'registry', path, (member, at) => httpUrl(member, at, ['https:', 'http:']).href)
      return { type: 'npm', ...(registry === undefined ? {} : { registry }) }
    }
    case 'git': {
      const commit = stringAt(object.commit, `${path}.commit`)
      if (!COMMIT.test(commit)) fail(`${path}.commit`, 'must be a lowercase 40-hex-digit commit SHA')
      const packageDir = optional(object, 'path', path, packagePath)
      return {
        type: 'git',
        url: gitUrl(object.url, `${path}.url`),
        commit,
        ...(packageDir === undefined ? {} : { path: packageDir }),
      }
    }
    default:
      return fail(`${path}.type`, 'must be "npm" or "git"')
  }
}

function engines(value, path) {
  const dsh = optional(objectAt(value, path), 'dsh', path, (member, at) => {
    const range = stringAt(member, at)
    if (range.startsWith('workspace:')) fail(at, 'must not be a workspace: range')
    return range
  })
  return dsh === undefined ? {} : { dsh }
}

function icon(value, path, indexUrl) {
  const text = stringAt(value, path)
  if (text.startsWith('data:')) {
    const payload = DATA_ICON.exec(text)?.[1]
    if (payload === undefined || payload === '' || !BASE64.test(payload)) fail(path, 'must be a base64 SVG, PNG, JPEG, or WebP data URL')
    const decodedBytes = (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0)
    if (decodedBytes > MAX_INLINE_ICON_BYTES) fail(path, `must not exceed ${String(MAX_INLINE_ICON_BYTES / 1024)} KiB of decoded bytes`)
    return text
  }
  let resolved
  try {
    resolved = new URL(text, indexUrl)
  } catch {
    fail(path, 'must be a URL reference')
  }
  if (resolved.protocol !== 'https:' && (resolved.origin === 'null' || resolved.origin !== indexUrl.origin)) {
    fail(path, 'must resolve to https or the index origin')
  }
  return resolved.href
}

function marketVersion(value, path) {
  const object = objectAt(value, path)
  const version = stringAt(object.version, `${path}.version`)
  if (!SEMVER.test(version)) fail(`${path}.version`, 'must be an exact SemVer version')
  const publishTimestamp = object.publishTimestamp
  if (typeof publishTimestamp !== 'number' || !Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
    fail(`${path}.publishTimestamp`, 'must be an integer number of Unix seconds in [0, 10^11)')
  }
  return {
    version,
    publishTimestamp,
    source: source(object.source, `${path}.source`),
    engines: optional(object, 'engines', path, engines) ?? {},
  }
}

function versions(value, path) {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a non-empty array')
  const seen = new Set()
  const parsed = value.map((member, position) => {
    const at = `${path}[${String(position)}]`
    const entry = marketVersion(member, at)
    if (seen.has(entry.version)) fail(`${at}.version`, `duplicates ${entry.version}`)
    seen.add(entry.version)
    return entry
  })
  return parsed.sort((left, right) => Bun.semver.order(right.version, left.version))
}

// npm distribution tags are channel names: a tag is a spec that is neither an
// exact version nor a SemVer range (npm-package-arg decides by parsing a range
// first). These patterns approximate that range detection without pulling npm's
// semver range parser into a dependency-free workspace: an operator-led spec, or
// a partial/wildcard version such as `1`, `1.x`, `v2` or `x`, is a range; other
// shorter strings (`next`, `rc.1`, even `1abc`) are tags.
const PARTIAL_VERSION = /^[vV]?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?$/u
const RANGE_OPERATOR = /^[\^~><=*]/u

function tagName(value, path) {
  const name = stringAt(value, path)
  if (/\s/u.test(name)) fail(path, 'must not contain whitespace')
  if (SEMVER.test(name)) fail(path, 'must be a channel name, not an exact version')
  if (RANGE_OPERATOR.test(name) || PARTIAL_VERSION.test(name)) fail(path, 'must be a channel name, not a SemVer range')
  return name
}

function distTags(value, path, listed) {
  if (value === undefined) return {}
  const object = objectAt(value, path)
  const available = new Set(listed.map((entry) => entry.version))
  const tags = {}
  for (const [name, target] of Object.entries(object)) {
    const at = `${path}.${name}`
    const tag = tagName(name, at)
    const version = stringAt(target, at)
    if (!available.has(version)) fail(at, `references undeclared version ${JSON.stringify(version)}`)
    tags[tag] = version
  }
  return tags
}

function plugin(value, path, index, indexUrl) {
  const object = objectAt(value, path)
  const name = stringAt(object.name, `${path}.name`)
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) fail(`${path}.name`, 'must be a valid npm package name')
  const title = optional(object, 'title', path, localizedText)
  const description = optional(object, 'description', path, localizedText)
  const iconUrl = optional(object, 'icon', path, (member, at) => icon(member, at, indexUrl))
  const author = optional(object, 'author', path, stringAt)
  const homepage = optional(object, 'homepage', path, homepageUrl)
  const repo = optional(object, 'repository', path, repository)
  const listed = versions(object.versions, `${path}.versions`)
  const tags = distTags(object['dist-tags'], `${path}.dist-tags`, listed)
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(iconUrl === undefined ? {} : { icon: iconUrl }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repo === undefined ? {} : { repository: repo }),
    metadata: pluginMetadata(object.metadata, `${path}.metadata`, index),
    ...(Object.keys(tags).length === 0 ? {} : { distTags: tags }),
    versions: listed,
  }
}

/**
 * Validate a parsed index document against the URL it will be served from.
 * @param {unknown} value - parsed JSON.
 * @param {string} indexUrl - absolute URL of the index.
 * @returns {Record<string, unknown>} the normalized index.
 */
export function validateIndex(value, indexUrl) {
  if (!URL.canParse(indexUrl)) fail('$', `index URL ${JSON.stringify(indexUrl)} must be an absolute URL`)
  const base = new URL(indexUrl)
  const object = objectAt(value, '$')
  if (object.format !== 1) fail('$.format', 'must be 1')
  const metadata = indexMetadata(object.metadata, '$.metadata')
  if (!Array.isArray(object.plugins)) fail('$.plugins', 'must be an array')
  const names = new Set()
  const plugins = object.plugins.map((entry, position) => {
    const parsed = plugin(entry, `$.plugins[${String(position)}]`, metadata, base)
    if (names.has(parsed.name)) fail(`$.plugins[${String(position)}].name`, `duplicates ${parsed.name}`)
    names.add(parsed.name)
    return parsed
  })
  const title = localizedText(object.title, '$.title')
  const description = optional(object, 'description', '$', localizedText)
  return {
    format: 1,
    title,
    ...(description === undefined ? {} : { description }),
    metadata,
    plugins,
  }
}

if (import.meta.main) {
  const file = process.argv[2]
  if (file === undefined) {
    console.error('usage: bun market/validate-index.mjs <index.json> [index-url]')
    process.exit(2)
  }
  const indexUrl = process.argv[3] ?? 'https://raw.githubusercontent.com/brendadeeznuts1111/dsh-bun-native/main/market/index.json'
  const document = JSON.parse(readFileSync(file, 'utf8'))
  try {
    const parsed = validateIndex(document, indexUrl)
    console.log(`PASS ${file}`)
    console.log(`  index url: ${indexUrl}`)
    for (const entry of parsed.plugins) {
      const channels = Object.entries(entry.distTags ?? {})
      const initial = entry.distTags?.latest ?? entry.versions[0]?.version
      console.log(`  plugin: ${entry.name} (${entry.versions.length} version(s), latest ${initial})`)
      if (channels.length > 0) console.log(`    channels: ${channels.map(([channel, version]) => `${channel}=${version}`).join(', ')}`)
      for (const version of entry.versions) {
        const from = version.source
        console.log(`    ${version.version} <- ${from.type}${from.type === 'git' ? ` ${from.url}#${from.commit}${from.path === undefined ? '' : ` path=/${from.path}`}` : ''}`)
      }
    }
  } catch (error) {
    if (!(error instanceof IndexValidationError)) throw error
    console.error(`FAIL ${error.path}: ${error.reason}`)
    process.exit(1)
  }
}
