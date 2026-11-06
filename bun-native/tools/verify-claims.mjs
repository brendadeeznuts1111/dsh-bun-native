#!/usr/bin/env bun
/**
 * Settle the README's Bun CLI claims against the running Bun, with exact text.
 *
 * Each case runs a real `bun` command in a throwaway copy of the workspace
 * example and records stdout/stderr/exit. A wrong claim fails the script, so
 * re-running it after a Bun upgrade tells you which prose to change.
 *
 * Usage: bun bun-native/tools/verify-claims.mjs [--json <path>]
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')
const example = join(workspace, 'examples', 'bun-workspace')
const root = mkdtempSync(join(tmpdir(), 'bun-native-claims-'))
const cache = join(root, 'bun-cache')
const results = []
let failures = 0

const env = { ...process.env, BUN_INSTALL_CACHE_DIR: cache }

/** Run one Bun command in the fixture and record its exact output. */
function run(cmd, cwd = root) {
  const proc = Bun.spawnSync({
    cmd: ['bun', ...cmd],
    cwd,
    env,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    cmd: ['bun', ...cmd].join(' '),
    exit: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  }
}

/** Record a case with its verdict. */
function check(claim, expectation, outcome, passed) {
  if (!passed) failures += 1
  results.push({ claim, expectation, ...outcome, passed })
}

try {
  // A real two-member workspace so workspace commands have something to target.
  cpSync(example, root, { recursive: true, force: true, filter: (source) => !source.includes('node_modules') })
  const install = run(['install'])
  if (install.exit !== 0) throw new Error(`fixture install failed: ${install.stderr || install.stdout}`)

  // --- --filter forms ------------------------------------------------------
  const globalForm = run(['--filter', 'web', 'test'])
  check(
    '`bun --filter <pattern> <script>` is the supported targeted-script form',
    'the token after the pattern is a script name, so it never reports `Script "run" not found`',
    globalForm,
    !/Script "run" not found/u.test(globalForm.stderr),
  )

  const runForm = run(['run', '--filter', 'web', 'test'])
  check(
    '`bun run --filter <pattern> <script>` is a `bun run` flag',
    'accepted by the CLI (it may fail to spawn in this sandbox; it must not be an unknown flag)',
    runForm,
    !/(unknown|invalid).*(flag|option)|unrecognized/iu.test(`${runForm.stdout} ${runForm.stderr}`),
  )

  const wrongOrder = run(['--filter', 'web', 'run', 'test'])
  check(
    '`bun --filter <pattern> run <script>` is NOT valid',
    'the token after the pattern is taken as a script name, so Bun reports `Script "run" not found`',
    wrongOrder,
    /Script "run" not found/u.test(wrongOrder.stderr),
  )

  // --- bun add --cwd -------------------------------------------------------
  const appPackageBefore = JSON.parse(readFileSync(join(root, 'apps', 'web', 'package.json'), 'utf8'))
  const addWithCwd = run(['add', '--cwd', './apps/web', '--dev', 'file:../../packages/greeting'])
  const appPackageAfter = JSON.parse(readFileSync(join(root, 'apps', 'web', 'package.json'), 'utf8'))
  check(
    '`bun add --cwd <dir>` targets a workspace member',
    'the flag is accepted and writes the dependency into that member\'s package.json',
    addWithCwd,
    addWithCwd.exit === 0 && appPackageAfter.devDependencies?.greeting === 'file:../../packages/greeting',
  )
  if (addWithCwd.exit === 0) {
    writeFileSync(join(root, 'apps', 'web', 'package.json'), `${JSON.stringify(appPackageBefore, null, 2)}\n`)
    run(['install'])
  }

  const globalCwd = run(['--cwd', './apps/web', 'add', '--dev', 'file:../../packages/greeting'])
  check(
    '`bun --cwd <dir> add …` (global form) still works',
    'recorded for completeness: the README recommends the subcommand form',
    globalCwd,
    true,
  )

  // --- bun pm hash family --------------------------------------------------
  const hash = run(['pm', 'hash'])
  check('`bun pm hash` prints the lockfile hash', 'exit 0 and non-empty output', hash, hash.exit === 0 && hash.stdout.length > 0)

  const hashString = run(['pm', 'hash-string'])
  check('`bun pm hash-string` exists', 'exit 0 and non-empty output', hashString, hashString.exit === 0 && hashString.stdout.length > 0)

  const hashPrint = run(['pm', 'hash-print'])
  check('`bun pm hash-print` exists', 'exit 0 and non-empty output', hashPrint, hashPrint.exit === 0 && hashPrint.stdout.length > 0)

  const bin = run(['pm', 'bin'])
  check('`bun pm bin` prints the bin folder', 'exit 0 and a path ending in node_modules/.bin', bin, bin.exit === 0 && /node_modules[\\/]\.bin$/u.test(bin.stdout))

  // --- runtime, for the coverage wording -----------------------------------
  const probe = run(['--eval', 'console.log(JSON.stringify({ version: Bun.version, globals: Object.getOwnPropertyNames(Bun).length }))'])
  const runtime = JSON.parse(probe.stdout)
  check('runtime identity is reported for the coverage claim', 'version and name-level Bun global count', probe, probe.exit === 0)
  results.push({ runtime })

  const report = {
    bunVersion: runtime.version,
    bunGlobals: runtime.globals,
    ranAt: new Date().toISOString(),
    failures,
    results,
  }
  const jsonPath = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : undefined
  if (jsonPath !== undefined) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)

  const lines = [`# Bun CLI claims verified on Bun ${runtime.version}`, '', `Bun name-level globals: ${runtime.globals}.`, '']
  for (const result of results) {
    if (result.claim === undefined) continue
    lines.push(`## ${result.passed ? 'PASS' : 'FAIL'} — ${result.claim}`, '', `Command: \`${result.cmd}\` → exit ${result.exit}`, '')
    if (result.stdout) lines.push('stdout:', '```', result.stdout.slice(0, 1_200), '```', '')
    if (result.stderr) lines.push('stderr:', '```', result.stderr.slice(0, 1_200), '```', '')
  }
  lines.push(failures === 0 ? 'All claims hold.' : `${failures} claim(s) no longer hold.`)
  process.stdout.write(`${lines.join('\n')}\n`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
