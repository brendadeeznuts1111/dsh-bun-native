/**
 * Bun-native property and plugin-behaviour tests, run with `bun test`.
 *
 * Two layers:
 *  - pure helpers and the bundled catalog, checked against the running Bun;
 *  - the Host tools' core functions with a stub Cordis context and filesystem,
 *    so no Harness services are needed.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const workspaceDemo = resolve(pluginDir, 'examples', 'bun-demo')
const bunWorkspace = resolve(pluginDir, 'examples', 'bun-workspace')

const config = plugin.resolveConfig({})

/** Minimal fs service over the real filesystem, matching the Host service shape. */
const fsService = {
  async resolve(path, options = {}) {
    return isAbsolute(path) ? path : resolve(options.cwd ?? process.cwd(), path)
  },
  async stat(path) {
    try {
      const stats = statSync(path)
      return { version: 'v1', type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other', size: stats.size }
    } catch {
      return undefined
    }
  },
  async readText(path) {
    return readFileSync(path, 'utf8')
  },
  async listDir(path) {
    const { readdirSync } = await import('node:fs')
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      target: join(path, entry.name),
    }))
  },
  processPath(path) {
    return path
  },
}

/**
 * Fake subprocess service: answers `bun --version`, the properties probe and
 * `bun test` from canned output so the Host tools run without spawning Bun.
 */
function makeSubprocess({ probe = {}, testResult = { exitCode: 0, stdout: '1 pass\n', stderr: '' }, version = '1.4.4' } = {}) {
  const calls = []
  return {
    calls,
    async resolveExecutable(command) {
      return command
    },
    spawn(spec) {
      calls.push(spec)
      const argv = spec.argv.join(' ')
      let stdout = ''
      let stderr = ''
      let exitCode = 0
      if (argv.includes('--print') || argv.includes('--version')) {
        stdout = `${version}\n`
      } else if (argv.includes('--eval')) {
        stdout = `__BUN_NATIVE_PROBE__${JSON.stringify({
          version: '1.4.4',
          revision: 'test',
          platform: 'win32',
          arch: 'x64',
          features: {
            serve: 'function', file: 'function', write: 'function', spawn: 'function', shell: 'function',
            glob: 'function', hashing: 'function', password: 'function', transpiler: 'function',
            build: 'function', moduleGraph: 'function', sqlite: 'module',
            ...probe,
          },
          catalog: { checked: 69, missing: [], uncoveredCount: 48, uncovered: ['Cookie'] },
          nodeUrl: { required: true, missing: [], urlSameAsGlobal: true },
        })}\n`
      } else if (argv.includes('test')) {
        stdout = testResult.stdout
        stderr = testResult.stderr
        exitCode = testResult.exitCode
      }
      const reader = (text) => ({ readFrom: (from) => ({ text: from === 0 ? text : '', nextOffset: text.length, lossy: false }) })
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: { stdout: reader(stdout), stderr: reader(stderr) },
        done: Promise.resolve({ exitCode, signal: null }),
        terminate() {},
        waitForExit: async () => true,
      }
    },
  }
}

function makeContext(services) {
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(callback) {
      const dispose = callback()
      return () => dispose?.()
    },
    get(service) {
      return services[service]
    },
  }
  return { ctx, tools }
}

function makeExec(signal = new AbortController().signal) {
  return { signal, agent: undefined, callId: 'test-call', name: 'test', arguments: {} }
}

describe('configuration and helpers', () => {
  test('resolveConfig applies defaults and rejects out-of-range values', () => {
    expect(config).toEqual({ bunPath: 'bun', timeoutMs: 60_000, maxOutputChars: 20_000, promptGuidance: true })
    expect(() => plugin.resolveConfig({ timeoutMs: 10 })).toThrow(/between 1000 and 600000/)
    expect(() => plugin.resolveConfig({ promptGuidance: 'yes' })).toThrow(/boolean/)
  })

  test('readWorkspaces accepts both documented shapes', () => {
    expect(plugin.readWorkspaces(['packages/*', 'apps/*', 7])).toEqual(['packages/*', 'apps/*'])
    expect(plugin.readWorkspaces({ packages: ['services/*'] })).toEqual(['services/*'])
    expect(plugin.readWorkspaces(undefined)).toEqual([])
  })

  test('bunfig helpers read sections and the linker', () => {
    const text = '[install]\nexact = true\nlinker = "isolated"\n\n[test]\ncoverage = false\n'
    expect(plugin.bunfigSections(text)).toEqual(['install', 'test'])
    expect(plugin.readBunfigLinker(text)).toBe('isolated')
    expect(plugin.readBunfigLinker('[test]\ncoverage = false\n')).toBeUndefined()
  })

  test('readWorkspaceDependencies lists workspace: protocol entries by group', () => {
    const dependencies = plugin.readWorkspaceDependencies({
      dependencies: { greeting: 'workspace:*' },
      devDependencies: { types: 'workspace:^' },
      peerDependencies: { react: '^19.0.0' },
    })
    expect(dependencies).toEqual([
      { name: 'greeting', range: 'workspace:*', group: 'dependencies' },
      { name: 'types', range: 'workspace:^', group: 'devDependencies' },
    ])
  })

  test('rankApis prefers exact names, then prefixes, then the rest', () => {
    const apis = [
      { name: 'Bun.serve', category: 'networking', summary: 'http server' },
      { name: 'Bun.serverTime', category: 'runtime', summary: 'time' },
      { name: 'Bun.file', category: 'files', summary: 'serve a file' },
    ]
    expect(plugin.rankApis(apis, 'bun.serve', undefined).map((entry) => entry.name)).toEqual(['Bun.serve', 'Bun.serverTime'])
    expect(plugin.rankApis(apis, 'bun.serv', undefined).map((entry) => entry.name)).toEqual(['Bun.serve', 'Bun.serverTime'])
    expect(plugin.rankApis(apis, 'serve', undefined)[0].name).toBe('Bun.serve')
    expect(plugin.rankApis(apis, 'file', 'files').map((entry) => entry.name)).toEqual(['Bun.file'])
  })
})

describe('detection confidence rules', () => {
  test('workspace glob patterns match members and reject non-members', () => {
    expect(plugin.matchesWorkspacePatterns('apps/web', ['packages/*', 'apps/*'])).toBe(true)
    expect(plugin.matchesWorkspacePatterns('nested/thing', ['packages/*'])).toBe(false)
    expect(plugin.matchesWorkspacePatterns('packages/deep/lib', ['packages/**'])).toBe(true)
    expect(plugin.matchesWorkspacePatterns('packages/legacy', ['packages/*', '!packages/legacy'])).toBe(false)
  })

  test('a foreign lockfile next to bun.lock lowers confidence and is signalled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bun-native-mixed-'))
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mixed', scripts: { start: 'bun src/index.ts' } }))
      writeFileSync(join(root, 'bun.lock'), JSON.stringify({ lockfileVersion: 2, configVersion: 1, workspaces: {}, packages: {} }))
      writeFileSync(join(root, 'package-lock.json'), '{}')
      const { ctx } = makeContext({ fs: fsService })
      const project = await plugin.inspectProject(ctx, makeExec(), root, config, async () => ({ version: '1.4.4' }))
      expect(project.kind).toBe('bun-native')
      expect(project.confidence).toBe('medium')
      expect(project.signals).toContain('mixed-lockfiles')
      expect(project.notes.join('\n')).toContain('Mixed package-manager repo')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a directory not matched by the workspace globs is not reported as a member', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bun-native-glob-'))
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }))
      writeFileSync(join(root, 'bun.lock'), JSON.stringify({ lockfileVersion: 2, configVersion: 1, workspaces: {}, packages: {} }))
      mkdirSync(join(root, 'apps', 'web'), { recursive: true })
      writeFileSync(join(root, 'apps', 'web', 'package.json'), JSON.stringify({ name: 'web' }))
      const { ctx } = makeContext({ fs: fsService })
      const project = await plugin.inspectProject(ctx, makeExec(), join(root, 'apps', 'web'), config, async () => ({ version: '1.4.4' }))
      expect(project.workspace).toBeNull()
      expect(project.notes.join('\n')).toContain('not matched by those globs')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the ancestor search cap is reported instead of silently missing a root', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bun-native-cap-'))
    try {
      const shallow = join(base, 'project')
      mkdirSync(shallow, { recursive: true })
      writeFileSync(join(shallow, 'package.json'), JSON.stringify({ name: 'shallow' }))
      let deep = shallow
      for (let index = 0; index < 7; index += 1) {
        deep = join(deep, `level${index}`)
        mkdirSync(deep, { recursive: true })
      }
      const { ctx } = makeContext({ fs: fsService })
      const project = await plugin.inspectProject(ctx, makeExec(), deep, config, async () => ({ version: '1.4.4' }))
      expect(project.notes.join('\n')).toContain('Workspace root not found within 8 ancestor directories')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('bundled catalog', () => {
  const catalog = plugin.loadCatalog()

  test('records the catalog version, categories and unique APIs', () => {
    expect(catalog.bunVersion).toBe(Bun.version)
    expect(catalog.apis.length).toBeGreaterThanOrEqual(70)
    expect(new Set(catalog.categories.map((category) => category.id)).size).toBe(catalog.categories.length)
    expect(new Set(catalog.apis.map((entry) => entry.name)).size).toBe(catalog.apis.length)
  })

  test('every Bun.* name exists on the running Bun runtime', () => {
    const missing = catalog.apis
      .map((entry) => /^Bun\.([A-Za-z_$][\w$]*)$/u.exec(entry.name)?.[1])
      .filter((name) => name !== undefined)
      .filter((name) => !(name in Bun))
    expect(missing).toEqual([])
  })

  test('every example transpiles as TypeScript', () => {
    const transpiler = new Bun.Transpiler({ loader: 'ts' })
    const broken = catalog.apis.filter((entry) => {
      try {
        transpiler.transformSync(entry.example)
        return false
      } catch {
        return true
      }
    })
    expect(broken).toEqual([])
  })

  test('documents Bun.ModuleGraph with the verified surface', () => {
    const moduleGraph = catalog.apis.find((entry) => entry.name === 'Bun.ModuleGraph')
    expect(moduleGraph).toBeDefined()
    expect(moduleGraph.kind).toBe('class')
    expect(moduleGraph.signature).toContain('dispose(): void')
    expect(moduleGraph.signature).toContain('uncaughtException')
    expect(moduleGraph.signature).toContain('unhandledRejection')
    expect(typeof Bun.ModuleGraph).toBe('function')
  })
})

describe('project inspection', () => {
  test('classifies the demo project and its properties', async () => {
    const { ctx } = makeContext({ fs: fsService })
    const project = await plugin.inspectProject(ctx, makeExec(), workspaceDemo, config, async () => ({ version: '1.4.4' }))
    expect(project.kind).toBe('bun-native')
    expect(project.confidence).toBe('strong')
    expect(project.signals).toContain('bunfig.toml')
    expect(project.bunfig.sections).toContain('install')
    expect(project.packageJson.scripts.map((script) => script.name)).toContain('test')
    // The demo lives under the workspace root, so the linker comes from the
    // root install (isolated here); an uninstalled checkout reports "unknown".
    expect(['isolated', 'hoisted', 'unknown']).toContain(project.linker.strategy)
  })

  test('resolves the workspace root from a member directory', async () => {
    const { ctx } = makeContext({ fs: fsService })
    const root = await plugin.inspectProject(ctx, makeExec(), bunWorkspace, config, async () => ({ version: '1.4.4' }))
    expect(root.workspace.role).toBe('root')
    expect(root.workspace.patterns).toEqual(['packages/*', 'apps/*'])

    const member = await plugin.inspectProject(ctx, makeExec(), join(bunWorkspace, 'apps', 'web'), config, async () => ({ version: '1.4.4' }))
    expect(member.kind).toBe('bun-native')
    expect(member.workspace.role).toBe('member')
    expect(member.workspace.memberName).toBe('web')
    expect(member.workspace.memberPath).toBe('apps/web')
    expect(member.lockfile).toBeNull()
    expect(member.workspace.rootLockfile.lockfileVersion).toBe(2)
    expect(member.packageJson.workspaceDependencies).toEqual([{ name: 'greeting', range: 'workspace:*', group: 'dependencies' }])
  })
})

describe('bun_doctor and dashboard data', () => {
  test('builds a passing report from the properties probe', async () => {
    const subprocess = makeSubprocess()
    const { ctx } = makeContext({ fs: fsService, subprocess })
    const report = await plugin.buildDoctorReport(ctx, makeExec(), config, bunWorkspace, { checks: ['runtime', 'project', 'catalog'] })
    expect(report.summary.fail).toBe(0)
    expect(report.runtime.version).toBe('1.4.4')
    expect(report.checks.find((check) => check.id === 'runtime.features').status).toBe('pass')
    expect(report.checks.find((check) => check.id === 'runtime.node-url').status).toBe('pass')
    expect(report.checks.find((check) => check.id === 'catalog.entries').status).toBe('pass')
    expect(report.tests).toBeNull()
  })

  test('reports missing native properties as a failure', async () => {
    const subprocess = makeSubprocess({ probe: { moduleGraph: 'missing', sqlite: 'missing' } })
    const { ctx } = makeContext({ fs: fsService, subprocess })
    const report = await plugin.buildDoctorReport(ctx, makeExec(), config, bunWorkspace, { checks: ['runtime'] })
    expect(report.summary.fail).toBe(1)
    expect(report.checks.find((check) => check.id === 'runtime.features').detail).toContain('moduleGraph')
  })

  test('runs the project bun:test suite when asked', async () => {
    const subprocess = makeSubprocess({ testResult: { exitCode: 1, stdout: '1 fail\n', stderr: '' } })
    const { ctx } = makeContext({ fs: fsService, subprocess })
    const report = await plugin.buildDoctorReport(ctx, makeExec(), config, bunWorkspace, { checks: ['project', 'tests'] })
    expect(report.tests.ran).toBe(true)
    expect(report.tests.exitCode).toBe(1)
    expect(report.checks.find((check) => check.id === 'tests.bun-test').status).toBe('fail')
  })

  test('dashboard snapshot picks the Bun project below the workspace root', async () => {
    const subprocess = makeSubprocess()
    const { ctx } = makeContext({
      fs: fsService,
      subprocess,
      workingDirectory: { defaultDirectory: resolve(pluginDir, 'examples') },
    })
    const snapshot = await plugin.buildDashboardSnapshot(ctx, config, new Request('http://127.0.0.1/api/bun-native/status'))
    expect(snapshot.base).toBe(resolve(pluginDir, 'examples'))
    expect(snapshot.project.kind).toBe('bun-native')
    expect(snapshot.catalog.total).toBeGreaterThanOrEqual(70)
    expect(snapshot.summary.fail).toBe(0)
  })
})

describe('catalog version drift', () => {
  test('bun_api warns when the runtime differs from the catalog pin', async () => {
    const subprocess = makeSubprocess({ version: '1.3.0' })
    const { ctx, tools } = makeContext({ fs: fsService, subprocess, workingDirectory: { defaultDirectory: pluginDir } })
    plugin.apply(ctx, { bunPath: 'bun-version-drift' })
    const value = await tools.get('bun_api').execute({ name: 'Bun.serve' }, makeExec())
    expect(value.runtimeVersion).toBe('1.3.0')
    expect(value.warning).toContain('pinned to Bun 1.4.4')
    expect(tools.get('bun_api').output.render({}, value)[0].text).toContain('⚠')
  })
})

describe('tool registration', () => {
  test('apply registers four tools, a prompt section and the status route', () => {
    const routes = []
    const sections = []
    const subprocess = makeSubprocess()
    const services = {
      fs: fsService,
      subprocess,
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
      systemPrompt: {
        section(section) {
          sections.push(section)
          return () => {}
        },
      },
    }
    const { ctx, tools } = makeContext(services)
    plugin.apply(ctx, {})
    expect([...tools.keys()].sort()).toEqual(['bun_api', 'bun_doctor', 'bun_exec', 'bun_project'])
    expect(sections.map((section) => section.name)).toEqual(['bun-native'])
    expect(routes.map((route) => route.path)).toEqual(['/api/bun-native/status'])
  })
})
