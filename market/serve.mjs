#!/usr/bin/env bun
/**
 * Serve the market directory over HTTP for a local preview:
 *   bun market/serve.mjs [port]
 * then add `http://127.0.0.1:<port>/index.json` in Plugins → Discover.
 *
 * DSH reads index sources from the network it runs in; a loopback URL is fine
 * only for a quick local check, and the listed install source must still be a
 * public npm package or public https Git repository.
 */

import { dirname, join, normalize, sep } from 'node:path'

const here = dirname(import.meta.path)
const port = Number(process.argv[2] ?? 4780)

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.json'
    const target = normalize(join(here, pathname))
    if (target !== here && !target.startsWith(`${here}${sep}`)) return new Response('forbidden', { status: 403 })
    const file = Bun.file(target)
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(file, { headers: { 'cache-control': 'no-store' } })
  },
})

console.log(`serving ${here}`)
console.log(`index: http://127.0.0.1:${server.port}/index.json`)
console.log(`icon:  http://127.0.0.1:${server.port}/icons/bun-native.svg`)
