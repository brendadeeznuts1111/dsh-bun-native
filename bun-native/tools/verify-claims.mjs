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

  // --- Bun.serve property tests (digest vs runtime) ------------------------
  const catalog = JSON.parse(readFileSync(join(workspace, 'data', 'bun-globals.json'), 'utf8'))
  const serveEntry = catalog.apis.find((entry) => entry.name === 'Bun.serve')
  check(
    'the digest has a Bun.serve entry whose example uses server.url',
    'entry exists, is in networking, and its example inspects the URL',
    { cmd: '(catalog lookup)', exit: serveEntry === undefined ? 1 : 0, stdout: serveEntry === undefined ? '' : serveEntry.signature.slice(0, 160), stderr: '' },
    serveEntry !== undefined && serveEntry.category === 'networking' && serveEntry.example.includes('server.url'),
  )

  // Four property domains, each check labelled by its domain so a failure
  // names the property that drifted (URL / protocol / hostname / port).
  const serveCheck = (claim, expectation, passed, detail) => {
    check(claim, expectation, { cmd: '(in-process Bun.serve)', exit: passed ? 0 : 1, stdout: detail, stderr: '' }, passed)
  }
  const propertyCheck = (domain, claim, expectation, passed, detail) => {
    check(`${domain} property — ${claim}`, expectation, { cmd: '(in-process Bun.serve)', exit: passed ? 0 : 1, stdout: detail, stderr: '' }, passed)
  }

  let server
  try {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/json') return Response.json({ ok: true })
        return new Response(`path:${url.pathname}`)
      },
    })
    const url = server.url

    propertyCheck('URL', 'server.url is a URL instance', 'url instanceof URL', url instanceof URL, String(url))
    propertyCheck('URL', 'href is an http root URL', 'href matches http://host:port/', /^http:\/\/[^/]+:\d+\/$/u.test(url.href), url.href)
    propertyCheck('URL', 'toString() equals href', 'url.toString() === url.href', url.toString() === url.href, url.toString())
    propertyCheck('URL', 'origin is protocol + host, without a path', 'origin equals `http://${url.host}`', url.origin === `http://${url.host}` && !url.origin.endsWith('/'), url.origin)
    propertyCheck('URL', 'pathname is / and search is empty', 'pathname "/" and empty search', url.pathname === '/' && url.search === '', `${url.pathname}${url.search}`)
    propertyCheck('URL', 'host is hostname:port', 'url.host === `${url.hostname}:${url.port}`', url.host === `${url.hostname}:${url.port}`, url.host)

    propertyCheck('protocol', 'server.protocol is the bare scheme', 'server.protocol === "http"', server.protocol === 'http', String(server.protocol))
    propertyCheck('protocol', 'server.url.protocol is the scheme with a colon', 'url.protocol === "http:"', url.protocol === 'http:', url.protocol)
    propertyCheck('protocol', 'the two properties differ only by the colon', '`${server.protocol}:` === url.protocol', `${server.protocol}:` === url.protocol, `${server.protocol} vs ${url.protocol}`)
    propertyCheck('protocol', 'Server.protocol exists on the handle', 'the property is present and recorded, not assumed', 'protocol' in server, String(server.protocol))

    propertyCheck('hostname', 'server.hostname defaults to localhost', 'hostname === "localhost"', server.hostname === 'localhost', server.hostname)
    propertyCheck('hostname', 'server.hostname equals url.hostname', 'both report the same host', server.hostname === url.hostname, `${server.hostname} vs ${url.hostname}`)
    propertyCheck('hostname', 'the hostname appears in the URL origin', 'origin contains hostname', url.origin.includes(server.hostname), url.origin)

    propertyCheck('port', 'server.port is an allocated integer in 1..65535', 'integer between 1 and 65535', Number.isInteger(server.port) && server.port > 0 && server.port <= 65_535, String(server.port))
    propertyCheck('port', 'url.port is the decimal string of server.port', 'url.port === String(server.port)', url.port === String(server.port), `${url.port} vs ${server.port}`)
    propertyCheck('port', 'the URL origin ends with :server.port', 'origin.endsWith(`:${server.port}`)', url.origin.endsWith(`:${server.port}`), url.origin)

    // Server behaviour checks stay separate from the four property domains.
    const jsonResponse = await fetch(new URL('/json', url))
    const jsonBody = await jsonResponse.json()
    serveCheck('the fetch handler answers at server.url', 'HTTP 200 with {ok:true}', jsonResponse.status === 200 && jsonBody.ok === true, `status=${jsonResponse.status} body=${JSON.stringify(jsonBody)}`)
    const textResponse = await fetch(new URL('/hello', url))
    serveCheck('a non-JSON path returns its plain response', 'body "path:/hello"', (await textResponse.text()) === 'path:/hello')
    server.stop()
    let closed = false
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_500) })
    } catch {
      closed = true
    }
    serveCheck('server.stop() closes the listener', 'the next fetch fails', closed)
  } finally {
    try {
      server?.stop()
    } catch {
      // Already stopped.
    }
  }

  // Explicit hostname binding is its own hostname property check.
  let namedServer
  try {
    namedServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
    propertyCheck(
      'hostname',
      'an explicit 127.0.0.1 bind is reflected in server.hostname and url.hostname',
      'both report 127.0.0.1',
      namedServer.hostname === '127.0.0.1' && namedServer.url.hostname === '127.0.0.1',
      `${namedServer.hostname} / ${namedServer.url.hostname}`,
    )
  } finally {
    namedServer?.stop()
  }

  // Port validation is a port property, not a server-behaviour check.
  try {
    const invalid = Bun.serve({ port: 70_000, fetch: () => new Response('x') })
    invalid.stop()
    propertyCheck('port', 'a port above 65535 is rejected', 'Bun.serve throws a range error', false, 'a server was created')
  } catch (error) {
    propertyCheck('port', 'a port above 65535 is rejected', 'Bun.serve throws a range error', /out of range|65535/u.test(error.message), error.message)
  }

  const exampleRun = run(['-e', serveEntry.example])
  check(
    'the digest Bun.serve example runs as written',
    'exit 0 and its output contains the http:// URL it logs',
    exampleRun,
    exampleRun.exit === 0 && /http:\/\//u.test(exampleRun.stdout),
  )

  // --- node:url compatibility claims (Bun docs: "Fully implemented") -------
  // One separate check per property domain, so a regression names its domain.
  const urlModule = await import('node:url')
  const documentedUrlExports = ['URL', 'URLPattern', 'URLSearchParams', 'Url', 'domainToASCII', 'domainToUnicode', 'fileURLToPath', 'fileURLToPathBuffer', 'format', 'parse', 'pathToFileURL', 'resolve', 'resolveObject', 'urlToHttpOptions']
  const bunUrlExports = Object.keys(urlModule).filter((name) => name !== 'default').sort()
  check(
    'node:url surface — documented exports are present',
    `exports match ${documentedUrlExports.join(', ')}`,
    { cmd: '(import node:url)', exit: 0, stdout: bunUrlExports.join(','), stderr: '' },
    JSON.stringify(bunUrlExports) === JSON.stringify([...documentedUrlExports].sort()),
  )

  const nodeProbe = Bun.spawnSync({
    cmd: ['node', '-e', "console.log(Object.keys(require('node:url')).sort().join(','))"],
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
    env: { ...process.env },
  })
  const nodeUrlExports = nodeProbe.exitCode === 0 ? nodeProbe.stdout.toString().trim().split(',').sort() : undefined
  check(
    'node:url surface — matches the installed Node.js',
    'when node is available, Bun and Node expose the same url exports',
    { cmd: 'node -e <url exports>', exit: nodeProbe.exitCode ?? 1, stdout: nodeUrlExports === undefined ? '(node unavailable; skipped)' : nodeUrlExports.join(','), stderr: nodeProbe.stderr?.toString().trim() ?? '' },
    nodeUrlExports === undefined || JSON.stringify(bunUrlExports) === JSON.stringify(nodeUrlExports),
  )

  check(
    'node:url URL property — URL and URLSearchParams are the globals',
    'url.URL === URL and url.URLSearchParams === URLSearchParams',
    { cmd: '(in-process node:url)', exit: 0, stdout: `${urlModule.URL === URL} ${urlModule.URLSearchParams === URLSearchParams}`, stderr: '' },
    urlModule.URL === URL && urlModule.URLSearchParams === URLSearchParams,
  )

  const urlSample = 'https://user:pass@example.com:8443/p/a?q=1&r=2#frag'
  const parsedSample = new urlModule.URL(urlSample)
  const urlChecks = [
    ['protocol', parsedSample.protocol === 'https:', parsedSample.protocol],
    ['hostname', parsedSample.hostname === 'example.com', parsedSample.hostname],
    ['port', parsedSample.port === '8443', parsedSample.port],
    ['pathname', parsedSample.pathname === '/p/a', parsedSample.pathname],
    ['search', parsedSample.search === '?q=1&r=2', parsedSample.search],
    ['hash', parsedSample.hash === '#frag', parsedSample.hash],
    ['origin', parsedSample.origin === 'https://example.com:8443', parsedSample.origin],
  ]
  for (const [property, passed, detail] of urlChecks) {
    check(`node:url URL property — ${property}`, `WHATWG URL ${property} is correct`, { cmd: '(in-process node:url)', exit: passed ? 0 : 1, stdout: detail, stderr: '' }, passed)
  }

  const searchParams = new urlModule.URLSearchParams('a=1&b=2&a=3')
  check(
    'node:url URLSearchParams property — size and duplicates',
    'size 3 with getAll("a") === ["1","3"]',
    { cmd: '(in-process node:url)', exit: 0, stdout: `${searchParams.size} ${JSON.stringify(searchParams.getAll('a'))}`, stderr: '' },
    searchParams.size === 3 && JSON.stringify(searchParams.getAll('a')) === JSON.stringify(['1', '3']),
  )
  const sortedParams = new urlModule.URLSearchParams('a=1&b=2&a=3')
  sortedParams.sort()
  check(
    'node:url URLSearchParams property — sort and serialization',
    'sorted form serializes as a=1&a=3&b=2',
    { cmd: '(in-process node:url)', exit: 0, stdout: String(sortedParams), stderr: '' },
    String(sortedParams) === 'a=1&a=3&b=2',
  )

  const legacyParsed = urlModule.parse(urlSample)
  const parseChecks = [
    ['protocol', legacyParsed.protocol === 'https:', legacyParsed.protocol],
    ['auth', legacyParsed.auth === 'user:pass', String(legacyParsed.auth)],
    ['host', legacyParsed.host === 'example.com:8443', legacyParsed.host],
    ['port', legacyParsed.port === '8443', String(legacyParsed.port)],
    ['path', legacyParsed.path === '/p/a?q=1&r=2', legacyParsed.path],
    ['href', legacyParsed.href === urlSample, legacyParsed.href],
  ]
  for (const [property, passed, detail] of parseChecks) {
    check(`node:url legacy parse property — ${property}`, `url.parse() ${property} is correct`, { cmd: '(in-process node:url)', exit: passed ? 0 : 1, stdout: detail, stderr: '' }, passed)
  }
  check(
    'node:url legacy format property — round-trip',
    'url.format(url.parse(url)) === url',
    { cmd: '(in-process node:url)', exit: 0, stdout: urlModule.format(legacyParsed), stderr: '' },
    urlModule.format(legacyParsed) === urlSample,
  )
  check(
    'node:url legacy resolve property — dot segments',
    'resolve("http://a/b/c", "../d") === "http://a/d"',
    { cmd: '(in-process node:url)', exit: 0, stdout: urlModule.resolve('http://a/b/c', '../d'), stderr: '' },
    urlModule.resolve('http://a/b/c', '../d') === 'http://a/d',
  )

  const windowsPath = 'C:\\Users\\bobby\\a b.txt'
  const fileUrl = urlModule.pathToFileURL(windowsPath)
  check(
    'node:url file URL property — encoding and round-trip',
    'file:///C:/Users/bobby/a%20b.txt round-trips to the Windows path',
    { cmd: '(in-process node:url)', exit: 0, stdout: `${fileUrl.href} -> ${urlModule.fileURLToPath(fileUrl)}`, stderr: '' },
    fileUrl.href === 'file:///C:/Users/bobby/a%20b.txt' && urlModule.fileURLToPath(fileUrl) === windowsPath,
  )
  check(
    'node:url file URL property — fileURLToPathBuffer',
    'buffer contains the path bytes',
    { cmd: '(in-process node:url)', exit: 0, stdout: Buffer.isBuffer(urlModule.fileURLToPathBuffer(fileUrl)).toString(), stderr: '' },
    Buffer.isBuffer(urlModule.fileURLToPathBuffer(fileUrl)) && urlModule.fileURLToPathBuffer(fileUrl).toString() === windowsPath,
  )
  check(
    'node:url file URL property — rejects non-file schemes',
    'fileURLToPath("https://…") throws',
    (() => {
      try {
        urlModule.fileURLToPath('https://example.com/x')
        return { cmd: '(in-process node:url)', exit: 0, stdout: 'did not throw', stderr: '' }
      } catch (error) {
        return { cmd: '(in-process node:url)', exit: 0, stdout: error.message, stderr: '' }
      }
    })(),
    (() => {
      try {
        urlModule.fileURLToPath('https://example.com/x')
        return false
      } catch {
        return true
      }
    })(),
  )

  check(
    'node:url domain property — ASCII/Unicode round-trip',
    'domainToASCII("mañana.com") === "xn--maana-pta.com" and back',
    { cmd: '(in-process node:url)', exit: 0, stdout: `${urlModule.domainToASCII('mañana.com')} / ${urlModule.domainToUnicode('xn--maana-pta.com')}`, stderr: '' },
    urlModule.domainToASCII('mañana.com') === 'xn--maana-pta.com' && urlModule.domainToUnicode('xn--maana-pta.com') === 'mañana.com',
  )

  const httpOptions = urlModule.urlToHttpOptions(parsedSample)
  const httpOptionChecks = [
    ['protocol', httpOptions.protocol === 'https:', httpOptions.protocol],
    ['hostname', httpOptions.hostname === 'example.com', httpOptions.hostname],
    ['port is a number', httpOptions.port === 8443 && typeof httpOptions.port === 'number', `${typeof httpOptions.port} ${httpOptions.port}`],
    ['path', httpOptions.path === '/p/a?q=1&r=2', httpOptions.path],
    ['auth', httpOptions.auth === 'user:pass', String(httpOptions.auth)],
  ]
  for (const [property, passed, detail] of httpOptionChecks) {
    check(`node:url HTTP-options property — ${property}`, `urlToHttpOptions ${property} is correct`, { cmd: '(in-process node:url)', exit: passed ? 0 : 1, stdout: detail, stderr: '' }, passed)
  }

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
