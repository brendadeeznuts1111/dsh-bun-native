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
 * The index publishes both repository bundles from one pinned commit:
 *   bun-native/    @local/bun-native
 *   bun-docs-mcp/  @local/bun-docs-mcp
 *
 * Usage:
 *   bun market/build-index.mjs --commit <40-hex> [--publish-timestamp <unix>]
 *     [--repo https://github.com/<owner>/<repo>] [--branch main] [--out market/index.json]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { validateIndex } from './validate-index.mjs'

const here = dirname(import.meta.path)
const root = resolve(here, '..')

/** Read one CLI option. */
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
  return value
}

/** One published bundle: repo directory, icon and index labels. */
const PLUGINS = [
  { dir: 'bun-native', icon: 'icons/bun-native.svg', labels: ['bun', 'offline'] },
  { dir: 'bun-docs-mcp', icon: 'icons/bun-docs-mcp.svg', labels: ['bun', 'docs', 'mcp'] },
]

const repo = option('repo', 'https://github.com/brendadeeznuts1111/dsh-bun-native').replace(/\/+$/u, '')
const branch = option('branch', 'main')
const commit = option('commit', undefined)
const out = resolve(option('out', join(here, 'index.json')))
if (commit === undefined || !/^[0-9a-f]{40}$/u.test(commit)) throw new Error('--commit must be the lowercase 40-hex commit SHA that contains the bundles')

const publishTimestamp = Number(option('publish-timestamp', String(Math.floor(Date.now() / 1000))))
if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0) throw new Error('--publish-timestamp must be integer Unix seconds')

const indexUrl = `https://raw.githubusercontent.com/${new URL(repo).pathname.replace(/^\//u, '')}/${branch}/market/index.json`

const plugins = PLUGINS.map(({ dir, icon, labels }) => {
  const packageDir = join(root, dir)
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const localeEn = JSON.parse(readFileSync(join(packageDir, 'locale', 'en.json'), 'utf8'))
  const localeZh = JSON.parse(readFileSync(join(packageDir, 'locale', 'zh.json'), 'utf8'))
  if (typeof pkg.engines?.dsh !== 'string' || !pkg.engines.dsh.trim()) throw new Error(`${dir}/package.json must declare engines.dsh for market listing`)
  if (pkg.repository?.directory !== dir) throw new Error(`${dir}/package.json repository.directory must be "${dir}"`)
  if (typeof localeEn.meta?.title !== 'string' || typeof localeEn.meta?.description !== 'string') throw new Error(`${dir}/locale/en.json needs meta.title and meta.description`)
  if (typeof localeZh.meta?.title !== 'string' || typeof localeZh.meta?.description !== 'string') throw new Error(`${dir}/locale/zh.json needs meta.title and meta.description`)
  return {
    name: pkg.name,
    title: {
      en: localeEn.meta.title,
      zh: localeZh.meta.title,
    },
    description: {
      en: localeEn.meta.description,
      zh: localeZh.meta.description,
    },
    icon,
    author: pkg.author,
    homepage: pkg.homepage,
    repository: { url: repo, directory: pkg.repository.directory },
    metadata: {
      category: 'developer-tools',
      labels,
      keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
      sortKeys: { published: publishTimestamp },
    },
    'dist-tags': { latest: pkg.version },
    versions: [
      {
        version: pkg.version,
        publishTimestamp,
        source: { type: 'git', url: repo, commit, path: pkg.repository.directory },
        engines: { dsh: pkg.engines.dsh },
      },
    ],
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

// Validate before writing: a bad index is rejected as a whole by every reader.
validateIndex(index, indexUrl)
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`wrote ${out}`)
for (const entry of plugins) {
  console.log(`plugin    ${entry.name}@${entry['dist-tags'].latest}`)
  console.log(`source    git ${repo}#${commit} path=/${entry.repository.directory}`)
}
console.log(`index url ${indexUrl}`)
