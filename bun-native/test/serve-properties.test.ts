/**
 * Bun.serve property tests, one suite per property domain:
 *
 *   URL properties      — server.url as a URL value
 *   protocol properties — server.protocol vs server.url.protocol
 *   hostname properties — server.hostname vs URL hostname, explicit binds
 *   port properties     — server.port vs URL port, ephemeral allocation, validation
 *
 * Every test starts and stops its own server so the suites stay independent.
 * Verified figures come from Bun 1.4.4 on Windows; `bun run claims` re-checks
 * the same domains against the live runtime.
 */

import { afterEach, describe, expect, test } from 'bun:test'

const running = new Set()

/** Start a server on an ephemeral port and remember it for teardown. */
function serve(options = {}) {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response('ok')
    },
    ...options,
  })
  running.add(server)
  return server
}

/** Stop every server this file started. */
function stopAll() {
  for (const server of running) {
    try {
      server.stop()
    } catch {
      // Already stopped by the test.
    }
  }
  running.clear()
}

afterEach(() => stopAll())

describe('URL properties', () => {
  test('server.url is a URL instance', () => {
    const server = serve()
    expect(server.url).toBeInstanceOf(URL)
  })

  test('server.url.href is an http origin ending at the root path', () => {
    const server = serve()
    expect(server.url.href).toMatch(/^http:\/\/.+:\d+\/$/u)
  })

  test('server.url.toString() equals server.url.href', () => {
    const server = serve()
    expect(server.url.toString()).toBe(server.url.href)
  })

  test('server.url.origin is the protocol and host without a path', () => {
    const server = serve()
    expect(server.url.origin).toBe(`http://${server.url.host}`)
    expect(server.url.origin.endsWith('/')).toBe(false)
  })

  test('server.url.pathname is / and search is empty for the base URL', () => {
    const server = serve()
    expect(server.url.pathname).toBe('/')
    expect(server.url.search).toBe('')
  })

  test('the URL host is the hostname and port joined by a colon', () => {
    const server = serve()
    expect(server.url.host).toBe(`${server.url.hostname}:${server.url.port}`)
  })
})

describe('protocol properties', () => {
  test('server.protocol is a bare scheme name', () => {
    const server = serve()
    expect(server.protocol).toBe('http')
  })

  test('server.url.protocol is the WHATWG scheme form with a colon', () => {
    const server = serve()
    expect(server.url.protocol).toBe('http:')
  })

  test('server.protocol has no colon while server.url.protocol does', () => {
    const server = serve()
    expect(server.protocol).not.toContain(':')
    expect(server.url.protocol).toContain(':')
  })

  test('the two protocol properties describe the same scheme', () => {
    const server = serve()
    expect(`${server.protocol}:`).toBe(server.url.protocol)
  })
})

describe('hostname properties', () => {
  test('server.hostname defaults to localhost', () => {
    const server = serve()
    expect(server.hostname).toBe('localhost')
  })

  test('server.hostname equals server.url.hostname', () => {
    const server = serve()
    expect(server.hostname).toBe(server.url.hostname)
  })

  test('an explicit 127.0.0.1 hostname is reflected in both properties', () => {
    const server = serve({ hostname: '127.0.0.1' })
    expect(server.hostname).toBe('127.0.0.1')
    expect(server.url.hostname).toBe('127.0.0.1')
  })

  test('the hostname appears inside the URL origin', () => {
    const server = serve()
    expect(server.url.origin).toContain(server.hostname)
  })
})

describe('port properties', () => {
  test('server.port is an allocated integer between 1 and 65535', () => {
    const server = serve()
    expect(Number.isInteger(server.port)).toBe(true)
    expect(server.port).toBeGreaterThan(0)
    expect(server.port).toBeLessThanOrEqual(65_535)
  })

  test('server.url.port is the decimal string of server.port', () => {
    const server = serve()
    expect(server.url.port).toBe(String(server.port))
  })

  test('the allocated port appears in the URL origin', () => {
    const server = serve()
    expect(server.url.origin.endsWith(`:${server.port}`)).toBe(true)
  })

  test('a port above 65535 is rejected before a server is created', () => {
    expect(() => Bun.serve({ port: 70_000, fetch: () => new Response('x') })).toThrow(/out of range|65535/u)
  })

  test('two ephemeral servers do not share a port', () => {
    const first = serve()
    const second = serve()
    expect(first.port).not.toBe(second.port)
  })
})
