# dsh-bun-native

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin
bundle for **Bun-native projects**, plus the format‑1 plugin market index that
publishes it to DSH's Discover tab.

```
bun-native/   the DSH bundle (@local/bun-native)
market/       the format-1 plugin market index + its build/validate tooling
```

## What the bundle adds

| Tool | Kind | Behaviour |
|---|---|---|
| `bun_project` | read-only | Classifies a directory (`bun-native` / `bun-capable` / `none`) with confidence and ordered signals; reports lockfile kind and version, `bunfig.toml` sections, scripts, workspace root/member relationship, `workspace:` protocol dependencies, linker strategy, and the live Bun version. |
| `bun_api` | read-only | Offline digest of the Bun global API surface (69 APIs, 12 categories) keyed to Bun 1.4.4, with signatures, examples and docs links — no network round-trip. |
| `bun_exec` | runs a process | `bun run`, `bun test`, `bun install` (with `--filter`), `bun add`, `bun pm`, and `bun --eval`, inside the session sandbox with bounded output and timeout termination. |

It also contributes a short system-prompt section that tells the agent to read
the project before assuming a toolchain, and to prefer built-in Bun APIs over
new dependencies.

## Install from the market index

The index lives at:

```
https://raw.githubusercontent.com/brendadeeznuts1111/dsh-bun-native/main/market/index.json
```

1. Plugins → **Experimental plugins** → enable **Custom plugin indexes**.
2. **Discover** → **Add index source** → paste the URL.
3. Install `Bun native`; the confirmation shows the pinned Git source.

The listed version is installed as
`git+https://github.com/brendadeeznuts1111/dsh-bun-native.git#<commit>&path:/bun-native`.

## Install from this repository directly

`plugin_manager` accepts the package directory (`bun-native/`) or a Git spec:

```
git+https://github.com/brendadeeznuts1111/dsh-bun-native.git#<commit>&path:/bun-native
```

## The market index

`market/` holds the index DSH reads and the tooling that keeps it honest:

```sh
bun market/build-index.mjs --commit <40-hex-sha>   # regenerate index.json
bun market/validate-index.mjs market/index.json   # port of DSH's own validator
bun market/serve.mjs                              # loopback preview
```

See [market/README.md](market/README.md) for the format rules, the exact source
pinning, and the release procedure.

## Verification

- `bun-native/examples/bun-demo` — a dependency-free Bun project with a `bunfig.toml`, `bun:test` suite and a `Bun.serve` entry point.
- `bun-native/examples/bun-workspace` — a multi-glob Bun workspace (`packages/*`, `apps/*`,
  `workspace:*` dependencies, one committed `bun.lock`) used to verify workspace-root
  resolution, linker and `bun pm` behaviour.
- The pre-install harness `bun-native/tools/smoke.mjs` exercises `apply()` and all three
  tools against a stub Cordis context; see `bun-native/README.md`.

## Licence

No licence is granted by this repository; the code is published for inspection
and personal installation. The bundle is unsigned third-party code — review the
index source and the pinned commit before installing.
