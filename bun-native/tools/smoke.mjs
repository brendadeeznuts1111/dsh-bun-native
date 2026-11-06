/**
 * Pre-install smoke test for the @local/bun-native Host plugin.
 *
 * Runs `apply()` against a stub Cordis context (real fs reads, faked
 * subprocess/sandbox services), then exercises the three tools' `execute`
 * and `render` callbacks. This catches registration and logic defects before
 * the bundle is installed into the profile.
 *
 * Usage: bun bun-native/tools/smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolvePath(here, '..')
const demoDir = resolvePath(pluginDir, 'examples', 'bun-demo')

/** Minimal fs service over the real filesystem, matching the Host fd shape we use. */
const fsService = {
  async resolve(path, options = {}) {
    return isAbsolute(path) ? path : resolvePath(options.cwd ?? process.cwd(), path)
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
  processPath(path) {
    return path
  },
}

/**
 * Fake subprocess service. `queue` supplies one outcome per spawn; a `hang`
 * outcome resolves only when the handle is terminated, so timeout handling is
 * exercised without a real long-running process.
 */
function makeSubprocess() {
  const calls = []
  const queue = []
  return {
    calls,
    enqueue(outcome) {
      queue.push(outcome)
    },
    async resolveExecutable(command) {
      return command
    },
    spawn(spec) {
      calls.push(spec)
      const outcome = queue.shift() ?? { stdout: '', stderr: '', exitCode: 0 }
      const reader = (text) => ({ readFrom: (from) => ({ text: from === 0 ? text : '', nextOffset: text.length, lossy: false }) })
      let settle
      const done = new Promise((resolve) => {
        settle = resolve
      })
      if (outcome === 'hang') {
        // stays pending until terminate()
      } else {
        settle({ exitCode: outcome.exitCode ?? 0, signal: outcome.signal ?? null })
      }
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: { stdout: reader(outcome.stdout ?? ''), stderr: reader(outcome.stderr ?? '') },
        done,
        terminate() {
          settle({ exitCode: null, signal: 'SIGTERM' })
        },
        waitForExit: async () => true,
      }
    },
  }
}

function makeContext(services) {
  const tools = new Map()
  const sections = []
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
    timeout(callback, delay) {
      const timer = setTimeout(callback, delay)
      timer.unref?.()
      return () => clearTimeout(timer)
    },
    get(service) {
      return services[service]
    },
  }
  return { ctx, tools, sections }
}

const plugin = await import(new URL(`file:///${pluginDir.replace(/\\/g, '/')}/index.js`).href)

const subprocess = makeSubprocess()
const sectionCalls = []
const services = {
  fs: fsService,
  subprocess,
  sandbox: {
    async confine(argv) {
      return { argv: [...argv], enforcement: 'partial', denialSignatures: ['EPERM'], runnerFailureRules: [] }
    },
  },
  sandboxPolicy: {
    resolve() {
      return { mode: 'workspace-write', workspaceRoot: demoDir }
    },
  },
  workingDirectory: {
    defaultDirectory: demoDir,
    async ensure() {
      return demoDir
    },
  },
  systemPrompt: {
    section(section) {
      sectionCalls.push(section)
      return () => {}
    },
  },
}

const { ctx, tools } = makeContext(services)
plugin.apply(ctx, {})

assert.deepEqual([...tools.keys()].sort(), ['bun_api', 'bun_exec', 'bun_project'], 'registers exactly three tools')
assert.equal(sectionCalls.length, 1, 'registers one system-prompt section')
assert.equal(sectionCalls[0].name, 'bun-native')

const exec = { signal: new AbortController().signal, agent: { id: 'session-1', session: {} }, callId: 'call-1', name: 'test', arguments: {} }
const report = (label, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail.length > 0 ? ` — ${detail}` : ''}`)
const assertLossless = (value, label) => assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} must be lossless JSON (no undefined-valued keys)`)

// --- bun_project -----------------------------------------------------------
subprocess.enqueue({ stdout: '1.4.4\n' })
const project = await tools.get('bun_project').execute({}, exec)
assertLossless(project, 'bun_project value')
assert.equal(project.kind, 'bun-native')
assert.equal(project.confidence, 'strong')
assert.deepEqual(project.signals, ['bunfig.toml', 'scripts:bun'])
assert.equal(project.lockfile, null)
assert.deepEqual(project.otherLockfiles, [])
assert.deepEqual(project.bunfig.sections, ['install', 'test'])
assert.equal(project.packageJson.scripts.length, 4)
assert.equal(project.runtime.version, '1.4.4')
assert.equal(project.typescript.present, true)
const projectText = tools.get('bun_project').output.render({}, project)[0].text
assert.match(projectText, /Classification: bun-native \(strong\)/)
report('bun_project classifies the demo project', true, `${project.kind}/${project.confidence} signals=${project.signals.join(',')}`)
report('bun_project render', projectText.includes('bun test') || projectText.includes('bun run test'))
console.log(projectText.split('\n').slice(0, 8).join('\n'))

// --- bun_exec run ----------------------------------------------------------
subprocess.enqueue({ stdout: '2 pass\n0 fail\n', stderr: '', exitCode: 0 })
const run = await tools.get('bun_exec').execute({ mode: 'run', target: 'test' }, exec)
assertLossless(run, 'bun_exec value')
const runSpawn = subprocess.calls.at(-1)
assert.deepEqual(runSpawn.argv, ['bun', 'run', 'test'])
assert.equal(runSpawn.cwd, demoDir)
assert.equal(run.exitCode, 0)
assert.equal(run.sandbox.mode, 'workspace-write')
assert.equal(run.command, 'bun run test')
assert.match(tools.get('bun_exec').output.render({}, run)[0].text, /2 pass/)
report('bun_exec run argv + sandbox', true, runSpawn.argv.join(' '))

// --- bun_exec eval ---------------------------------------------------------
subprocess.enqueue({ stdout: '1.4.4\n', exitCode: 0 })
const evaluated = await tools.get('bun_exec').execute({ mode: 'eval', code: 'console.log(Bun.version)' }, exec)
assert.deepEqual(subprocess.calls.at(-1).argv, ['bun', '--eval', 'console.log(Bun.version)'])
assert.equal(evaluated.stdout.text.trim(), '1.4.4')
report('bun_exec eval argv', true, subprocess.calls.at(-1).argv.join(' '))

// --- bun_exec failure and timeout -----------------------------------------
subprocess.enqueue({ stdout: '', stderr: 'error: Script not found "nope"\n', exitCode: 1 })
const failed = await tools.get('bun_exec').execute({ mode: 'run', target: 'nope' }, exec)
assert.equal(failed.exitCode, 1)
assert.match(tools.get('bun_exec').output.render({}, failed)[0].text, /\[exit code: 1\]/)
assert.match(tools.get('bun_exec').output.render({}, failed)[0].text, /\[stderr\]/)

subprocess.enqueue('hang')
const timedOut = await tools.get('bun_exec').execute({ mode: 'run', target: 'start', timeoutMs: 1000 }, exec)
assert.equal(timedOut.timedOut, true)
assert.match(tools.get('bun_exec').output.render({}, timedOut)[0].text, /\[timed out after 1000ms\]/)
report('bun_exec reports nonzero exit and timeout', true)

await assert.rejects(() => tools.get('bun_exec').execute({ mode: 'run' }, exec), /requires a `target`/)
await assert.rejects(() => tools.get('bun_exec').execute({ mode: 'explode' }, exec), /mode must be one of/)
await assert.rejects(() => tools.get('bun_exec').execute({ mode: 'eval' }, exec), /requires `code`/)
report('bun_exec validates arguments', true)

// --- bun_api ---------------------------------------------------------------
const api = tools.get('bun_api')
const detail = await api.execute({ name: 'Bun.serve' }, exec)
assert.equal(detail.returned, 1)
assert.equal(detail.entries[0].name, 'Bun.serve')
assert.ok(detail.entries[0].example.length > 0)
assert.ok(detail.categories.length >= 5)
const listing = await api.execute({}, exec)
assert.equal(listing.entries.length, 0)
assert.ok(listing.categories.every((category) => category.count >= 0))
const search = await api.execute({ query: 'sqlite' }, exec)
assert.ok(search.entries.length >= 1)
const detailText = api.output.render({}, detail)[0].text
assert.match(detailText, /Bun\.serve/)
report('bun_api detail, category listing and search', true, `${detail.total} APIs in ${detail.categories.length} categories`)

// --- workspace resolution --------------------------------------------------
const wsRoot = resolvePath(pluginDir, 'examples', 'bun-workspace')
const wsProject = await tools.get('bun_project').execute({ path: wsRoot }, exec)
assertLossless(wsProject, 'workspace root value')
assert.equal(wsProject.workspace.role, 'root')
assert.deepEqual(wsProject.workspace.patterns, ['packages/*', 'apps/*'])
assert.ok(['isolated', 'hoisted', 'unknown'].includes(wsProject.linker.strategy))
assert.ok(wsProject.recommended.some((item) => item.command === 'bun pm ls --all'))

const member = await tools.get('bun_project').execute({ path: resolvePath(wsRoot, 'apps', 'web') }, exec)
assertLossless(member, 'workspace member value')
assert.equal(member.kind, 'bun-native')
assert.equal(member.workspace.role, 'member')
assert.equal(member.workspace.memberName, 'web')
assert.equal(member.workspace.memberPath, 'apps/web')
assert.equal(member.lockfile, null)
assert.equal(member.workspace.rootLockfile.lockfileVersion, 2)
assert.equal(member.packageJson.workspaceDependencies[0].name, 'greeting')
assert.equal(member.packageJson.workspaceDependencies[0].range, 'workspace:*')
assert.equal(member.packageJson.workspaceDependencies[0].group, 'dependencies')
assert.ok(member.recommended.some((item) => item.command === 'bun install --filter web'))
assert.match(tools.get('bun_project').output.render({}, member)[0].text, /Workspace: member `web`/)
report('bun_project resolves the workspace root from a member', true, 'apps/web -> bun-workspace-demo')

// --- bun pm, workspace installs and workspace filters ----------------------
subprocess.enqueue({ stdout: 'web@workspace:apps/web\n', exitCode: 0 })
const pm = await tools.get('bun_exec').execute({ mode: 'pm', args: ['ls', '--all'] }, exec)
assert.deepEqual(subprocess.calls.at(-1).argv, ['bun', 'pm', 'ls', '--all'])
assert.match(pm.stdout.text, /workspace:apps\/web/)
subprocess.enqueue({ stdout: '', exitCode: 0 })
await tools.get('bun_exec').execute({ mode: 'install', filter: 'web' }, exec)
assert.deepEqual(subprocess.calls.at(-1).argv, ['bun', 'install', '--filter', 'web'])
subprocess.enqueue({ stdout: '', exitCode: 0 })
await tools.get('bun_exec').execute({ mode: 'run', target: 'test', filter: 'web' }, exec)
assert.deepEqual(subprocess.calls.at(-1).argv, ['bun', '--filter', 'web', 'test'])
subprocess.enqueue({ stdout: '', exitCode: 0 })
await tools.get('bun_exec').execute({ mode: 'test', filter: 'web' }, exec)
assert.deepEqual(subprocess.calls.at(-1).argv, ['bun', '--filter', 'web', 'test'])
subprocess.enqueue({ stdout: '', exitCode: 0 })
await tools.get('bun_exec').execute({ mode: 'add', target: 'zod@^3', args: ['--dev'] }, exec)
assert.deepEqual(subprocess.calls.at(-1).argv, ['bun', 'add', 'zod@^3', '--dev'])
await assert.rejects(() => tools.get('bun_exec').execute({ mode: 'add', target: 'zod', filter: 'web' }, exec), /works with "run", "test", "install" only/)
await assert.rejects(() => tools.get('bun_exec').execute({ mode: 'pm' }, exec), /requires `args`/)
report('bun_exec pm, install/run/test filters and add', true)

console.log('\nsmoke test complete')
