# dsh-bun-native

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin market for **Bun-native projects** and **live Bun documentation**, plus
the format‑1 plugin market index that publishes both bundles to DSH's Discover
tab.

```
bun-native/   @local/bun-native   — project tools, offline digest, doctor
bun-docs-mcp/ @local/bun-docs-mcp — Bun's docs MCP server as read-only tools
market/       the format-1 plugin market index + its build/validate tooling
```

## What the bundles add

### `@local/bun-native`

| Tool | Kind | Behaviour |
|---|---|---|
| `bun_project` | read-only | Classifies a directory (`bun-native` / `bun-capable` / `none`) with confidence and ordered signals; reports lockfile kind and version, `bunfig.toml` sections, scripts, workspace root/member relationship, `workspace:` protocol dependencies, linker strategy, and the live Bun version. |
| `bun_api` | read-only | Offline digest of the Bun global API surface (70 APIs, 12 categories) keyed to Bun 1.4.4, with signatures, examples and docs links — no network round-trip. |
| `bun_exec` | runs a process | `bun run`, `bun test`, `bun install` (with `--filter`), `bun add`, `bun ci`, `bun pm`, and `bun --eval`, inside the session sandbox with bounded output and timeout termination. |
| `bun_doctor` | read-only | Runtime probe, project health, catalog agreement and optionally the project's `bun:test` suite; returns a pass/warn/fail report instead of throwing. |

It also exposes a read-only dashboard endpoint (`/api/bun-native/status`,
owner-only) with the cheap doctor snapshot, contributes a short system-prompt
section that tells the agent to read the project before assuming a toolchain and
to prefer built-in Bun APIs over new dependencies, and ships a browser half that
renders the dashboard as a **Bun native** page in Settings (project, runtime
properties, catalog coverage and doctor checks, with a refresh button; English
and Chinese, theme tokens only).

`bun_doctor` is also the automation primitive: a scheduled task can ask the agent
to run it (optionally with `runTests: true`) and report new failures or warnings;
`bun_exec` covers the matching steps (`ci`, `lint`, `test`, `build`, filtered
installs).

### `@local/bun-docs-mcp`

Connects Bun's official documentation MCP server at
<https://bun.com/docs/mcp> and adds four read-only tools:

| Tool | What it does |
|---|---|
| `mcp__bun_docs__search_bun` | Ranked sections across bun.com docs, guides and blog. |
| `mcp__bun_docs__read_bun_page` | Full markdown of one page by site path or URL. |
| `mcp__bun_docs__list_bun_pages` | List pages under a path prefix. |
| `mcp__bun_docs__grep_bun` | Regex search over page markdown. |

The `bun://skill` resource is a short Bun primer plus a guide to the tools. The
server is read-only, scoped to bun.com, holds no session state, and requires no
credentials. `bun_api` keeps the offline digest useful when the MCP server is
not installed or unreachable.

## Install from the market index

The index lives at:

```
https://raw.githubusercontent.com/brendadeeznuts1111/dsh-bun-native/main/market/index.json
```

1. Plugins → **Experimental plugins** → enable **Custom plugin indexes**.
2. **Discover** → **Add index source** → paste the URL.
3. Install the **Bun native** and/or **Bun docs MCP** card; the confirmation
   shows the pinned Git source.

The listed versions install from
`git+https://github.com/brendadeeznuts1111/dsh-bun-native.git#<commit>&path:/bun-native`
and `…&path:/bun-docs-mcp`.

## Install from this repository directly

`plugin_manager` accepts a package directory or a Git spec:

```
git+https://github.com/brendadeeznuts1111/dsh-bun-native.git#<commit>&path:/bun-native
git+https://github.com/brendadeeznuts1111/dsh-bun-native.git#<commit>&path:/bun-docs-mcp
```

## The market index

`market/` holds the index DSH reads and the tooling that keeps it honest:

```sh
bun market/build-index.mjs --commit <40-hex-sha>   # regenerate index.json for both bundles
bun market/validate-index.mjs market/index.json   # port of DSH's own validator
bun market/serve.mjs                              # loopback preview
```

See [market/README.md](market/README.md) for the format rules, the exact source
pinning, and the two-phase release procedure.

## Verification

- `bun-native/examples/bun-demo` — a dependency-free Bun project with a `bunfig.toml`, `bun:test` suite and a `Bun.serve` entry point.
- `bun-native/examples/bun-workspace` — a multi-glob Bun workspace (`packages/*`, `apps/*`, `workspace:*` dependencies, one committed `bun.lock`).
- `bun-native/tools/smoke.mjs` — exercises `apply()`, all four tools, the prompt section (including the Bun docs MCP pointer) and the doctor report against a stub Cordis context.
- `bun-native/test/plugin.test.ts` — `bun test ./test`: 16 Bun-native property and behaviour tests (catalog names exist on the runtime, examples transpile, workspace classification, doctor pass/fail reports, dashboard discovery, registration of tools/prompt/route).
- `bun-native/tools/validate-catalog.mjs` — checks every catalog entry against the running Bun and reports the globals not curated yet.
- `bun-docs-mcp` — a live `initialize` + `search_bun` call against <https://bun.com/docs/mcp> returns bun.com results; the server advertises the four tools and `bun://skill`.

## Licence

No licence is granted by this repository; the code is published for inspection
and personal installation. The bundles are unsigned third-party code — review
the index source and the pinned commit before installing.
