#!/usr/bin/env bun
/**
 * Validate the bundled Bun globals catalog against the running Bun runtime.
 *
 * Checks:
 *  - every entry has the documented shape and known kind/runtime/category;
 *  - names are unique and categories are declared;
 *  - every `Bun.*` entry actually exists on the running runtime;
 *  - every example transpiles as TypeScript;
 *  - reports the runtime globals the catalog does not cover (curation warning,
 *    not an error), so the digest does not silently drift after a Bun upgrade.
 *
 * Usage: bun bun-native/tools/validate-catalog.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const here = dirname(import.meta.path)
const catalogPath = join(here, '..', 'data', 'bun-globals.json')
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))

let errors = 0
const fail = (message) => {
  errors += 1
  console.error(`FAIL ${message}`)
}

const KINDS = new Set(['function', 'class', 'object', 'namespace', 'module', 'value'])
const RUNTIMES = new Set(['any', 'server', 'module'])
const REQUIRED = ['name', 'category', 'kind', 'summary', 'signature', 'docsUrl', 'runtime', 'example']

if (catalog.bunVersion !== Bun.version) {
  console.warn(`WARN catalog records Bun ${catalog.bunVersion}, running Bun ${Bun.version}; review new or changed globals`)
}

const categoryIds = new Set()
for (const category of catalog.categories ?? []) {
  if (typeof category.id !== 'string' || typeof category.title !== 'string' || typeof category.summary !== 'string') fail(`category ${JSON.stringify(category.id)} is missing id/title/summary`)
  if (categoryIds.has(category.id)) fail(`duplicate category ${category.id}`)
  categoryIds.add(category.id)
}

const names = new Set()
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const counts = new Map()

for (const [index, entry] of catalog.apis.entries()) {
  const at = `apis[${String(index)}]`
  for (const key of REQUIRED) {
    if (typeof entry[key] !== 'string' || entry[key].trim() === '') fail(`${at} (${entry.name ?? '?'}) is missing ${key}`)
  }
  if (!KINDS.has(entry.kind)) fail(`${at} ${entry.name} has unknown kind ${JSON.stringify(entry.kind)}`)
  if (!RUNTIMES.has(entry.runtime)) fail(`${at} ${entry.name} has unknown runtime ${JSON.stringify(entry.runtime)}`)
  if (!categoryIds.has(entry.category)) fail(`${at} ${entry.name} references undeclared category ${JSON.stringify(entry.category)}`)
  if (typeof entry.example !== 'string' || entry.example.trim() === '') fail(`${at} ${entry.name} has no example`)
  if (names.has(entry.name)) fail(`${at} duplicates ${entry.name}`)
  names.add(entry.name)
  counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)

  try {
    transpiler.transformSync(entry.example)
  } catch (error) {
    fail(`${at} ${entry.name} example does not transpile: ${error instanceof Error ? error.message : String(error)}`)
  }

  const runtimeName = /^Bun\.([A-Za-z_$][\w$]*)$/u.exec(entry.name)?.[1]
  if (runtimeName !== undefined && !(runtimeName in Bun)) fail(`${at} ${entry.name} does not exist on Bun ${Bun.version}`)
}

for (const category of categoryIds) {
  if (!counts.has(category)) fail(`category ${category} has no entries`)
}

const covered = new Set(catalog.apis.map((entry) => /^Bun\.([A-Za-z_$][\w$]*)$/u.exec(entry.name)?.[1]).filter(Boolean))
const uncovered = Object.getOwnPropertyNames(Bun)
  .filter((name) => !covered.has(name))
  .sort()

console.log(`catalog: ${catalog.apis.length} APIs in ${categoryIds.size} categories (Bun ${Bun.version})`)
if (uncovered.length > 0) console.log(`uncovered runtime globals (${uncovered.length}, curation only): ${uncovered.join(', ')}`)
if (errors > 0) {
  console.error(`\n${errors} catalog problem(s)`)
  process.exit(1)
}
console.log('catalog valid')
