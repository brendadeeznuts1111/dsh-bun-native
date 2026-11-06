/**
 * `node:url` compatibility property tests.
 *
 * Bun's Node reference labels `url` "Fully supported in Bun — Fully
 * implemented" (https://bun.com/reference/node/url). These suites check that
 * claim by domain, one suite per property family, against the documented
 * surface and Node-compatible behaviour:
 *
 *   module surface      — exports documented by Node/Bun exist and are the globals
 *   URL properties      — WHATWG URL component properties
 *   URLSearchParams     — collection/mutation properties
 *   legacy parse        — url.parse() component properties
 *   legacy format       — url.format() round-trips
 *   legacy resolve      — url.resolve()/resolveObject() rules
 *   file URL            — pathToFileURL()/fileURLToPath(Buffer) round-trips
 *   domain              — domainToASCII()/domainToUnicode()
 *   HTTP options        — urlToHttpOptions() mapping
 */

import { describe, expect, test } from 'bun:test'
import * as url from 'node:url'

/** Every export Node 24's `node:url` exposes; Bun's page lists the function subset only. */
const DOCUMENTED_EXPORTS = [
  'URL',
  'URLPattern',
  'URLSearchParams',
  'Url',
  'domainToASCII',
  'domainToUnicode',
  'fileURLToPath',
  'fileURLToPathBuffer',
  'format',
  'parse',
  'pathToFileURL',
  'resolve',
  'resolveObject',
  'urlToHttpOptions',
]

const SAMPLE = 'https://user:pass@example.com:8443/p/a?q=1&r=2#frag'

describe('node:url module surface properties', () => {
  test('exports exactly the Node-documented url members', () => {
    // An ESM namespace of a CJS module also carries `default`; it is not an
    // export Node documents on the url module itself.
    expect(Object.keys(url).filter((name) => name !== 'default').sort()).toEqual([...DOCUMENTED_EXPORTS].sort())
  })

  test('URL and URLSearchParams are the global WHATWG classes', () => {
    expect(url.URL).toBe(URL)
    expect(url.URLSearchParams).toBe(URLSearchParams)
  })

  test('every documented function is callable', () => {
    const functions = ['domainToASCII', 'domainToUnicode', 'fileURLToPath', 'fileURLToPathBuffer', 'format', 'parse', 'pathToFileURL', 'resolve', 'resolveObject', 'urlToHttpOptions']
    for (const name of functions) expect(typeof url[name]).toBe('function')
  })

  test('the legacy Url constructor is available', () => {
    expect(typeof url.Url).toBe('function')
    expect(new url.Url().protocol).toBeNull()
  })
})

describe('URL properties (node:url)', () => {
  const parsed = new url.URL(SAMPLE)

  test('protocol is the scheme with a colon', () => expect(parsed.protocol).toBe('https:'))
  test('hostname is the bare host', () => expect(parsed.hostname).toBe('example.com'))
  test('port is the decimal string', () => expect(parsed.port).toBe('8443'))
  test('pathname is the path without query or hash', () => expect(parsed.pathname).toBe('/p/a'))
  test('search includes the leading ?', () => expect(parsed.search).toBe('?q=1&r=2'))
  test('hash includes the leading #', () => expect(parsed.hash).toBe('#frag'))
  test('origin is protocol + host', () => expect(parsed.origin).toBe('https://example.com:8443'))
  test('username and password are decoded components', () => {
    expect(parsed.username).toBe('user')
    expect(parsed.password).toBe('pass')
  })
  test('href serializes the whole URL', () => expect(parsed.href).toBe(SAMPLE))
})

describe('URLSearchParams properties (node:url)', () => {
  test('size counts every entry, including duplicates', () => {
    expect(new url.URLSearchParams('a=1&b=2&a=3').size).toBe(3)
  })

  test('getAll returns duplicates in order', () => {
    expect(new url.URLSearchParams('a=1&b=2&a=3').getAll('a')).toEqual(['1', '3'])
  })

  test('has reports membership', () => {
    expect(new url.URLSearchParams('a=1').has('a')).toBe(true)
    expect(new url.URLSearchParams('a=1').has('b')).toBe(false)
  })

  test('append adds an entry and grows size', () => {
    const params = new url.URLSearchParams('a=1')
    params.append('a', '2')
    expect(params.getAll('a')).toEqual(['1', '2'])
    expect(params.size).toBe(2)
  })

  test('set replaces every existing value', () => {
    const params = new url.URLSearchParams('a=1&a=2')
    params.set('a', '9')
    expect(params.getAll('a')).toEqual(['9'])
  })

  test('delete removes the key', () => {
    const params = new url.URLSearchParams('a=1&b=2')
    params.delete('a')
    expect(String(params)).toBe('b=2')
  })

  test('sort orders by name, keeping duplicate order', () => {
    const params = new url.URLSearchParams('a=1&b=2&a=3')
    params.sort()
    expect(String(params)).toBe('a=1&a=3&b=2')
  })

  test('toString percent-encodes form-style', () => {
    expect(new url.URLSearchParams({ q: 'a b' }).toString()).toBe('q=a+b')
  })

  test('entries, keys and values iterate the same data', () => {
    const params = new url.URLSearchParams('a=1&b=2')
    expect([...params.keys()]).toEqual(['a', 'b'])
    expect([...params.values()]).toEqual(['1', '2'])
    expect([...params.entries()]).toEqual([['a', '1'], ['b', '2']])
  })

  test('forEach visits every pair once', () => {
    const seen = []
    new url.URLSearchParams('a=1&b=2').forEach((value, key) => seen.push(`${key}=${value}`))
    expect(seen).toEqual(['a=1', 'b=2'])
  })
})

describe('legacy parse properties (node:url)', () => {
  const parsed = url.parse(SAMPLE)

  test('protocol', () => expect(parsed.protocol).toBe('https:'))
  test('slashes', () => expect(parsed.slashes).toBe(true))
  test('auth', () => expect(parsed.auth).toBe('user:pass'))
  test('host is hostname:port', () => expect(parsed.host).toBe('example.com:8443'))
  test('hostname', () => expect(parsed.hostname).toBe('example.com'))
  test('port is the decimal string', () => expect(parsed.port).toBe('8443'))
  test('pathname', () => expect(parsed.pathname).toBe('/p/a'))
  test('search includes ?', () => expect(parsed.search).toBe('?q=1&r=2'))
  test('query is the raw query string', () => expect(parsed.query).toBe('q=1&r=2'))
  test('hash includes #', () => expect(parsed.hash).toBe('#frag'))
  test('path is pathname + search', () => expect(parsed.path).toBe('/p/a?q=1&r=2'))
  test('href is the serialized URL', () => expect(parsed.href).toBe(SAMPLE))
  test('parseQueryString turns query into an object', () => {
    const withObject = url.parse('https://example.com/?a=1&b=2', true)
    expect(withObject.query).toEqual({ a: '1', b: '2' })
  })
  test('a non-URL string is percent-encoded into pathname rather than thrown', () => {
    const invalid = url.parse('not a url')
    expect(invalid.protocol).toBeNull()
    expect(invalid.pathname).toBe('not%20a%20url')
  })
})

describe('legacy format properties (node:url)', () => {
  test('format(parse(url)) round-trips the href', () => {
    expect(url.format(url.parse(SAMPLE))).toBe(SAMPLE)
  })

  test('format honors protocol, hostname, port and pathname', () => {
    expect(url.format({ protocol: 'https:', hostname: 'example.com', port: 8443, pathname: '/p' })).toBe('https://example.com:8443/p')
  })

  test('format serializes an object query', () => {
    expect(url.format({ protocol: 'https:', hostname: 'example.com', pathname: '/p', query: { q: '1' } })).toBe('https://example.com/p?q=1')
  })

  test('format includes auth', () => {
    expect(url.format({ protocol: 'http:', hostname: 'example.com', auth: 'user:pass', pathname: '/' })).toBe('http://user:pass@example.com/')
  })

  test('format includes hash', () => {
    expect(url.format({ protocol: 'http:', hostname: 'example.com', pathname: '/', hash: '#frag' })).toBe('http://example.com/#frag')
  })
})

describe('legacy resolve properties (node:url)', () => {
  test('resolve replaces the last path segment', () => {
    expect(url.resolve('/one/two', 'three')).toBe('/one/three')
  })

  test('resolve applies dot segments', () => {
    expect(url.resolve('http://a/b/c', '../d')).toBe('http://a/d')
  })

  test('an absolute reference wins over the base', () => {
    expect(url.resolve('http://a/b', 'https://c/d')).toBe('https://c/d')
  })

  test('resolveObject returns the resolved components', () => {
    const resolved = url.resolveObject('https://example.com/a/b', '../c?x=1')
    expect(resolved.href).toBe('https://example.com/c?x=1')
    expect(resolved.protocol).toBe('https:')
    expect(resolved.host).toBe('example.com')
    expect(resolved.pathname).toBe('/c')
    expect(resolved.search).toBe('?x=1')
  })
})

describe('file URL properties (node:url)', () => {
  const windowsPath = 'C:\\Users\\bobby\\a b.txt'
  const fileUrl = url.pathToFileURL(windowsPath)

  test('pathToFileURL produces a file: URL', () => {
    expect(fileUrl.protocol).toBe('file:')
    expect(fileUrl.hostname).toBe('')
  })

  test('pathToFileURL percent-encodes spaces', () => {
    expect(fileUrl.href).toBe('file:///C:/Users/bobby/a%20b.txt')
  })

  test('fileURLToPath round-trips the absolute path', () => {
    expect(url.fileURLToPath(fileUrl)).toBe(windowsPath)
  })

  test('fileURLToPath decodes percent-encoded characters', () => {
    expect(url.fileURLToPath('file:///C:/Users/bobby/a%20b.txt')).toBe('C:\\Users\\bobby\\a b.txt')
  })

  test('fileURLToPathBuffer returns a Buffer with the path bytes', () => {
    const buffer = url.fileURLToPathBuffer(fileUrl)
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(buffer.toString()).toBe(windowsPath)
  })

  test('fileURLToPath rejects a non-file scheme', () => {
    expect(() => url.fileURLToPath('https://example.com/x')).toThrow(/scheme file/u)
  })
})

describe('domain properties (node:url)', () => {
  test('domainToASCII converts Unicode to Punycode', () => {
    expect(url.domainToASCII('mañana.com')).toBe('xn--maana-pta.com')
  })

  test('domainToUnicode converts Punycode back to Unicode', () => {
    expect(url.domainToUnicode('xn--maana-pta.com')).toBe('mañana.com')
  })

  test('domainToASCII returns an empty string for an invalid domain', () => {
    expect(url.domainToASCII('not a domain')).toBe('')
    expect(url.domainToASCII('')).toBe('')
  })

  test('domainToUnicode leaves an invalid domain unchanged', () => {
    expect(url.domainToUnicode('invalid..')).toBe('invalid..')
  })
})

describe('URL-to-HTTP-options properties (node:url)', () => {
  const options = url.urlToHttpOptions(new url.URL(SAMPLE))

  test('protocol is copied', () => expect(options.protocol).toBe('https:'))
  test('hostname is the bare host', () => expect(options.hostname).toBe('example.com'))
  test('port is a number, not a string', () => {
    expect(options.port).toBe(8443)
    expect(typeof options.port).toBe('number')
  })
  test('path is pathname + search', () => expect(options.path).toBe('/p/a?q=1&r=2'))
  test('auth carries username:password', () => expect(options.auth).toBe('user:pass'))
  test('hash and search keep their markers', () => {
    expect(options.hash).toBe('#frag')
    expect(options.search).toBe('?q=1&r=2')
  })
  test('href is preserved', () => expect(options.href).toBe(SAMPLE))
})
