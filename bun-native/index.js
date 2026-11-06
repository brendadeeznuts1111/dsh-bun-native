/**
 * Bun native — Host half of the `@local/bun-native` bundle.
 *
 * Three agent tools for Bun-native work:
 *
 * - `bun_project` reads a directory's Bun markers (`bun.lock`, `bun.lockb`,
 *   `bunfig.toml`, `package.json`, `tsconfig.json`) and classifies the project
 *   so the agent knows which toolchain the workspace actually uses.
 * - `bun_api` answers questions from a bundled, offline digest of the Bun
 *   global API surface (https://bun.com/reference/globals/bun), so Bun-native
 *   code is written against real signatures without a network round-trip.
 * - `bun_exec` runs `bun run`, `bun test`, `bun install` and `bun --eval`
 *   inside the session's sandbox policy, reporting stdout/stderr and the exit
 *   status instead of failing the call.
 *
 * The plugin has no package imports: it is loaded from a workspace directory
 * linked into the profile, so only Node builtins and services reached through
 * `ctx` are available. Configuration is validated here in `apply` rather than
 * through a schemastery `Config` export for the same reason.
 *
 * @module @local/bun-native
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable Loader identity. */
export const name = 'bun-native'

/** Hard dependency: every feature is a tool registration. */
export const inject = ['tools']

const DEFAULTS = {
  bunPath: 'bun',
  timeoutMs: 60_000,
  maxOutputChars: 20_000,
  promptGuidance: true,
}

const MARKER_FILES = {
  packageJson: 'package.json',
  lockText: 'bun.lock',
  lockBinary: 'bun.lockb',
  bunfig: 'bunfig.toml',
  tsconfig: 'tsconfig.json',
  nodeModules: 'node_modules',
  bunVersionFile: '.bun-version',
}

/** Lockfiles from other package managers; Bun migrates them on install. */
const FOREIGN_LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']

/** Nested marker for the isolated workspace linker. */
const ISOLATED_STORE = 'node_modules/.bun'

const EXEC_MODES = ['run', 'test', 'install', 'add', 'ci', 'check', 'lint', 'eval', 'pm']

/**
 * Validate the row config against the documented options.
 * @param {unknown} raw - the row's `config` object.
 * @returns {{bunPath: string, timeoutMs: number, maxOutputChars: number, promptGuidance: boolean}}
 */
function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const bunPath = typeof input.bunPath === 'string' && input.bunPath.trim().length > 0 ? input.bunPath.trim() : DEFAULTS.bunPath
  const timeoutMs = positiveInteger(input.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs', 1_000, 600_000)
  const maxOutputChars = positiveInteger(input.maxOutputChars, DEFAULTS.maxOutputChars, 'maxOutputChars', 1_000, 400_000)
  let promptGuidance = DEFAULTS.promptGuidance
  if (input.promptGuidance !== undefined) {
    if (typeof input.promptGuidance !== 'boolean') throw new Error('bun-native config.promptGuidance must be a boolean')
    promptGuidance = input.promptGuidance
  }
  return { bunPath, timeoutMs, maxOutputChars, promptGuidance }
}

/**
 * Read one bounded integer option.
 * @param {unknown} value - candidate value.
 * @param {number} fallback - value used when absent.
 * @param {string} key - option name for the error message.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number}
 */
function positiveInteger(value, fallback, key, min, max) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`bun-native config.${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

/** @returns {import('node:module').ContentBlock[]} one text block. */
function textBlocks(text) {
  return [{ type: 'text', text }]
}

/**
 * Return only lossless JSON. The tool-output pipeline rejects a value whose
 * properties the serializer would silently drop, so optional fields must be
 * absent rather than `undefined`.
 * @param {unknown} value - candidate tool value.
 * @returns {any}
 */
function lossless(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Describe one reason for an empty output section.
 * @param {string} text - collected text.
 * @returns {string}
 */
function outputBody(text) {
  return text.length === 0 ? '(no output)' : text.replace(/\s+$/, '')
}

/**
 * Shape a finished process into the model-facing text: stdout, a marked
 * stderr section, truncation notices, then exit-status markers. A clean exit
 * leaves no marker; a failure is reported, never thrown.
 * @param {Record<string, any>} value - the tool's result value.
 * @returns {string}
 */
function renderExec(value) {
  const body = []
  const out = outputBody(value.stdout.text)
  body.push(out)
  if (value.stderr.text.length > 0) body.push(`[stderr]\n${outputBody(value.stderr.text)}`)
  if (value.stdout.truncated || value.stderr.truncated) body.push(`[output truncated to ${value.stdout.truncated ? 'the configured cap' : 'the configured cap'}; full stream is in the spill file when reported]`)
  if (value.sandbox?.denied === true) body.push(`[sandbox: the command attempted a denied file operation under ${value.sandbox.mode} mode]`)
  if (value.timedOut === true) body.push(`[timed out after ${value.timeoutMs}ms]`)
  if (value.aborted === true) body.push('[aborted by the caller]')
  if (value.signal !== null && value.signal !== undefined) body.push(`[killed by signal: ${value.signal}]`)
  else if (typeof value.exitCode === 'number' && value.exitCode !== 0) body.push(`[exit code: ${value.exitCode}]`)
  return body.join('\n')
}

/**
 * Render the catalog tool's answer as plain text.
 * @param {Record<string, any>} value - the tool's result value.
 * @returns {string}
 */
function renderApi(value) {
  const warning = value.warning === undefined ? '' : `⚠ ${value.warning}\n\n`
  if (value.entries.length === 0) {
    const lines = [
      `${value.total} curated Bun APIs available. No entry matched; list a category or try a name such as "Bun.serve".`,
      'The digest curates a subset of the runtime surface (70 entries over 117 name-level `Bun` globals on 1.4.4), so a missing name is not proof of a missing API.',
      '',
    ]
    for (const category of value.categories) lines.push(`- ${category.id} (${category.count}) — ${category.title}`)
    lines.push('', 'Live docs: if the Bun docs MCP server is connected, use mcp__bun_docs__search_bun, read_bun_page, grep_bun or list_bun_pages for guides and full pages beyond this digest.')
    return warning + lines.join('\n')
  }
  const blocks = []
  for (const entry of value.entries) {
    const lines = [`**${entry.name}** — ${entry.kind}, ${entry.category}`]
    lines.push(entry.summary)
    if (entry.signature !== undefined && entry.signature.length > 0) lines.push(`\`\`\`ts\n${entry.signature}\n\`\`\``)
    if (entry.docsUrl !== undefined) lines.push(`docs: ${entry.docsUrl}`)
    if (entry.example !== undefined) lines.push(`example:\n\`\`\`ts\n${entry.example}\n\`\`\``)
    blocks.push(lines.join('\n'))
  }
  return warning + blocks.join('\n\n')
}

/**
 * Describe one lockfile record for the model-facing summary.
 * @param {{file: string, kind: string, bytes: number, lockfileVersion?: number}} lockfile - lockfile record.
 * @returns {string}
 */
function lockfileSummary(lockfile) {
  const version = lockfile.lockfileVersion === undefined ? '' : ` — lockfileVersion ${lockfile.lockfileVersion}`
  return `${lockfile.file} (${lockfile.kind}, ${lockfile.bytes} bytes)${version}`
}

/**
 * Describe the workspace relationship for the model-facing summary.
 * @param {Record<string, any>} workspace - workspace record.
 * @returns {string}
 */
function workspaceSummary(workspace) {
  const catalogs = []
  if (workspace.catalog !== undefined && workspace.catalog.length > 0) catalogs.push(`catalog: ${workspace.catalog.join(', ')}`)
  if (workspace.catalogs !== undefined && workspace.catalogs.length > 0) catalogs.push(`named catalogs: ${workspace.catalogs.join(', ')}`)
  const suffix = catalogs.length === 0 ? '' : `; ${catalogs.join('; ')}`
  if (workspace.role === 'root') return `root of patterns ${workspace.patterns.join(', ')}${suffix}`
  return `member${workspace.memberName === undefined ? '' : ` \`${workspace.memberName}\``} of ${workspace.root} (patterns: ${workspace.patterns.join(', ')})${suffix}`
}

/**
 * Render the project inspection as plain text.
 * @param {Record<string, any>} value - the tool's result value.
 * @returns {string}
 */
function renderProject(value) {
  const lines = [
    `Directory: ${value.directory}`,
    `Classification: ${value.kind} (${value.confidence})`,
    `Signals: ${value.signals.length === 0 ? 'none' : value.signals.join(', ')}`,
    `Runtime: ${value.runtime?.version !== undefined ? `Bun ${value.runtime.version}${value.runtime.executable !== undefined ? ` (${value.runtime.executable})` : ''}` : 'unavailable'}`,
    `Lockfile: ${value.lockfile === null ? (value.workspace?.rootLockfile === undefined ? 'none' : `none here — workspace root ${lockfileSummary(value.workspace.rootLockfile)}`) : lockfileSummary(value.lockfile)}`,
    ...(value.workspace === null ? [] : [`Workspace: ${workspaceSummary(value.workspace)}`]),
    ...(value.otherLockfiles.length === 0 ? [] : [`Other lockfiles: ${value.otherLockfiles.join(', ')}`]),
    `Bunfig: ${value.bunfig === null ? 'none' : `${value.bunfig.file}${value.bunfig.sections.length > 0 ? ` — sections: ${value.bunfig.sections.join(', ')}` : ''}`}`,
    `TypeScript: ${value.typescript.present ? `tsconfig.json${value.typescript.bunTypes ? ' (bun types configured)' : ''}` : 'no tsconfig.json'}`,
    `node_modules: ${value.nodeModules ? `present${value.isolatedStore ? ' (isolated store node_modules/.bun)' : ''}` : 'absent'}`,
    `Linker: ${value.linker.strategy}${value.linker.source === 'none' ? '' : ` (from ${value.linker.source})`}`,
  ]
  const pkg = value.packageJson
  if (pkg === null) lines.push('package.json: absent')
  else {
    lines.push(`package.json: ${pkg.name ?? '(unnamed)'}${pkg.version !== undefined ? `@${pkg.version}` : ''}${pkg.packageManager !== undefined ? ` — packageManager: ${pkg.packageManager}` : ''}`)
    lines.push(`Dependencies: ${pkg.dependencies} runtime, ${pkg.devDependencies} dev, ${pkg.scripts.length} scripts`)
    if (pkg.workspaceDependencies.length > 0) {
      lines.push(`Workspace dependencies: ${pkg.workspaceDependencies.map((dependency) => `${dependency.name} ${dependency.range} (${dependency.group})`).join(', ')}`)
    }
    if (pkg.scripts.length > 0) {
      lines.push('Scripts:')
      for (const script of pkg.scripts.slice(0, 40)) lines.push(`  - ${script.name}: ${script.command}`)
    }
    if (pkg.workspaces.length > 0) lines.push(`Workspaces: ${pkg.workspaces.join(', ')}`)
  }
  if (value.recommended.length > 0) {
    lines.push('Recommended commands:')
    for (const item of value.recommended) lines.push(`  - ${item.command} — ${item.label}`)
  }
  if (value.notes.length > 0) {
    lines.push('Notes:')
    for (const note of value.notes) lines.push(`  - ${note}`)
  }
  return lines.join('\n')
}

/** Cached catalog document plus the file stamp it was read at. */
let catalogCache

/** Cached `bun --version` result per executable, so project reads stay cheap. */
const versionCache = new Map()

/**
 * Load and validate the bundled Bun globals digest. The cache is keyed on the
 * file's modification time, so a catalog edit during development is picked up
 * without reloading the plugin.
 * @returns {{bunVersion?: string, referenceUrl?: string, categories: any[], apis: any[]}}
 */
function loadCatalog() {
  const file = fileURLToPath(new URL('./data/bun-globals.json', import.meta.url))
  let mtimeMs
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch (error) {
    throw new Error(`bun_api is unavailable: cannot read the bundled Bun catalog at ${file} (${error instanceof Error ? error.message : String(error)})`)
  }
  if (catalogCache !== undefined && catalogCache.mtimeMs === mtimeMs) return catalogCache.value
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`bun_api is unavailable: cannot read the bundled Bun catalog at ${file} (${error instanceof Error ? error.message : String(error)})`)
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.apis) || !Array.isArray(parsed.categories)) {
    throw new Error('bun_api is unavailable: the bundled Bun catalog is malformed (expected "apis" and "categories" arrays)')
  }
  catalogCache = { mtimeMs, value: parsed }
  return parsed
}

/**
 * Rank catalog entries for one query. Tiers: exact name, name prefix, name
 * substring, summary/signature/category match.
 * @param {any[]} apis - every catalog entry.
 * @param {string} query - user query, possibly empty.
 * @param {string | undefined} category - exact category filter.
 * @returns {any[]}
 */
function rankApis(apis, query, category) {
  const needle = query.trim().toLowerCase()
  let pool = category === undefined ? apis : apis.filter((entry) => entry.category === category)
  if (needle.length === 0) return pool
  const scored = []
  for (const entry of pool) {
    const apiName = String(entry.name).toLowerCase()
    let score = -1
    if (apiName === needle) score = 0
    else if (apiName.startsWith(needle)) score = 1
    else if (apiName.includes(needle)) score = 2
    else if (`${entry.summary} ${entry.signature ?? ''} ${entry.category}`.toLowerCase().includes(needle)) score = 3
    if (score >= 0) scored.push({ entry, score, length: apiName.length })
  }
  scored.sort((left, right) => left.score - right.score || left.length - right.length || left.entry.name.localeCompare(right.entry.name))
  return scored.map((item) => item.entry)
}

/**
 * Project one catalog entry for the model.
 * @param {any} entry - catalog entry.
 * @param {boolean} detail - include the example and docs link.
 * @returns {Record<string, any>}
 */
function projectApi(entry, detail) {
  const value = {
    name: entry.name,
    category: entry.category,
    kind: entry.kind,
    summary: entry.summary,
    signature: entry.signature,
    runtime: entry.runtime,
  }
  if (detail) {
    value.docsUrl = entry.docsUrl
    if (entry.example !== undefined) value.example = entry.example
  }
  return value
}

/**
 * Resolve the session working directory for a call.
 * @param {any} ctx - the plugin context.
 * @param {any} exec - tool run context.
 * @returns {Promise<string>}
 */
async function sessionCwd(ctx, exec) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory !== undefined && exec.agent !== undefined) {
    return await workingDirectory.ensure(exec.agent, exec.signal)
  }
  if (workingDirectory !== undefined && typeof workingDirectory.defaultDirectory === 'string') return workingDirectory.defaultDirectory
  return process.cwd()
}

/**
 * Resolve a tool-supplied directory against the session cwd.
 * @param {string} base - session cwd.
 * @param {string | undefined} requested - optional override.
 * @returns {string}
 */
function resolveDirectory(base, requested) {
  if (requested === undefined) return base
  const trimmed = requested.trim()
  if (trimmed.length === 0) return base
  return isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(base, trimmed)
}

/**
 * Read one path's metadata through the workspace filesystem service.
 * @param {any} fs - the fs service.
 * @param {string} target - path to resolve.
 * @param {string} cwd - base for relative paths.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<{path: string, info: any, target: any}>}
 */
async function probePath(fs, target, cwd, signal) {
  const resolved = await fs.resolve(target, { cwd, signal })
  const info = await fs.stat(resolved, signal)
  return { path: fs.processPath(resolved), target: resolved, info }
}

/**
 * Read a probed regular file's UTF-8 text, or undefined when absent.
 * @param {any} fs - the fs service.
 * @param {{info: any, target: any}} probed - result of probePath.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<string | undefined>}
 */
async function readProbedText(fs, probed, signal) {
  if (probed.info === undefined || probed.info.type !== 'file') return undefined
  try {
    return await fs.readText(probed.target, signal)
  } catch {
    return undefined
  }
}

/**
 * Extract own `[section]` names from a bunfig.toml without a TOML parser.
 * @param {string} text - file text.
 * @returns {string[]}
 */
function bunfigSections(text) {
  const sections = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
    if (match !== null) sections.push(match[1].trim())
  }
  return [...new Set(sections)]
}

/**
 * Detect whether a tsconfig mentions Bun's types.
 * @param {string} text - file text.
 * @returns {boolean}
 */
function mentionsBunTypes(text) {
  return /"(?:@types\/bun|bun)"\s*[,}\]]/.test(text)
}

/**
 * Read the first integer value of one JSON/JSONC field without a parser.
 * @param {string} text - file text.
 * @param {string} key - field name.
 * @returns {number | undefined}
 */
function integerField(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(text)
  return match === null ? undefined : Number(match[1])
}

/**
 * Inspect the project rooted at `directory`.
 * @param {any} ctx - the plugin context.
 * @param {any} exec - tool run context.
 * @param {string} directory - absolute directory.
 * @param {Record<string, any>} config - resolved plugin config.
 * @param {(cwd: string) => Promise<{version?: string, executable?: string, error?: string}>} readRuntime - runtime probe.
 * @returns {Promise<Record<string, any>>}
 */
async function inspectProject(ctx, exec, directory, config, readRuntime) {
  const fs = ctx.get('fs')
  if (fs === undefined) throw new Error('bun_project requires the Host filesystem service, which this profile does not provide')
  const signal = exec.signal
  const rootProbe = await probePath(fs, directory, directory, signal)
  if (rootProbe.info === undefined) throw new Error(`Directory not found: ${directory}`)
  if (rootProbe.info.type !== 'directory') throw new Error(`Not a directory: ${directory}`)

  const names = [...Object.values(MARKER_FILES), ...FOREIGN_LOCKFILES, ISOLATED_STORE]
  const probed = {}
  const entries = await Promise.all(names.map(async (fileName) => [fileName, await probePath(fs, fileName, directory, signal)]))
  for (const [fileName, result] of entries) probed[fileName] = result

  const packageText = await readProbedText(fs, probed[MARKER_FILES.packageJson], signal)
  let rawPackage
  if (packageText !== undefined) {
    try {
      rawPackage = JSON.parse(packageText)
    } catch {
      rawPackage = undefined
    }
  }

  const notes = []
  if (packageText !== undefined && rawPackage === undefined) notes.push('package.json exists but is not valid JSON; scripts and dependencies were not read.')

  const lockTextProbe = probed[MARKER_FILES.lockText]
  const lockBinaryProbe = probed[MARKER_FILES.lockBinary]
  const lockTextContent = await readProbedText(fs, lockTextProbe, signal)
  let lockfile = null
  if (lockTextContent !== undefined) {
    lockfile = { file: MARKER_FILES.lockText, kind: 'text', bytes: lockTextProbe.info.size ?? 0 }
    const lockfileVersion = integerField(lockTextContent, 'lockfileVersion')
    if (lockfileVersion !== undefined) lockfile.lockfileVersion = lockfileVersion
    const configVersion = integerField(lockTextContent, 'configVersion')
    if (configVersion !== undefined) lockfile.configVersion = configVersion
  } else if (lockBinaryProbe.info !== undefined && lockBinaryProbe.info.type === 'file') {
    lockfile = { file: MARKER_FILES.lockBinary, kind: 'legacy-binary', bytes: lockBinaryProbe.info.size ?? 0 }
    notes.push('Legacy binary bun.lockb found; run `bun install --save-text-lockfile` to migrate to the committed text lockfile bun.lock.')
  }
  if (lockfile !== null && lockfile.kind === 'text' && lockBinaryProbe.info !== undefined) {
    notes.push('Both bun.lock and bun.lockb exist; the text lockfile wins — delete the stale bun.lockb.')
  }

  const otherLockfiles = FOREIGN_LOCKFILES.filter((fileName) => probed[fileName].info !== undefined && probed[fileName].info.type === 'file')
  if (otherLockfiles.length > 0) {
    notes.push(`Found ${otherLockfiles.join(', ')}; run \`bun install\` to migrate to bun.lock (Bun reads a foreign lockfile once and then writes its own).`)
  }

  const bunfigText = await readProbedText(fs, probed[MARKER_FILES.bunfig], signal)
  const bunfig = bunfigText === undefined ? null : { file: MARKER_FILES.bunfig, sections: bunfigSections(bunfigText) }

  const tsconfigText = await readProbedText(fs, probed[MARKER_FILES.tsconfig], signal)
  const typescript = { present: tsconfigText !== undefined, bunTypes: tsconfigText === undefined ? false : mentionsBunTypes(tsconfigText) }

  const nodeModulesProbe = probed[MARKER_FILES.nodeModules]
  const nodeModules = nodeModulesProbe.info !== undefined && nodeModulesProbe.info.type === 'directory'
  const isolatedStoreProbe = probed[ISOLATED_STORE]
  const isolatedStore = isolatedStoreProbe.info !== undefined && isolatedStoreProbe.info.type === 'directory'

  const pkg = rawPackage === undefined ? null : {
    ...(typeof rawPackage.name === 'string' ? { name: rawPackage.name } : {}),
    ...(typeof rawPackage.version === 'string' ? { version: rawPackage.version } : {}),
    ...(typeof rawPackage.packageManager === 'string' ? { packageManager: rawPackage.packageManager } : {}),
    scripts: Object.entries(typeof rawPackage.scripts === 'object' && rawPackage.scripts !== null ? rawPackage.scripts : {}).map(([scriptName, command]) => ({ name: scriptName, command: String(command) })),
    dependencies: Object.keys(typeof rawPackage.dependencies === 'object' && rawPackage.dependencies !== null ? rawPackage.dependencies : {}).length,
    devDependencies: Object.keys(typeof rawPackage.devDependencies === 'object' && rawPackage.devDependencies !== null ? rawPackage.devDependencies : {}).length,
    workspaceDependencies: readWorkspaceDependencies(rawPackage),
    workspaces: readWorkspaces(rawPackage.workspaces),
  }

  const devDependencyNames = rawPackage !== undefined && typeof rawPackage.devDependencies === 'object' && rawPackage.devDependencies !== null ? Object.keys(rawPackage.devDependencies) : []
  const bunTypesDependency = devDependencyNames.some((dependency) => dependency === '@types/bun' || dependency === 'bun-types')
  const bunVersionPin = probed[MARKER_FILES.bunVersionFile].info !== undefined
  const scriptsText = pkg === null ? '' : pkg.scripts.map((script) => script.command).join('\n')
  const usesBunScripts = /(?:^|[\s&|;(])bun(?:x)?(?:\s|$)/.test(scriptsText)
  const declaredBun = pkg !== null && pkg.packageManager !== undefined && pkg.packageManager.startsWith('bun@')
  const hasPackage = pkg !== null

  const signals = []
  if (lockfile !== null && lockfile.kind === 'text') signals.push('bun.lock')
  if (lockfile !== null && lockfile.kind === 'legacy-binary') signals.push('bun.lockb')
  if (bunfig !== null) signals.push('bunfig.toml')
  if (declaredBun) signals.push('packageManager:bun')
  if (usesBunScripts) signals.push('scripts:bun')
  if (bunVersionPin) signals.push('.bun-version')
  if (bunTypesDependency) signals.push('@types/bun')

  const strongSignal = lockfile !== null || usesBunScripts
  const mediumSignal = bunfig !== null || declaredBun
  let kind = 'none'
  if (signals.length > 0) kind = 'bun-native'
  else if (hasPackage || nodeModules) kind = 'bun-capable'
  let confidence = kind === 'bun-native' ? (strongSignal ? 'strong' : mediumSignal ? 'medium' : 'weak') : kind === 'bun-capable' ? 'capable' : 'none'

  // A repo that keeps another package manager's lockfile next to bun.lock is not
  // Bun-only; keep the classification but lower confidence, because
  // promptGuidance must not forbid npm/yarn outright there.
  const mixedLockfiles = lockfile !== null && otherLockfiles.length > 0
  if (mixedLockfiles) {
    signals.push('mixed-lockfiles')
    if (confidence === 'strong') confidence = 'medium'
  }

  // Bun's workspace root owns the single bun.lock; a member directory has none
  // of its own, so resolve the ancestor root before finalizing classification.
  let workspace = null
  let workspaceRootInfo
  let workspaceCapped = false
  let unmatchedWorkspace = null
  if (lockfile === null) {
    const found = await findWorkspaceRoot(fs, directory, signal)
    if (found !== undefined && found.capped === true) {
      workspaceCapped = true
    } else if (found !== undefined) {
      workspaceRootInfo = found
      const memberPath = relative(found.root, directory).split(sep).join('/')
      if (matchesWorkspacePatterns(memberPath, found.patterns)) {
        const catalogs = readWorkspaceCatalogs(found.raw)
        workspace = {
          role: 'member',
          root: found.root,
          patterns: found.patterns,
          memberPath,
          ...(pkg !== null && typeof pkg.name === 'string' ? { memberName: pkg.name } : {}),
          ...(found.lockfile === null ? {} : { rootLockfile: found.lockfile }),
          ...(catalogs.catalog.length === 0 ? {} : { catalog: catalogs.catalog }),
          ...(catalogs.catalogs.length === 0 ? {} : { catalogs: catalogs.catalogs }),
        }
        signals.push('workspace:member')
        kind = 'bun-native'
        confidence = found.lockfile !== null ? 'strong' : mediumSignal ? 'medium' : 'weak'
        if (mixedLockfiles && confidence === 'strong') confidence = 'medium'
      } else {
        unmatchedWorkspace = { root: found.root, patterns: found.patterns, memberPath: memberPath.length === 0 ? '.' : memberPath }
      }
    }
  } else if (rawPackage !== undefined) {
    const patterns = readWorkspaces(rawPackage.workspaces)
    if (patterns.length > 0) {
      const catalogs = readWorkspaceCatalogs(rawPackage)
      workspace = {
        role: 'root',
        root: directory,
        patterns,
        ...(catalogs.catalog.length === 0 ? {} : { catalog: catalogs.catalog }),
        ...(catalogs.catalogs.length === 0 ? {} : { catalogs: catalogs.catalogs }),
      }
    }
  }

  const linkerBunfig = readBunfigLinker(bunfigText) ?? (workspaceRootInfo === undefined ? undefined : readBunfigLinker(workspaceRootInfo.bunfigText))
  const isolatedStoreAnywhere = isolatedStore || (workspaceRootInfo !== undefined && workspaceRootInfo.isolatedStore === true)
  const nodeModulesAnywhere = nodeModules || (workspaceRootInfo !== undefined && workspaceRootInfo.nodeModules === true)
  const linker = {
    strategy: linkerBunfig ?? (isolatedStoreAnywhere ? 'isolated' : nodeModulesAnywhere ? 'hoisted' : 'unknown'),
    source: linkerBunfig !== undefined ? 'bunfig' : isolatedStoreAnywhere ? 'node_modules/.bun' : nodeModulesAnywhere ? 'node_modules' : 'none',
  }
  if (linker.strategy === 'unknown') notes.push('No node_modules tree or [install] linker setting was found; run `bun install` to materialize the dependency layout.')

  if (kind === 'bun-native' && hasPackage === false) notes.push('Bun markers exist without a package.json; this is not a complete JavaScript/TypeScript package yet.')
  if (kind === 'bun-native' && lockfile === null && workspace === null) notes.push('This is a Bun project without a lockfile; run `bun install` to create bun.lock and commit it.')
  if (kind === 'bun-capable') notes.push('package.json shows no Bun marker (no bun.lock/bun.lockb, bunfig.toml, `packageManager: bun@…`, bun in scripts, .bun-version, or @types/bun); Bun can run it, but the repository is not Bun-first.')
  if (kind === 'none') notes.push('No package.json or Bun marker was found in this directory; nothing to run here yet.')
  if (mixedLockfiles) notes.push(`Mixed package-manager repo: ${lockfile.file} coexists with ${otherLockfiles.join(', ')}; confidence is ${confidence}, so do not assume the repo is Bun-only.`)
  if (workspaceCapped) notes.push('Workspace root not found within 8 ancestor directories; the root may be deeper. Run `bun install` at the repository root or inspect that directory directly.')
  if (unmatchedWorkspace !== null) notes.push(`The nearest workspaces declaration is at ${unmatchedWorkspace.root} (patterns: ${unmatchedWorkspace.patterns.join(', ')}), but this directory (${unmatchedWorkspace.memberPath}) is not matched by those globs, so it is not treated as a workspace member.`)
  if (workspace !== null && workspace.role === 'member') {
    notes.push(`This directory is workspace member${workspace.memberName === undefined ? '' : ` \`${workspace.memberName}\``} of the Bun workspace rooted at ${workspace.root} (patterns: ${workspace.patterns.join(', ')}); the root owns ${workspace.rootLockfile === undefined ? 'the lockfile' : workspace.rootLockfile.file}.`)
    if (workspace.rootLockfile === undefined) notes.push('The workspace root has no Bun lockfile yet; run `bun install` there to create it.')
  }
  if (workspace !== null && workspace.role === 'root') {
    notes.push(`Bun workspace root for patterns ${workspace.patterns.join(', ')}; list every member and its dependency tree with \`bun pm ls --all\`.`)
  }

  const runtime = await readRuntime(directory)
  if (runtime.error !== undefined) notes.push(`Could not read the Bun runtime version: ${runtime.error}`)

  const hasScript = (scriptName) => pkg !== null && pkg.scripts.some((script) => script.name === scriptName)
  const recommended = []
  if (workspace !== null && workspace.role === 'member') {
    const filterTarget = workspace.memberName !== undefined ? workspace.memberName : `./${workspace.memberPath}`
    recommended.push({ label: 'install only this workspace member against the root lockfile', command: `bun install --filter ${quoteArgument(filterTarget)}` })
    recommended.push({ label: 'list every workspace member and its dependency tree', command: 'bun pm ls --all' })
    recommended.push({ label: 'install the whole workspace', command: 'bun install' })
  } else if (lockfile === null) {
    recommended.push({ label: 'install dependencies and create bun.lock', command: 'bun install' })
  } else {
    recommended.push({ label: 'install from the committed lockfile (CI)', command: 'bun ci' })
    if (workspace !== null) recommended.push({ label: 'list every workspace member and its dependency tree', command: 'bun pm ls --all' })
  }
  if (pkg !== null) {
    for (const script of pkg.scripts) recommended.push({ label: `package.json script "${script.name}"`, command: `bun run ${quoteArgument(script.name)}` })
  }
  if (typescript.present && !hasScript('typecheck') && !hasScript('check')) recommended.push({ label: 'typecheck natively (install @types/bun first)', command: 'bun check' })
  if (!hasScript('test')) recommended.push({ label: 'run the bun:test suite', command: 'bun test' })

  const markers = []
  for (const fileName of Object.values(MARKER_FILES)) {
    const info = probed[fileName].info
    if (info !== undefined) markers.push({ name: fileName, type: info.type })
  }

  return lossless({
    directory,
    kind,
    confidence,
    signals,
    runtime,
    lockfile,
    otherLockfiles,
    workspace,
    bunfig,
    typescript,
    nodeModules,
    isolatedStore,
    linker,
    packageJson: pkg,
    markers,
    recommended: kind === 'none' ? [] : recommended.slice(0, 12),
    notes,
    configuredBunPath: config.bunPath,
  })
}

/**
 * Read the `workspaces` field in either supported shape.
 * @param {unknown} value - raw package.json field.
 * @returns {string[]}
 */
function readWorkspaces(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  if (value !== null && typeof value === 'object' && Array.isArray(value.packages)) return value.packages.filter((item) => typeof item === 'string')
  return []
}

/**
 * Read and parse the package.json in one directory.
 * @param {any} fs - the fs service.
 * @param {string} directory - directory to read.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<{raw: any, text: string} | undefined>}
 */
async function readPackageJsonAt(fs, directory, signal) {
  const probed = await probePath(fs, MARKER_FILES.packageJson, directory, signal)
  const text = await readProbedText(fs, probed, signal)
  if (text === undefined) return undefined
  try {
    return { raw: JSON.parse(text), text }
  } catch {
    return { raw: undefined, text }
  }
}

/**
 * Read the workspace catalogs declared by a root package.json. Bun accepts
 * them top-level or inside the object form of `workspaces`.
 * @param {any} raw - parsed package.json.
 * @returns {{catalog: string[], catalogs: string[]}}
 */
function readWorkspaceCatalogs(raw) {
  const workspaces = raw !== null && typeof raw === 'object' ? raw.workspaces : undefined
  const objectForm = workspaces !== null && typeof workspaces === 'object' && !Array.isArray(workspaces) ? workspaces : undefined
  const defaultCatalog = raw?.catalog ?? objectForm?.catalog
  const namedCatalogs = raw?.catalogs ?? objectForm?.catalogs
  return {
    catalog: defaultCatalog !== null && typeof defaultCatalog === 'object' ? Object.keys(defaultCatalog) : [],
    catalogs: namedCatalogs !== null && typeof namedCatalogs === 'object' ? Object.keys(namedCatalogs) : [],
  }
}

/**
 * Describe the Bun lockfile in one directory.
 * @param {any} fs - the fs service.
 * @param {string} directory - directory to read.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<{lockfile: any, legacyBinary: boolean}>}
 */
async function describeLockfile(fs, directory, signal) {
  const textProbe = await probePath(fs, MARKER_FILES.lockText, directory, signal)
  const text = await readProbedText(fs, textProbe, signal)
  const binaryProbe = await probePath(fs, MARKER_FILES.lockBinary, directory, signal)
  const legacyBinary = binaryProbe.info !== undefined && binaryProbe.info.type === 'file'
  if (text !== undefined) {
    const lockfile = { file: MARKER_FILES.lockText, kind: 'text', bytes: textProbe.info.size ?? 0 }
    const lockfileVersion = integerField(text, 'lockfileVersion')
    if (lockfileVersion !== undefined) lockfile.lockfileVersion = lockfileVersion
    const configVersion = integerField(text, 'configVersion')
    if (configVersion !== undefined) lockfile.configVersion = configVersion
    return { lockfile, legacyBinary }
  }
  if (legacyBinary) return { lockfile: { file: MARKER_FILES.lockBinary, kind: 'legacy-binary', bytes: binaryProbe.info.size ?? 0 }, legacyBinary }
  return { lockfile: null, legacyBinary: false }
}

/**
 * Walk up from one directory to the nearest ancestor that declares Bun
 * workspaces and owns Bun markers. Bun resolves the workspace root from any
 * member directory, so detection has to as well.
 * @param {any} fs - the fs service.
 * @param {string} directory - the inspected directory.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<{root: string, patterns: string[], lockfile: any, raw: any} | undefined>}
 */
async function findWorkspaceRoot(fs, directory, signal) {
  let current = dirname(directory)
  let sawPackage = false
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = dirname(current)
    if (current === parent || current.length === 0) return sawPackage ? { capped: true } : undefined
    const pkg = await readPackageJsonAt(fs, current, signal)
    if (pkg !== undefined && pkg.raw !== undefined) {
      sawPackage = true
      const patterns = readWorkspaces(pkg.raw.workspaces)
      if (patterns.length > 0) {
        const lock = await describeLockfile(fs, current, signal)
        const bunfigProbe = await probePath(fs, MARKER_FILES.bunfig, current, signal)
        const bunfigText = await readProbedText(fs, bunfigProbe, signal)
        const storeProbe = await probePath(fs, ISOLATED_STORE, current, signal)
        const isolatedStore = storeProbe.info !== undefined && storeProbe.info.type === 'directory'
        const nodeModulesProbe = await probePath(fs, MARKER_FILES.nodeModules, current, signal)
        const nodeModules = nodeModulesProbe.info !== undefined && nodeModulesProbe.info.type === 'directory'
        const scripts = pkg.raw.scripts !== null && typeof pkg.raw.scripts === 'object' ? pkg.raw.scripts : {}
        const scriptsText = Object.values(scripts).map(String).join('\n')
        const bunScripts = /(?:^|[\s&|;(])bun(?:x)?(?:\s|$)/.test(scriptsText)
        if (lock.lockfile !== null || bunfigText !== undefined || bunScripts) {
          return { root: current, patterns, lockfile: lock.lockfile, raw: pkg.raw, bunfigText, isolatedStore, nodeModules }
        }
      }
    }
    current = parent
  }
  // The cap is a defined failure mode, not a silent "no lockfile": report it so
  // the caller can say that the root was not found within 8 ancestors.
  return sawPackage ? { capped: true } : undefined
}

/**
 * Test one workspace-relative path against the root's `workspaces` patterns.
 * Supports `*` (one segment), `**` (any segments), `?`, and leading `!`
 * negation, which covers the documented glob forms.
 * @param {string} memberPath - `/`-separated path relative to the workspace root.
 * @param {string[]} patterns - declared workspace globs.
 * @returns {boolean}
 */
function matchesWorkspacePatterns(memberPath, patterns) {
  const compiled = (pattern) => {
    const normalized = pattern.replace(/^\.\//u, '').replace(/\/+$/u, '')
    let source = ''
    for (let index = 0; index < normalized.length; index += 1) {
      const character = normalized[index]
      if (character === '*') {
        if (normalized[index + 1] === '*') {
          source += '.*'
          index += 1
          if (normalized[index + 1] === '/') {
            source += '/'
            index += 1
          }
        } else {
          source += '[^/]*'
        }
      } else if (character === '?') {
        source += '[^/]'
      } else {
        source += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      }
    }
    return new RegExp(`^${source}$`, 'u')
  }
  let matched = false
  for (const raw of patterns) {
    const negated = raw.startsWith('!')
    const pattern = negated ? raw.slice(1) : raw
    if (compiled(pattern).test(memberPath)) matched = !negated
  }
  return matched
}

/**
 * Read the effective `[install] linker` strategy from bunfig.toml text.
 * @param {string | undefined} text - bunfig.toml contents.
 * @returns {'hoisted' | 'isolated' | undefined}
 */
function readBunfigLinker(text) {
  if (text === undefined) return undefined
  const match = /\blinker\s*=\s*["']?(hoisted|isolated)["']?/.exec(text)
  return match === null ? undefined : match[1]
}

/**
 * List dependencies declared with the `workspace:` protocol. Bun links those
 * to the local workspace member instead of the registry, and `bun publish`
 * rewrites them to the declared version.
 * @param {any} raw - parsed package.json.
 * @returns {Array<{name: string, range: string, group: string}>}
 */
function readWorkspaceDependencies(raw) {
  if (raw === undefined || raw === null) return []
  const result = []
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = raw[group]
    if (dependencies === null || typeof dependencies !== 'object') continue
    for (const [dependencyName, range] of Object.entries(dependencies)) {
      if (typeof range === 'string' && range.startsWith('workspace:')) result.push({ name: dependencyName, range, group })
    }
  }
  return result
}

/**
 * Quote one argument for the console line the model sees. Execution never
 * uses a shell, so this is display-only.
 * @param {string} value - raw argument.
 * @returns {string}
 */
function quoteArgument(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `"${value.replace(/(["\\])/g, '\\$1')}"`
}

/**
 * Resolve the current sandbox policy for one call.
 * @param {any} ctx - the plugin context.
 * @param {any} exec - tool run context.
 * @returns {Record<string, unknown> | undefined}
 */
function resolveSandboxPolicy(ctx, exec) {
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (sandboxPolicy === undefined) return undefined
  const session = exec.agent !== undefined ? exec.agent.session : undefined
  try {
    return sandboxPolicy.resolve(session === undefined ? {} : { session })
  } catch {
    return undefined
  }
}

/**
 * Run the configured Bun executable and collect its output.
 * @param {any} ctx - the plugin context.
 * @param {any} exec - tool run context.
 * @param {Record<string, any>} config - resolved plugin config.
 * @param {{args: readonly string[], cwd: string, timeoutMs: number}} request - invocation.
 * @returns {Promise<Record<string, any>>}
 */
async function runBun(ctx, exec, config, request) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new Error('bun_exec requires the Host subprocess service, which this profile does not provide')
  const signal = exec.signal
  signal.throwIfAborted()

  let program = config.bunPath
  try {
    program = await subprocess.resolveExecutable(config.bunPath, undefined, signal)
  } catch {
    // Keep the configured value: the spawn error names what could not be found.
  }

  let argv = [program, ...request.args]
  let confinement
  const policy = resolveSandboxPolicy(ctx, exec)
  const sandbox = ctx.get('sandbox')
  if (policy !== undefined && policy.mode !== 'danger-full-access' && sandbox !== undefined) {
    const confined = await sandbox.confine(argv, policy, signal)
    argv = confined.argv
    confinement = {
      mode: policy.mode,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
    }
  }

  const collectMaxBytes = Math.max(config.maxOutputChars * 4, 65_536)
  const spawnedAt = Date.now()
  let handle
  try {
    handle = subprocess.spawn({
      argv,
      cwd: request.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: collectMaxBytes, spill: { maxBytes: collectMaxBytes * 8 } },
        stderr: { maxBytes: collectMaxBytes, spill: { maxBytes: collectMaxBytes * 8 } },
      },
      graceMs: 2_000,
      signal,
    })
  } catch (error) {
    throw new Error(`Could not start \`${config.bunPath}\`: ${error instanceof Error ? error.message : String(error)}`)
  }

  let timedOut = false
  const terminate = () => {
    timedOut = true
    try {
      handle.terminate()
    } catch {
      // The process may already have settled.
    }
  }
  // Plain timers keep the plugin free of the `timer` service dependency; the
  // handle is cleared as soon as the process settles.
  const timeoutTimer = setTimeout(terminate, request.timeoutMs)
  timeoutTimer.unref?.()
  const clearTimer = () => clearTimeout(timeoutTimer)

  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    throw new Error(`\`${config.bunPath}\` failed before reporting an exit status: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimer()
  }

  const durationMs = Date.now() - spawnedAt
  const stdout = clampOutput(handle.collected.stdout === undefined ? undefined : handle.collected.stdout.readFrom(0), config.maxOutputChars)
  const stderr = clampOutput(handle.collected.stderr === undefined ? undefined : handle.collected.stderr.readFrom(0), config.maxOutputChars)
  const sandboxReport = confinement === undefined ? undefined : {
    mode: confinement.mode,
    enforcement: confinement.enforcement,
    denied: confinement.denialSignatures.some((signature) => `${stdout.text}\n${stderr.text}`.includes(signature)),
  }

  return lossless({
    command: [config.bunPath, ...request.args].map(quoteArgument).join(' '),
    cwd: request.cwd,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    aborted: signal.aborted === true,
    timeoutMs: request.timeoutMs,
    durationMs,
    stdout,
    stderr,
    ...(sandboxReport === undefined ? {} : { sandbox: sandboxReport }),
  })
}

/**
 * Bound and normalize one collected stream.
 * @param {{text: string, lossy: boolean, spillPath?: string} | undefined} read - collected read.
 * @param {number} maxChars - character cap.
 * @returns {{text: string, truncated: boolean, spillPath?: string}}
 */
function clampOutput(read, maxChars) {
  if (read === undefined) return { text: '', truncated: false }
  let text = read.text
  let truncated = read.lossy === true
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  return read.spillPath === undefined ? { text, truncated } : { text, truncated, spillPath: read.spillPath }
}

/**
 * Read `bun --version` once per executable and cache it briefly.
 * @param {any} ctx - the plugin context.
 * @param {any} exec - tool run context.
 * @param {Record<string, any>} config - resolved plugin config.
 * @param {string} cwd - session directory.
 * @returns {Promise<{version?: string, executable?: string, error?: string}>}
 */
async function readRuntimeVersion(ctx, exec, config, cwd) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) return { error: 'the subprocess service is unavailable' }
  const cached = versionCache.get(config.bunPath)
  if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.value
  let value
  try {
    const result = await runBun(ctx, exec, config, { args: ['--version'], cwd, timeoutMs: 5_000 })
    const version = result.stdout.text.trim()
    value = result.exitCode === 0 && version.length > 0 ? { version } : { error: result.stderr.text.trim().length > 0 ? result.stderr.text.trim() : `exit code ${result.exitCode}` }
  } catch (error) {
    value = { error: error instanceof Error ? error.message : String(error) }
  }
  versionCache.set(config.bunPath, { at: Date.now(), value })
  return value
}

/** Doctor check ids, in report order. */
const DOCTOR_CHECKS = ['runtime', 'project', 'catalog', 'tests']

/** Marker the Bun properties probe prints before its JSON payload. */
const PROBE_MARKER = '__BUN_NATIVE_PROBE__'

/**
 * One-line reason for a thrown value.
 * @param {unknown} error - thrown value.
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether a probe reported one of Bun's named exports as available.
 * @param {unknown} value - probe value, e.g. "function", "object", "module" or "missing".
 * @returns {boolean}
 */
function probeFeaturePresent(value) {
  return typeof value === 'string' && value !== 'missing' && value !== 'undefined'
}

/**
 * Source of the properties probe that runs inside the project's Bun runtime.
 * It reports the runtime identity, whether the Bun native APIs the plugin relies
 * on exist, and which curated catalog names are missing on that runtime.
 * @param {string[]} catalogNames - `Bun.*` member names the catalog curates.
 * @returns {string}
 */
function runtimeProbeSource(catalogNames) {
  return `const marker = ${JSON.stringify(PROBE_MARKER)};
const catalogNames = ${JSON.stringify(catalogNames)};
const probe = (read) => {
  try {
    const value = read();
    return value === undefined || value === null ? 'missing' : typeof value;
  } catch {
    return 'missing';
  }
};
const sqlite = (() => {
  try {
    require('bun:sqlite');
    return 'module';
  } catch {
    return 'missing';
  }
})();
console.log(marker + JSON.stringify({
  version: Bun.version,
  revision: typeof Bun.revision === 'string' ? Bun.revision : null,
  platform: process.platform,
  arch: process.arch,
  features: {
    serve: probe(() => Bun.serve),
    file: probe(() => Bun.file),
    write: probe(() => Bun.write),
    spawn: probe(() => Bun.spawn),
    shell: probe(() => Bun.$),
    glob: probe(() => Bun.Glob),
    hashing: probe(() => Bun.hash),
    password: probe(() => Bun.password),
    transpiler: probe(() => Bun.Transpiler),
    build: probe(() => Bun.build),
    moduleGraph: probe(() => Bun.ModuleGraph),
    sqlite,
    sql: probe(() => Bun.SQL),
    s3: probe(() => Bun.S3Client),
    redis: probe(() => Bun.RedisClient),
    ffi: probe(() => Bun.FFI),
    image: probe(() => Bun.Image),
  },
  nodeUrl: (() => {
    try {
      const nodeUrl = require('node:url');
      const required = ['domainToASCII', 'domainToUnicode', 'fileURLToPath', 'fileURLToPathBuffer', 'format', 'parse', 'pathToFileURL', 'resolve', 'resolveObject', 'urlToHttpOptions'];
      return {
        required: true,
        missing: required.filter((name) => typeof nodeUrl[name] !== 'function'),
        urlSameAsGlobal: nodeUrl.URL === globalThis.URL && nodeUrl.URLSearchParams === globalThis.URLSearchParams,
      };
    } catch {
      return { required: false, missing: [], urlSameAsGlobal: false };
    }
  })(),
  catalog: (() => {
    const missing = catalogNames.filter((name) => !(name in Bun));
    const globals = Object.getOwnPropertyNames(Bun);
    const covered = new Set(catalogNames);
    const uncovered = globals.filter((name) => !covered.has(name)).sort();
    return { checked: catalogNames.length, missing, uncoveredCount: uncovered.length, uncovered };
  })(),
}));`
}

/**
 * Run the properties probe in the project's Bun runtime.
 * @param {any} ctx - the plugin context.
 * @param {any} exec - execution context carrying the abort signal.
 * @param {Record<string, any>} config - resolved plugin config.
 * @param {string} cwd - directory to run in.
 * @returns {Promise<Record<string, any>>}
 */
async function runRuntimeProbe(ctx, exec, config, cwd) {
  const catalog = loadCatalog()
  const names = [...new Set(catalog.apis
    .map((entry) => /^Bun\.([A-Za-z_$][\w$]*)$/u.exec(entry.name)?.[1])
    .filter((name) => typeof name === 'string'))]
  const result = await runBun(ctx, exec, config, { args: ['--eval', runtimeProbeSource(names)], cwd, timeoutMs: 20_000 })
  const line = result.stdout.text.split(/\r?\n/u).find((candidate) => candidate.startsWith(PROBE_MARKER))
  if (result.timedOut) throw new Error('the Bun properties probe timed out')
  if (result.exitCode !== 0 || line === undefined) {
    const detail = result.stderr.text.trim() || result.stdout.text.trim() || `exit code ${result.exitCode}`
    throw new Error(`the Bun properties probe failed: ${detail.slice(0, 400)}`)
  }
  try {
    return JSON.parse(line.slice(PROBE_MARKER.length))
  } catch {
    throw new Error('the Bun properties probe returned malformed JSON')
  }
}

/**
 * Run the project's own `bun test` suite when it has one.
 * @param {any} ctx - the plugin context.
 * @param {any} exec - execution context carrying the abort signal.
 * @param {Record<string, any>} config - resolved plugin config.
 * @param {string} directory - project directory.
 * @param {Record<string, any> | null} project - project inspection result.
 * @returns {Promise<Record<string, any>>}
 */
async function runDoctorTests(ctx, exec, config, directory, project) {
  const hasTestScript = project !== null && project.packageJson !== null && project.packageJson.scripts.some((script) => script.name === 'test')
  let hasTestDirectory = false
  const fs = ctx.get('fs')
  if (fs !== undefined) {
    try {
      const target = await fs.resolve('test', { cwd: directory, signal: exec.signal })
      hasTestDirectory = (await fs.stat(target, exec.signal)) !== undefined
    } catch {
      hasTestDirectory = false
    }
  }
  if (!hasTestScript && !hasTestDirectory) return { ran: false, reason: 'no package.json "test" script and no test/ directory' }
  try {
    const result = await runBun(ctx, exec, config, { args: ['test'], cwd: directory, timeoutMs: 120_000 })
    return lossless({
      ran: true,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: result.stdout.text.slice(0, 3_000),
      stderr: result.stderr.text.slice(0, 3_000),
    })
  } catch (error) {
    return lossless({ ran: true, exitCode: null, timedOut: false, durationMs: 0, stdout: '', stderr: errorMessage(error) })
  }
}

/**
 * Build one doctor report: runtime properties, project health, catalog
 * agreement and optionally the project's own test suite. It is the automation
 * primitive a scheduled task can ask the agent to run, and the data source of
 * the dashboard.
 * @param {any} ctx - the plugin context.
 * @param {any} exec - execution context carrying the abort signal.
 * @param {Record<string, any>} config - resolved plugin config.
 * @param {string} directory - project directory.
 * @param {{checks?: string[], runTests?: boolean}} [options] - selected checks.
 * @returns {Promise<Record<string, any>>}
 */
async function buildDoctorReport(ctx, exec, config, directory, options = {}) {
  const wanted = new Set(Array.isArray(options.checks) && options.checks.length > 0 ? options.checks.filter((check) => DOCTOR_CHECKS.includes(check)) : ['runtime', 'project', 'catalog'])
  if (options.runTests === true && !wanted.has('tests')) wanted.add('tests')
  const startedAt = Date.now()
  const checks = []
  const add = (id, title, status, detail) => checks.push({ id, title, status, detail: String(detail).slice(0, 600) })
  let project = null
  let probe = null
  let tests = null

  if (wanted.has('project')) {
    try {
      project = await inspectProject(ctx, exec, directory, config, (cwd) => readRuntimeVersion(ctx, exec, config, cwd))
      add('project.classification', 'Project classification', project.kind === 'bun-native' ? 'pass' : 'warn', `${project.kind} (${project.confidence}) in ${directory}`)
      add(
        'project.lockfile',
        'Lockfile',
        project.lockfile !== null ? 'pass' : 'warn',
        project.lockfile === null
          ? 'no bun.lock/bun.lockb in this directory'
          : `${project.lockfile.file} (${project.lockfile.kind}${project.lockfile.lockfileVersion === undefined ? '' : `, lockfileVersion ${project.lockfile.lockfileVersion}`})`,
      )
      add('project.linker', 'Dependency layout', project.linker.strategy === 'unknown' ? 'warn' : 'pass', `linker ${project.linker.strategy}${project.linker.source === 'none' ? '' : ` (from ${project.linker.source})`}`)
      if (project.workspace !== null) {
        add('project.workspace', 'Workspace', 'pass', project.workspace.role === 'root' ? `root of ${project.workspace.patterns.join(', ')}` : `member ${project.workspace.memberName ?? project.workspace.memberPath} of ${project.workspace.root}`)
      }
      if (project.packageJson !== null) {
        add('project.package', 'package.json', 'pass', `${project.packageJson.scripts.length} scripts, ${project.packageJson.dependencies} dependencies, ${project.packageJson.workspaceDependencies.length} workspace: dependencies`)
      }
    } catch (error) {
      add('project.inspect', 'Project inspection', 'fail', errorMessage(error))
    }
  }

  if (wanted.has('runtime') || wanted.has('catalog')) {
    try {
      probe = await runRuntimeProbe(ctx, exec, config, directory)
    } catch (error) {
      add('runtime.probe', 'Bun properties probe', 'fail', errorMessage(error))
    }
  }

  if (probe !== null && wanted.has('runtime')) {
    add('runtime.version', 'Bun runtime', 'pass', `Bun ${probe.version} on ${probe.platform}/${probe.arch}`)
    const required = ['serve', 'file', 'write', 'spawn', 'shell', 'glob', 'hashing', 'password', 'transpiler', 'build', 'moduleGraph', 'sqlite']
    const missing = required.filter((key) => !probeFeaturePresent(probe.features?.[key]))
    add('runtime.features', 'Bun native properties', missing.length === 0 ? 'pass' : 'fail', missing.length === 0 ? `all ${required.length} probed APIs present` : `missing: ${missing.join(', ')}`)
    if (probe.nodeUrl !== undefined) {
      const nodeUrl = probe.nodeUrl
      const missingNodeUrl = Array.isArray(nodeUrl.missing) ? nodeUrl.missing : []
      const passed = nodeUrl.required === true && missingNodeUrl.length === 0 && nodeUrl.urlSameAsGlobal === true
      add(
        'runtime.node-url',
        'Node.js compatibility: node:url',
        passed ? 'pass' : 'fail',
        nodeUrl.required !== true
          ? 'require("node:url") failed'
          : missingNodeUrl.length > 0
            ? `missing: ${missingNodeUrl.join(', ')}`
            : nodeUrl.urlSameAsGlobal === true
              ? '10 documented functions present; URL/URLSearchParams are the globals'
              : 'URL/URLSearchParams are not the globals',
      )
    }
  }

  if (probe !== null && wanted.has('catalog')) {
    const catalog = loadCatalog()
    const missing = Array.isArray(probe.catalog?.missing) ? probe.catalog.missing : []
    add('catalog.entries', 'Catalog entries exist on this runtime', missing.length === 0 ? 'pass' : 'fail', missing.length === 0 ? `all ${probe.catalog?.checked ?? 0} curated names resolved` : `missing: ${missing.join(', ')}`)
    add('catalog.version', 'Catalog matches the runtime', catalog.bunVersion === probe.version ? 'pass' : 'warn', catalog.bunVersion === probe.version ? `both Bun ${probe.version}` : `catalog ${catalog.bunVersion}, runtime ${probe.version}`)
    const checked = probe.catalog?.checked ?? catalog.apis.length
    const uncovered = probe.catalog?.uncoveredCount ?? 0
    const coverage = checked + uncovered === 0 ? 1 : checked / (checked + uncovered)
    add('catalog.coverage', 'Catalog coverage', coverage >= 0.8 ? 'pass' : 'warn', `${checked} curated, ${uncovered} uncovered (${Math.round(coverage * 100)}%)`)
  }

  if (wanted.has('tests')) {
    tests = await runDoctorTests(ctx, exec, config, directory, project)
    add('tests.bun-test', 'bun:test suite', tests.ran === false ? 'warn' : tests.exitCode === 0 ? 'pass' : 'fail', tests.ran === false ? tests.reason : `bun test exited ${tests.exitCode}${tests.timedOut === true ? ' (timed out)' : ''}`)
  }

  const summary = { pass: 0, warn: 0, fail: 0 }
  for (const check of checks) summary[check.status] += 1
  return lossless({
    directory,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary,
    checks,
    runtime: probe,
    project: project === null ? null : {
      kind: project.kind,
      confidence: project.confidence,
      signals: project.signals,
      lockfile: project.lockfile,
      linker: project.linker,
      workspace: project.workspace,
      packageJson: project.packageJson === null ? null : {
        name: project.packageJson.name,
        version: project.packageJson.version,
        scripts: project.packageJson.scripts.map((script) => script.name),
        workspaceDependencies: project.packageJson.workspaceDependencies,
      },
    },
    tests,
  })
}

/**
 * Pick the directory the dashboard describes: the given directory when it is a
 * Bun project, otherwise the first direct child that carries Bun markers.
 * @param {any} ctx - the plugin context.
 * @param {string} directory - starting directory.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<string>}
 */
async function pickDashboardDirectory(ctx, directory, signal) {
  const fs = ctx.get('fs')
  if (fs === undefined) return directory
  const hasMarker = async (dir) => {
    for (const marker of [MARKER_FILES.lockText, MARKER_FILES.lockBinary, MARKER_FILES.bunfig]) {
      try {
        const info = await fs.stat(await fs.resolve(marker, { cwd: dir, signal }), signal)
        if (info !== undefined) return true
      } catch {
        // An unreadable marker path is not a marker.
      }
    }
    try {
      const packageJson = await readPackageJsonAt(fs, dir, signal)
      const scripts = packageJson?.raw?.scripts
      if (scripts !== null && typeof scripts === 'object' && /(?:^|[\s&|;(])bun(?:x)?(?:\s|$)/.test(Object.values(scripts).map(String).join('\n'))) return true
    } catch {
      // Not a readable package.json.
    }
    return false
  }
  if (await hasMarker(directory)) return directory
  try {
    const entries = await fs.listDir(await fs.resolve(directory, { signal }), signal)
    for (const entry of entries) {
      if (entry.type !== 'directory' || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const child = fs.processPath(entry.target)
      if (await hasMarker(child)) return child
    }
  } catch {
    return directory
  }
  return directory
}

/**
 * Resolve the directory the dashboard describes. An HTTP request carries no
 * Session, so read the workspace of a live Agent first, then the workspace
 * registry, and only then the deployment default.
 * @param {any} ctx - the plugin context.
 * @returns {string}
 */
function dashboardBaseDirectory(ctx) {
  const workingDirectory = ctx.get('workingDirectory')
  const agents = ctx.get('agents')
  if (workingDirectory !== undefined && agents !== undefined) {
    try {
      const live = typeof agents.list === 'function' ? agents.list() : []
      for (const agent of live) {
        try {
          const cwd = workingDirectory.get(agent.session)
          if (typeof cwd === 'string' && cwd.length > 0) return cwd
        } catch {
          // A disposed Agent's Session may already be gone; try the next one.
        }
      }
    } catch {
      // Fall through to the registry.
    }
  }
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list()) {
        if (typeof workspace.path === 'string' && workspace.path.length > 0) return workspace.path
      }
    } catch {
      // Fall through to the deployment default.
    }
  }
  return workingDirectory !== undefined && typeof workingDirectory.defaultDirectory === 'string' ? workingDirectory.defaultDirectory : process.cwd()
}

/**
 * Build the dashboard payload the Client fetches. Cheap checks only: the
 * dashboard must not run a project's test suite on every open.
 * @param {any} ctx - the plugin context.
 * @param {Record<string, any>} config - resolved plugin config.
 * @param {Request} request - the HTTP request (only for its abort signal).
 * @returns {Promise<Record<string, any>>}
 */
async function buildDashboardSnapshot(ctx, config, request) {
  const base = dashboardBaseDirectory(ctx)
  const directory = await pickDashboardDirectory(ctx, base, request.signal)
  const exec = { signal: request.signal, agent: undefined, callId: 'bun-native-dashboard', name: 'bun_native_dashboard', arguments: {} }
  const report = await buildDoctorReport(ctx, exec, config, directory, { checks: ['runtime', 'project', 'catalog'] })
  const catalog = loadCatalog()
  const counts = new Map()
  for (const entry of catalog.apis) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
  return lossless({
    generatedAt: report.generatedAt,
    directory,
    base,
    durationMs: report.durationMs,
    summary: report.summary,
    checks: report.checks,
    runtime: report.runtime === null ? null : {
      version: report.runtime.version,
      platform: report.runtime.platform,
      arch: report.runtime.arch,
      features: report.runtime.features,
      catalog: { checked: report.runtime.catalog?.checked ?? 0, uncoveredCount: report.runtime.catalog?.uncoveredCount ?? 0 },
    },
    project: report.project,
    catalog: {
      bunVersion: catalog.bunVersion,
      total: catalog.apis.length,
      categories: catalog.categories.length,
      categoryList: catalog.categories.map((category) => ({ id: category.id, title: category.title, count: counts.get(category.id) ?? 0 })),
    },
  })
}

/**
 * Render a doctor report as model-facing text.
 * @param {Record<string, any>} value - the tool's result value.
 * @returns {string}
 */
function renderDoctor(value) {
  const label = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }
  const lines = [
    `Bun doctor in ${value.directory}`,
    `Summary: ${value.summary.pass} pass, ${value.summary.warn} warn, ${value.summary.fail} fail (${value.durationMs} ms)`,
    '',
  ]
  for (const check of value.checks) lines.push(`${label[check.status] ?? check.status}  ${check.title} — ${check.detail}`)
  if (value.tests !== null && value.tests.ran === true && value.tests.stdout.trim().length > 0) {
    lines.push('', 'bun test output:', value.tests.stdout.trim().slice(0, 1_500))
  }
  return lines.join('\n')
}

/**
 * Install the tools, the dashboard endpoint and the optional Bun workflow guidance.
 * @param {any} ctx - the plugin context.
 * @param {unknown} rawConfig - the row's config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  const projectTool = {
    name: 'bun_project',
    description: 'Classify a directory as a Bun-native project and report its markers, lockfile, package.json scripts and dependencies, bunfig sections, TypeScript setup and the Bun runtime version. Read-only; call it first in an unfamiliar Bun workspace so later commands match the project toolchain.',
    parameters: {
      path: {
        type: 'string',
        description: 'Directory to inspect. Defaults to the session working directory; a relative path is resolved against it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'directory',
          'kind',
          'confidence',
          'signals',
          'markers',
          'runtime',
          'lockfile',
          'otherLockfiles',
          'workspace',
          'bunfig',
          'typescript',
          'nodeModules',
          'isolatedStore',
          'packageJson',
          'recommended',
          'notes',
          'configuredBunPath',
        ],
        properties: {
          directory: { type: 'string' },
          kind: { type: 'string' },
          confidence: { type: 'string' },
          signals: { type: 'array', items: { type: 'string' } },
          markers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'type'],
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
              },
            },
          },
          runtime: { type: 'object' },
          lockfile: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['file', 'kind', 'bytes'],
                properties: {
                  file: { type: 'string' },
                  kind: { type: 'string' },
                  bytes: { type: 'integer' },
                  lockfileVersion: { type: 'integer' },
                  configVersion: { type: 'integer' },
                },
              },
            ],
          },
          otherLockfiles: { type: 'array', items: { type: 'string' } },
          workspace: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['role', 'root', 'patterns'],
                properties: {
                  role: { type: 'string' },
                  root: { type: 'string' },
                  patterns: { type: 'array', items: { type: 'string' } },
                  memberPath: { type: 'string' },
                  memberName: { type: 'string' },
                  rootLockfile: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['file', 'kind', 'bytes'],
                    properties: {
                      file: { type: 'string' },
                      kind: { type: 'string' },
                      bytes: { type: 'integer' },
                      lockfileVersion: { type: 'integer' },
                      configVersion: { type: 'integer' },
                    },
                  },
                  catalog: { type: 'array', items: { type: 'string' } },
                  catalogs: { type: 'array', items: { type: 'string' } },
                },
              },
            ],
          },
          bunfig: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['file', 'sections'],
                properties: {
                  file: { type: 'string' },
                  sections: { type: 'array', items: { type: 'string' } },
                },
              },
            ],
          },
          typescript: {
            type: 'object',
            additionalProperties: false,
            required: ['present', 'bunTypes'],
            properties: {
              present: { type: 'boolean' },
              bunTypes: { type: 'boolean' },
            },
          },
          nodeModules: { type: 'boolean' },
          isolatedStore: { type: 'boolean' },
          linker: {
            type: 'object',
            additionalProperties: false,
            required: ['strategy', 'source'],
            properties: {
              strategy: { type: 'string' },
              source: { type: 'string' },
            },
          },
          packageJson: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['dependencies', 'devDependencies', 'workspaceDependencies', 'scripts', 'workspaces'],
                properties: {
                  name: { type: 'string' },
                  version: { type: 'string' },
                  packageManager: { type: 'string' },
                  dependencies: { type: 'integer' },
                  devDependencies: { type: 'integer' },
                  workspaceDependencies: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['name', 'range', 'group'],
                      properties: {
                        name: { type: 'string' },
                        range: { type: 'string' },
                        group: { type: 'string' },
                      },
                    },
                  },
                  scripts: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['name', 'command'],
                      properties: {
                        name: { type: 'string' },
                        command: { type: 'string' },
                      },
                    },
                  },
                  workspaces: { type: 'array', items: { type: 'string' } },
                },
              },
            ],
          },
          recommended: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'command'],
              properties: {
                label: { type: 'string' },
                command: { type: 'string' },
              },
            },
          },
          notes: { type: 'array', items: { type: 'string' } },
          configuredBunPath: { type: 'string' },
        },
      },
      render: (_args, value) => textBlocks(renderProject(value)),
      presentationMeta: (_args, value) => ({ directory: value.directory }),
    },
    async execute(args, exec) {
      const base = await sessionCwd(ctx, exec)
      const directory = resolveDirectory(base, typeof args.path === 'string' ? args.path : undefined)
      return await inspectProject(ctx, exec, directory, config, (cwd) => readRuntimeVersion(ctx, exec, config, cwd))
    },
    presentCall: (args) => ({
      card: 'generic',
      title: typeof args === 'object' && args !== null && typeof args.path === 'string' ? `Bun project ${args.path}` : 'Inspect Bun project',
      kind: 'read',
    }),
    presentResult: (_args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      return { card: 'generic', content: textBlocks(`\`\`\`text\n${block.text.replace(/\n+$/, '')}\n\`\`\``) }
    },
    isConcurrencySafe: () => true,
  }

  const apiTool = {
    name: 'bun_api',
    description: 'Look up the Bun runtime global API surface from a bundled offline digest of https://bun.com/reference/globals/bun. Use it before writing Bun-specific code: pass `name` for one API with its signature and example, `query` to search, or nothing to list categories. For guides, blog posts and full pages beyond this digest, use the Bun docs MCP tools (`mcp__bun_docs__search_bun`, `read_bun_page`, `grep_bun`, `list_bun_pages`) when they are available. Prefer these built-ins over new dependencies in Bun-native projects.',
    parameters: {
      name: {
        type: 'string',
        description: 'Exact API name to describe, such as "Bun.serve", "Bun.file" or "Bun.$".',
      },
      query: {
        type: 'string',
        description: 'Free-text search over names, summaries, signatures and categories.',
      },
      category: {
        type: 'string',
        description: 'Restrict results to one category id, such as "networking", "files", "shell" or "sql".',
      },
      limit: {
        type: 'number',
        description: 'Maximum entries to return; 1-50, default 8.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['total', 'returned', 'categories', 'entries'],
        properties: {
          bunVersion: { type: 'string' },
          referenceUrl: { type: 'string' },
          runtimeVersion: { type: 'string' },
          warning: { type: 'string' },
          total: { type: 'integer' },
          returned: { type: 'integer' },
          categories: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title', 'summary', 'count'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
                count: { type: 'integer' },
              },
            },
          },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'category', 'kind', 'summary', 'signature', 'runtime'],
              properties: {
                name: { type: 'string' },
                category: { type: 'string' },
                kind: { type: 'string' },
                summary: { type: 'string' },
                signature: { type: 'string' },
                runtime: { type: 'string' },
                docsUrl: { type: 'string' },
                example: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => textBlocks(renderApi(value)),
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const catalog = loadCatalog()
      const requestedName = typeof args.name === 'string' ? args.name.trim() : ''
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const category = typeof args.category === 'string' && args.category.trim().length > 0 ? args.category.trim() : undefined
      const limit = args.limit === undefined ? 8 : Math.max(1, Math.min(50, Math.trunc(args.limit)))
      const counts = new Map()
      for (const entry of catalog.apis) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
      const categories = catalog.categories.map((entry) => ({ ...entry, count: counts.get(entry.id) ?? 0 }))

      // The digest is pinned to one Bun release; warn instead of returning
      // stale signatures with full confidence after a runtime upgrade.
      let runtimeVersion
      let warning
      if (ctx.get('subprocess') !== undefined) {
        try {
          const cwd = await sessionCwd(ctx, exec)
          const runtime = await readRuntimeVersion(ctx, exec, config, cwd)
          if (typeof runtime.version === 'string') {
            runtimeVersion = runtime.version
            if (catalog.bunVersion !== undefined && runtimeVersion !== catalog.bunVersion) {
              warning = `The bundled catalog is pinned to Bun ${catalog.bunVersion} but this workspace runs Bun ${runtimeVersion}; signatures may be stale. Run bun_doctor, or regenerate data/bun-globals.json after the upgrade.`
            }
          }
        } catch {
          // The runtime probe is optional for a catalog lookup.
        }
      }

      let entries
      if (requestedName.length > 0) {
        const exact = catalog.apis.find((entry) => String(entry.name).toLowerCase() === requestedName.toLowerCase())
        entries = exact === undefined ? rankApis(catalog.apis, requestedName, category).slice(0, limit).map((entry) => projectApi(entry, false)) : [projectApi(exact, true)]
      } else if (query.length === 0 && category === undefined) {
        entries = []
      } else {
        entries = rankApis(catalog.apis, query, category).slice(0, limit).map((entry) => projectApi(entry, false))
      }

      return lossless({
        ...(catalog.bunVersion === undefined ? {} : { bunVersion: catalog.bunVersion }),
        ...(catalog.referenceUrl === undefined ? {} : { referenceUrl: catalog.referenceUrl }),
        ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
        ...(warning === undefined ? {} : { warning }),
        total: catalog.apis.length,
        returned: entries.length,
        categories,
        entries,
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Bun globals catalog', kind: 'fetch' }),
    presentResult: (_args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      return { card: 'generic', content: textBlocks(`\`\`\`text\n${block.text.replace(/\n+$/, '')}\n\`\`\``) }
    },
    isConcurrencySafe: () => true,
  }

  const execTool = {
    name: 'bun_exec',
    description: 'Run Bun in the session workspace under the active sandbox policy: `run` executes a package.json script or a file, `test` runs `bun test`, `install` runs `bun install`, `add` installs a package spec, `ci` runs `bun ci` (frozen-lockfile install for CI), `check` runs the built-in `bun check` type checker (use `args` for `--no-script`, `-p <project>`, `-b`, compiler flags), `lint` runs `bun lint` (use `args` for `--explain <rule>`, `--rules`, `--fix`, `--type-aware`, etc.; the built-in linter is version-gated), `pm` runs a `bun pm` package-manager utility, and `eval` runs inline code with `bun --eval`. `filter` targets workspace members using Bun\'s real syntax (`bun --filter <pattern> <script>`, `bun install --filter <pattern>`); for `add` use `cwd`, because Bun has no filter flag for it. Non-zero exits are reported in the result, not as a failed call. Prefer `bun_project` first to learn the project\'s scripts, lockfile, workspace root and linker.',
    parameters: {
      mode: {
        type: 'string',
        enum: EXEC_MODES,
        required: true,
        description: 'What to run: "run" a script or file, "test" the bun:test suite, "install" dependencies, "add" a package, "ci" a frozen-lockfile install, "check" the built-in type checker, "lint" the built-in linter when available, "pm" a package-manager utility, or "eval" inline code.',
      },
      target: {
        type: 'string',
        description: 'For "run": script name or file path. For "test": optional test file or filter. For "add": the package spec, such as "zod@^3". For "check": optional file or directory to type check. For "lint": optional file, directory or glob. For "install" and "pm": unused.',
      },
      code: {
        type: 'string',
        description: 'Inline JavaScript/TypeScript for "eval" mode, executed with bun --eval.',
      },
      filter: {
        type: 'string',
        description: 'Target workspace members for modes "run" (bun --filter <pattern> <script>), "test" (runs the "test" script in matching members) and "install" (bun install --filter <pattern>). Rejected for other modes.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra arguments appended after the mode\'s own arguments. For "pm", the utility and its flags, such as ["ls", "--all"]; for "lint", flags such as ["--explain", "prefer-const"] or ["--fix"]; for "check", flags such as ["--no-script"], ["-p", "packages/server"] or ["-b"].',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Defaults to the session working directory; a relative path is resolved against it.',
      },
      timeoutMs: {
        type: 'number',
        description: `Timeout in milliseconds; defaults to the plugin\'s configured ${DEFAULTS.timeoutMs} and is clamped to 600000. On expiry the process is terminated and the result is marked timed out.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'cwd', 'exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs', 'durationMs', 'stdout', 'stderr'],
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          aborted: { type: 'boolean' },
          timeoutMs: { type: 'number' },
          durationMs: { type: 'number' },
          stdout: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'truncated'],
            properties: {
              text: { type: 'string' },
              truncated: { type: 'boolean' },
              spillPath: { type: 'string' },
            },
          },
          stderr: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'truncated'],
            properties: {
              text: { type: 'string' },
              truncated: { type: 'boolean' },
              spillPath: { type: 'string' },
            },
          },
          sandbox: {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'denied'],
            properties: {
              mode: { type: 'string' },
              enforcement: { type: 'string' },
              denied: { type: 'boolean' },
            },
          },
        },
      },
      render: (_args, value) => textBlocks(renderExec(value)),
      presentationMeta: (_args, value) => ({ cwd: value.cwd }),
    },
    async execute(args, exec) {
      const mode = args.mode
      if (!EXEC_MODES.includes(mode)) throw new Error(`bun_exec mode must be one of: ${EXEC_MODES.join(', ')}`)
      const extra = Array.isArray(args.args) ? args.args.map((item) => String(item)) : []
      const target = typeof args.target === 'string' && args.target.trim().length > 0 ? args.target.trim() : undefined
      const code = typeof args.code === 'string' ? args.code : undefined
      const filter = typeof args.filter === 'string' && args.filter.trim().length > 0 ? args.filter.trim() : undefined
      const filterModes = ['run', 'test', 'install']
      if (filter !== undefined && !filterModes.includes(mode)) throw new Error(`bun_exec \`filter\` works with ${filterModes.map((item) => `"${item}"`).join(', ')} only; for "add", target a workspace member with \`cwd\` (bun add --cwd <dir>)`)
      const runArgs = []
      if (mode === 'run') {
        if (target === undefined) throw new Error('bun_exec mode "run" requires a `target` (a package.json script name or a file path)')
        if (filter === undefined) runArgs.push('run', target, ...extra)
        else runArgs.push('--filter', filter, target, ...extra)
      } else if (mode === 'test') {
        if (filter === undefined) {
          runArgs.push('test')
          if (target !== undefined) runArgs.push(target)
          runArgs.push(...extra)
        } else {
          runArgs.push('--filter', filter, 'test', ...extra)
        }
      } else if (mode === 'install') {
        runArgs.push('install', ...(filter === undefined ? [] : ['--filter', filter]), ...extra)
      } else if (mode === 'add') {
        if (target === undefined) throw new Error('bun_exec mode "add" requires a `target` package spec, for example "zod@^3"')
        runArgs.push('add', target, ...extra)
      } else if (mode === 'ci') {
        runArgs.push('ci', ...extra)
      } else if (mode === 'check') {
        runArgs.push('check', ...(target === undefined ? [] : [target]), ...extra)
      } else if (mode === 'lint') {
        runArgs.push('lint', ...(target === undefined ? [] : [target]), ...extra)
      } else if (mode === 'pm') {
        if (extra.length === 0) throw new Error('bun_exec mode "pm" requires `args` naming a bun pm command, for example ["ls", "--all"]')
        runArgs.push('pm', ...extra)
      } else {
        if (code === undefined || code.trim().length === 0) throw new Error('bun_exec mode "eval" requires `code`')
        runArgs.push('--eval', code, ...extra)
      }
      const base = await sessionCwd(ctx, exec)
      const cwd = resolveDirectory(base, typeof args.cwd === 'string' ? args.cwd : undefined)
      const requestedTimeout = args.timeoutMs === undefined ? config.timeoutMs : Math.max(1_000, Math.min(600_000, Math.trunc(args.timeoutMs)))
      return await runBun(ctx, exec, config, { args: runArgs, cwd, timeoutMs: requestedTimeout })
    },
    presentCall: (args) => {
      const mode = typeof args === 'object' && args !== null && typeof args.mode === 'string' ? args.mode : 'run'
      const target = typeof args === 'object' && args !== null && typeof args.target === 'string' ? args.target : undefined
      const code = typeof args === 'object' && args !== null && typeof args.code === 'string' ? args.code : undefined
      const pmArgs = typeof args === 'object' && args !== null && Array.isArray(args.args) ? args.args.join(' ') : ''
      const subject = mode === 'eval' ? (code ?? '').split('\n')[0].slice(0, 80) : mode === 'pm' ? pmArgs : mode === 'lint' || mode === 'check' ? [target, pmArgs].filter((part) => part !== undefined && part.length > 0).join(' ') : target
      return {
        card: 'terminal',
        title: `bun ${mode}${subject !== undefined && subject.length > 0 ? ` ${subject}` : ''}`,
        ...(typeof args === 'object' && args !== null && typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
      }
    },
    presentResult: (_args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const value = result.value !== undefined && result.value !== null && typeof result.value === 'object' ? result.value : {}
      return {
        card: 'terminal',
        output: block.text.replace(/\s+$/, ''),
        ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
        ...(typeof value.signal === 'string' ? { signal: value.signal } : {}),
      }
    },
    isConcurrencySafe: () => false,
  }

  const doctorTool = {
    name: 'bun_doctor',
    description: 'Test the Bun-native properties of a project and return a health report: a probe executed inside the project\'s Bun (version, platform, which native APIs exist), project checks (classification, lockfile, workspace root/member, linker, package manifest), catalog agreement (every curated API name resolves on this runtime, plus coverage), and optionally the project\'s own bun:test suite. Use it as the automation task for scheduled health checks; it reports failures instead of throwing unless the probe itself cannot run.',
    parameters: {
      path: {
        type: 'string',
        description: 'Project directory to diagnose. Defaults to the session working directory; a relative path is resolved against it.',
      },
      checks: {
        type: 'array',
        items: { type: 'string', enum: DOCTOR_CHECKS },
        description: 'Which checks to run: "runtime" (Bun properties probe), "project" (classification, lockfile, workspace, linker), "catalog" (curated API names resolve here), "tests" (run bun test). Defaults to runtime, project and catalog.',
      },
      runTests: {
        type: 'boolean',
        description: 'Add the "tests" check: run the project\'s bun test suite (up to 120 seconds) and report its exit status.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Defaults to the session working directory; a relative path is resolved against it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['directory', 'generatedAt', 'durationMs', 'summary', 'checks', 'runtime', 'project', 'tests'],
        properties: {
          directory: { type: 'string' },
          generatedAt: { type: 'string' },
          durationMs: { type: 'number' },
          summary: {
            type: 'object',
            additionalProperties: false,
            required: ['pass', 'warn', 'fail'],
            properties: {
              pass: { type: 'integer' },
              warn: { type: 'integer' },
              fail: { type: 'integer' },
            },
          },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title', 'status', 'detail'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
          runtime: { oneOf: [{ type: 'null' }, { type: 'object' }] },
          project: { oneOf: [{ type: 'null' }, { type: 'object' }] },
          tests: { oneOf: [{ type: 'null' }, { type: 'object' }] },
        },
      },
      render: (_args, value) => textBlocks(renderDoctor(value)),
    },
    async execute(args, exec) {
      const base = await sessionCwd(ctx, exec)
      const requested = typeof args.cwd === 'string' ? args.cwd : typeof args.path === 'string' ? args.path : undefined
      const directory = resolveDirectory(base, requested)
      const checks = Array.isArray(args.checks) ? args.checks.map((check) => String(check)) : undefined
      return await buildDoctorReport(ctx, exec, config, directory, { checks, runTests: args.runTests === true })
    },
    presentCall: () => ({ card: 'generic', title: 'Bun doctor', kind: 'execute' }),
    presentResult: (_args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      return { card: 'generic', content: textBlocks(`\`\`\`text\n${block.text.replace(/\n+$/, '')}\n\`\`\``) }
    },
    isConcurrencySafe: () => false,
  }

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(projectTool),
      ctx.tools.register(apiTool),
      ctx.tools.register(execTool),
      ctx.tools.register(doctorTool),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  // Dashboard endpoint: the Client page fetches this same walk the tools take.
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/bun-native/status',
      resource: async (request, peer) => {
        if (peer !== undefined && (peer.principal === undefined || peer.principal.kind !== 'owner')) {
          return Response.json({ error: 'forbidden' }, { status: 403 })
        }
        try {
          return Response.json(await buildDashboardSnapshot(ctx, config, request), { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 500 })
        }
      },
    }))
  }

  if (config.promptGuidance) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      ctx.effect(() => systemPrompt.section({
        name: 'bun-native',
        order: 500,
        text: [
          '## Bun-native workflow',
          'Call `bun_project` before assuming a toolchain: Bun-native projects commit `bun.lock` (or `bunfig.toml`), and their scripts run through Bun.',
          'In a Bun-native project use `bun_exec` for scripts, tests and installs, and call `bun_api` before using a Bun-specific global (`Bun.serve`, `Bun.file`, `Bun.$`, `bun:sqlite`, `bun:test`).',
          'If the Bun docs MCP tools are available (`mcp__bun_docs__search_bun`, `read_bun_page`, `grep_bun`, `list_bun_pages`), use them for guides, blog posts and full pages beyond `bun_api`\'s offline digest; read the `bun://skill` resource when starting a Bun task.',
          'Prefer those built-in Bun APIs over new dependencies; do not introduce npm, yarn or pnpm there.',
        ].join('\n'),
      }))
    }
  }
}

export {
  buildDashboardSnapshot,
  buildDoctorReport,
  bunfigSections,
  describeLockfile,
  findWorkspaceRoot,
  inspectProject,
  loadCatalog,
  matchesWorkspacePatterns,
  rankApis,
  readBunfigLinker,
  readWorkspaceDependencies,
  readWorkspaces,
  resolveConfig,
  runRuntimeProbe,
}
