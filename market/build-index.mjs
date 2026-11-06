#!/usr/bin/env bun
/**
 * Build the format-1 plugin market index for `@local/bun-native`.
 *
 * The index is the JSON document DSH's Discover tab and `plugin_market` tool
 * read. Format 1 is defined by the DSH repo Agent Note
 * `.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md`
 * and validated by `@deepseek-ai/dsh-plugin-market-index`; this script mirrors
 * the parts a publisher must satisfy and validates its own output.
 *
 * Usage:
 *   bun market/build-index.mjs --commit <40-hex> [--publish-timestamp <unix>]
 *     [--repo https://github.com/<owner>/<repo>] [--branch main] [--out market/index.json]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { validateIndex } from './validate-index.mjs'

const here = dirname(import.meta.path)
const packageDir = resolve(here, '..', 'bun-native')

/** Read one CLI option. */
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
  return value
}

const repo = option('repo', 'https://github.com/brendadeeznuts1111/dsh-bun-native').replace(/\/+$/u, '')
const branch = option('branch', 'main')
const commit = option('commit', undefined)
const out = resolve(option('out', join(here, 'index.json')))
if (commit === undefined || !/^[0-9a-f]{40}$/u.test(commit)) throw new Error('--commit must be the lowercase 40-hex commit SHA that contains the bundle')

const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const localeEn = JSON.parse(readFileSync(join(packageDir, 'locale', 'en.json'), 'utf8'))
const localeZh = JSON.parse(readFileSync(join(packageDir, 'locale', 'zh.json'), 'utf8'))
const enginesDsh = pkg.engines?.dsh
if (typeof enginesDsh !== 'string' || !enginesDsh.trim()) throw new Error('package.json must declare engines.dsh for market listing')
if (pkg.repository?.directory !== 'bun-native') throw new Error('package.json repository.directory must be "bun-native"')

const publishTimestamp = Number(option('publish-timestamp', String(Math.floor(Date.now() / 1000))))
if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0) throw new Error('--publish-timestamp must be integer Unix seconds')

const indexUrl = `https://raw.githubusercontent.com/${new URL(repo).pathname.replace(/^\//u, '')}/${branch}/market/index.json`

const index = {
  format: 1,
  title: { en: 'Bun-native DSH plugins', zh: 'Bun 原生 DSH 插件' },
  description: {
    en: 'Format-1 plugin market index for the Bun-native DSH bundle.',
    zh: 'Bun 原生 DSH 组合包的 format-1 插件市场索引。',
  },
  metadata: {
    categories: {
      'developer-tools': { title: { en: 'Developer tools', zh: '开发者工具' } },
    },
    labels: {
      bun: { title: { en: 'Bun', zh: 'Bun' } },
      offline: { title: { en: 'Offline', zh: '离线' } },
    },
    sortKeys: {
      published: { title: { en: 'Published', zh: '发布时间' }, order: 'desc' },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: {
        en: localeEn.meta.title,
        zh: localeZh.meta.title,
      },
      description: {
        en: localeEn.meta.description,
        zh: localeZh.meta.description,
      },
      icon: 'icons/bun-native.svg',
      author: pkg.author,
      homepage: pkg.homepage,
      repository: { url: repo, directory: pkg.repository.directory },
      metadata: {
        category: 'developer-tools',
        labels: ['bun', 'offline'],
        keywords: pkg.keywords,
        sortKeys: { published: publishTimestamp },
      },
      'dist-tags': { latest: pkg.version },
      versions: [
        {
          version: pkg.version,
          publishTimestamp,
          source: { type: 'git', url: repo, commit, path: pkg.repository.directory },
          engines: { dsh: enginesDsh },
        },
      ],
    },
  ],
}

// Validate before writing: a bad index is rejected as a whole by every reader.
validateIndex(index, indexUrl)
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`wrote ${out}`)
console.log(`plugin    ${pkg.name}@${pkg.version}`)
console.log(`source    git ${repo}#${commit} path=/${pkg.repository.directory}`)
console.log(`index url ${indexUrl}`)
