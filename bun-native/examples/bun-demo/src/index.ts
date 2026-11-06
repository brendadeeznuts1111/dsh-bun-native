const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ ok: true, bun: Bun.version })
    return new Response('hello from bun-demo\n')
  },
})

console.log(`bun-demo listening on ${server.url.href}`)
