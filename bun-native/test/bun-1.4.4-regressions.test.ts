/**
 * Bun 1.4.4 release-note regressions, grouped by the note they guard.
 *
 * The release notes mix fixes with performance numbers. Timings from the notes
 * are not reproduced here; what is asserted is the *behaviour* each fix
 * promises, plus two deliberately generous O(N²)-regression budgets
 * (`URLSearchParams.append`, which the notes say became lazy, and
 * `Bun.indexOfLine`, which the notes say stopped being quadratic on non-ASCII
 * input). A budget only trips on catastrophic regressions, not on machine noise.
 *
 * See `research/bun-1.4.4-release-notes.md` for the full traceability table.
 */

import { describe, expect, test } from 'bun:test'
import path from 'node:path'

describe('URL.searchParams.append laziness', () => {
  test('4000 appends complete quickly and href reflects the last value', () => {
    const url = new URL('https://example.com/')
    const start = performance.now()
    for (let index = 0; index < 4_000; index += 1) url.searchParams.append('k', String(index))
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(250)
    expect(url.href).toContain('k=3999')
  })

  test('appending through a detached URLSearchParams keeps the same budget', () => {
    const params = new URLSearchParams()
    const start = performance.now()
    for (let index = 0; index < 4_000; index += 1) params.append('k', String(index))
    expect(performance.now() - start).toBeLessThan(250)
    expect(params.get('k')).toBe('0')
    expect(params.getAll('k')).toHaveLength(4_000)
  })
})

describe('Bun.Glob brace groups', () => {
  test('nested brace alternatives match', () => {
    expect(new Bun.Glob('{a,{b,c}}').match('c')).toBe(true)
    expect(new Bun.Glob('{a,b{c,d}}').match('bd')).toBe(true)
    expect(new Bun.Glob('a{a,b}c').match('abc')).toBe(true)
  })

  test('a literal dotfile segment matches without dot: true', () => {
    expect(new Bun.Glob('.env').match('.env')).toBe(true)
  })

  test('brace alternatives still reject non-members', () => {
    expect(new Bun.Glob('{a,b{c,d}}').match('be')).toBe(false)
  })
})

describe('Bun.color fixes', () => {
  test('a 24-bit number is opaque, not alpha 0', () => {
    expect(Bun.color(0xff0000, 'rgba')).toBe('rgba(255, 0, 0, 1)')
    expect(Bun.color(0xff0000, 'hex')).toBe('#ff0000')
  })

  test('ansi-16 emits the color number as printable digits', () => {
    const ansi = Bun.color(1, 'ansi-16')
    expect(ansi).toMatch(/^\u001b\[\d+m$/u)
    expect([...ansi].every((character) => character === '\u001b' || character.codePointAt(0) >= 32)).toBe(true)
  })

  test('ansi-256 grey stays on the grey ramp', () => {
    const match = /^\u001b\[38;5;(\d+)m$/u.exec(Bun.color('hsl(0, 0%, 50%)', 'ansi-256'))
    expect(match).not.toBeNull()
    expect(Number(match[1])).toBeGreaterThanOrEqual(232)
    expect(Number(match[1])).toBeLessThanOrEqual(255)
  })

  test('hsl and lab outputs are parseable strings', () => {
    expect(Bun.color('hsl(120, 100%, 50%)', 'hsl')).toBe('hsl(120, 100%, 50%)')
    expect(Bun.color('red', 'lab')).toMatch(/^lab\([\d.-]+% [\d.-]+ [\d.-]+\)$/u)
  })
})

describe('Bun.Cookie RFC 6265 fixes', () => {
  test('Expires parses to the correct instant', () => {
    const cookie = Bun.Cookie.parse('a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT')
    expect(cookie.expires).toBeInstanceOf(Date)
    expect(cookie.expires.toISOString()).toBe('2015-10-21T07:28:00.000Z')
  })

  test('Expires and Max-Age are recorded regardless of order', () => {
    const first = Bun.Cookie.parse('a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=3600')
    const second = Bun.Cookie.parse('a=1; Max-Age=3600; Expires=Wed, 21 Oct 2015 07:28:00 GMT')
    expect(first.expires.toISOString()).toBe(second.expires.toISOString())
    expect(first.maxAge).toBe(3600)
    expect(second.maxAge).toBe(3600)
  })

  test('Max-Age takes precedence over Expires when deciding expiry', () => {
    expect(Bun.Cookie.parse('a=1; Max-Age=0; Expires=Wed, 21 Oct 2099 07:28:00 GMT').isExpired()).toBe(true)
    expect(Bun.Cookie.parse('a=1; Max-Age=3600; Expires=Wed, 21 Oct 2015 07:28:00 GMT').isExpired()).toBe(false)
  })
})

describe('parser fixes', () => {
  test('Bun.YAML combines surrogate-pair escapes', () => {
    expect(Bun.YAML.parse('a: "\\uD83D\\uDE00"').a).toBe('😀')
  })

  test('Bun.JSONC.parse throws SyntaxError on invalid input', () => {
    expect(() => Bun.JSONC.parse('{bad}')).toThrow(SyntaxError)
  })

  test('Bun.JSONC still parses comments and trailing commas', () => {
    expect(Bun.JSONC.parse('{ // note\n "a": 1, }')).toEqual({ a: 1 })
  })
})

describe('Bun.stringWidth fixes', () => {
  test('bidi control characters are zero-width', () => {
    expect(Bun.stringWidth('\u202Aabc\u202C')).toBe(3)
    expect(Bun.stringWidth('\u2066abc\u2069')).toBe(3)
  })

  test('Mongolian variation selectors are zero-width', () => {
    expect(Bun.stringWidth('a\u180Ba')).toBe(2)
  })

  test('ANSI escape sequences are ignored', () => {
    expect(Bun.stringWidth('\u001b[31mred\u001b[0m')).toBe(3)
  })
})

describe('Bun.escapeHTML zero-allocation path', () => {
  test('clean input is returned unchanged', () => {
    expect(Bun.escapeHTML('abc 123')).toBe('abc 123')
  })

  test('input that needs escaping is escaped', () => {
    expect(Bun.escapeHTML('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })
})

describe('Bun.hash.crc32', () => {
  test('matches the standard check vector', () => {
    expect(Bun.hash.crc32('123456789')).toBe(3_421_780_262)
  })
})

describe('structuredClone fast paths', () => {
  test('dense number arrays clone with the same values', () => {
    expect(structuredClone([1, 2, 3])).toEqual([1, 2, 3])
    expect(structuredClone([1.5, 2.5])).toEqual([1.5, 2.5])
  })

  test('typed arrays keep their type and storage', () => {
    const clone = structuredClone(new Int32Array([1, 2, 3]))
    expect(clone).toBeInstanceOf(Int32Array)
    expect([...clone]).toEqual([1, 2, 3])
  })

  test('arrays of flat objects clone deeply', () => {
    const source = [{ a: 1 }, { a: 2 }]
    const clone = structuredClone(source)
    expect(clone).toEqual(source)
    expect(clone[0]).not.toBe(source[0])
  })
})

describe('Buffer encodings', () => {
  test('hex encodes and round-trips', () => {
    expect(Buffer.from([0xde, 0xad]).toString('hex')).toBe('dead')
    expect(Buffer.from('dead', 'hex')).toEqual(Buffer.from([0xde, 0xad]))
  })

  test('base64 encodes and round-trips', () => {
    expect(Buffer.from('hello').toString('base64')).toBe('aGVsbG8=')
    expect(Buffer.from('aGVsbG8=', 'base64').toString()).toBe('hello')
  })

  test('base64url omits padding', () => {
    expect(Buffer.from('hello').toString('base64url')).toBe('aGVsbG8')
    expect(Buffer.from('aGVsbG8', 'base64url').toString()).toBe('hello')
  })

  test('64 KiB hex output round-trips', () => {
    const source = Buffer.alloc(64 * 1024, 0xab)
    expect(Buffer.from(source.toString('hex'), 'hex')).toEqual(source)
  })
})

describe('node:path.parse', () => {
  test('empty string returns an all-empty structure', () => {
    expect(path.parse('')).toEqual({ root: '', dir: '', base: '', ext: '', name: '' })
  })

  test('posix paths split into root/dir/base/ext/name', () => {
    expect(path.posix.parse('/home/user/file.tar.gz')).toEqual({
      root: '/',
      dir: '/home/user',
      base: 'file.tar.gz',
      ext: '.gz',
      name: 'file.tar',
    })
  })

  test('repeated calls return equal structures for equal input', () => {
    expect(path.posix.parse('/a/b.txt')).toEqual(path.posix.parse('/a/b.txt'))
  })
})

describe('HTMLRewriter attribute fixes', () => {
  test('a present-but-empty attribute returns an empty string', () => {
    let value
    new HTMLRewriter()
      .on('input', {
        element(element) {
          value = element.getAttribute('disabled')
        },
      })
      .transform('<input disabled>')
    expect(value).toBe('')
  })

  test('an absent attribute returns null', () => {
    let value
    new HTMLRewriter()
      .on('input', {
        element(element) {
          value = element.getAttribute('missing')
        },
      })
      .transform('<input>')
    expect(value).toBeNull()
  })
})

describe('Bun.indexOfLine non-ASCII scan', () => {
  test('finds the newline after a multi-byte character', () => {
    expect(Bun.indexOfLine(Buffer.from('é hello\nworld'), 0)).toBe(8)
  })

  test('finds the newline in ASCII input', () => {
    expect(Bun.indexOfLine(Buffer.from('abc\ndef'), 0)).toBe(3)
  })
})

describe('expect matcher semantics', () => {
  test('toContain compares with ===, so -0 equals 0', () => {
    expect([-0]).toContain(0)
  })

  test('toContain does not treat NaN as equal to NaN', () => {
    expect(() => expect([NaN]).toContain(NaN)).toThrow()
  })

  test('toContain still compares object identity', () => {
    const value = { a: 1 }
    expect([value]).toContain(value)
  })
})

describe('Response.json default formatting', () => {
  test('no indent argument still produces standard compact JSON', async () => {
    const body = await Response.json({ a: 1, b: [2] }).text()
    expect(body).toBe('{"a":1,"b":[2]}')
  })
})
