# Bun native

A DeepSeek Harness bundle that teaches the agent to work with **Bun-native
projects**, built around the global API surface documented at
<https://bun.com/reference/globals/bun>.

It registers three Host tools and one short system-prompt section:

| Tool | Kind | What it does |
|---|---|---|
| `bun_project` | read-only | Classifies a directory (`bun-native` / `bun-capable` / `none`) with a `confidence` and an ordered `signals` list, and reports its lockfile (`bun.lock` text or legacy `bun.lockb`, plus any foreign lockfiles), `bunfig.toml` sections, `package.json` scripts and dependency counts, workspaces, TypeScript setup, `node_modules`/isolated-store state, and the installed Bun version. |
| `bun_api` | read-only | Answers from a bundled offline digest of the Bun globals (`Bun.serve`, `Bun.file`, `Bun.$`, `bun:sqlite`, `Bun.spawn`, hashing, compression, parsers, …) with signatures, examples and doc links — no network round-trip. |
| `bun_exec` | runs a process | Runs `bun run <script|file>`, `bun test`, `bun install` (with optional `filter` for one workspace member), `bun pm <utility>` (e.g. `ls --all`), or `bun --eval <code>` inside the session's sandbox policy, capped by a timeout, reporting stdout/stderr and the exit status. |

Detection follows the verified Bun 1.4 conventions, strongest first: `bun.lock`,
`bun.lockb`, `bunfig.toml`, `packageManager: bun@…`, a script that invokes
`bun`/`bunx`, `.bun-version`, `@types/bun`. A plain `package.json` (or a
`node_modules` tree) without any of those is only `bun-capable`.

The prompt section (`promptGuidance`) tells the agent to use `bun_project`
before assuming a toolchain, to prefer built-in Bun APIs over new
dependencies, and not to introduce npm/yarn/pnpm into a Bun-native project.

## Configuration

Set in the profile patch layer; every key is optional.

```yaml
- id: bun-native
  name: '@local/bun-native'
  config:
    bunPath: bun            # executable name or absolute path
    timeoutMs: 60000        # default per-call timeout, 1s-600s
    maxOutputChars: 20000   # per-stream character cap, 1000-400000
    promptGuidance: true    # add the Bun workflow section to the system prompt
```

Invalid values fail the plugin at activation with a message naming the key.
The bundle has no package dependencies, so there is nothing to install before
`plugin_manager` links it into the profile.

## Design notes

- **No package imports.** Workspace bundles are linked into the profile, not
  installed next to the Harness packages, so `index.js` uses Node builtins and
  the services reachable through `ctx` (`tools`, `fs`, `subprocess`, `sandbox`,
  `sandboxPolicy`, `workingDirectory`, `systemPrompt`). Config is validated in
  `apply` for the same reason rather than through a schemastery `Config` export.
- **Sandbox-aware execution.** `bun_exec` resolves the session's policy with
  `sandboxPolicy.resolve()`, wraps the argv with `sandbox.confine()` and spawns
  the confined argv, so a model-driven Bun process has the same file effects as
  any other command. `danger-full-access` sessions skip confinement, matching
  the host's own shell tools.
- **Bounded output.** Each stream is collected with a byte cap plus a spill
  file, then trimmed to `maxOutputChars`; truncation is reported in the result.
- **Timeouts terminate, they do not fail the call.** The result carries
  `timedOut`, `exitCode` and `signal`; only infrastructure failures throw.

## Alignment with Bun's workspace management

Bun's model (see
[`bun install` → Workspaces](https://bun.com/docs/pm/cli/install#workspaces) and
`bun pm --help` on 1.4.4): the **root** `package.json` declares `workspaces`, the
root owns the single `bun.lock`, members are resolved from any directory, and
workspace-targeted operations are `bun install --filter <pattern>` and
`bun --filter <pattern> <script>`. The plugin follows that model:

- `bun_project` walks **up to the workspace root** (up to 8 ancestors) when the
  inspected directory has no lockfile of its own. A member directory is then
  reported as `kind: "bun-native"`, `confidence: "strong"` (root lockfile),
  with a `workspace` record:
  `{ role: "member", root, patterns, memberPath, memberName, rootLockfile, catalog?, catalogs? }`
  (or `{ role: "root", root, patterns, … }` at the root). The misleading
  "this Bun project has no lockfile" note is suppressed for members, and the
  lockfile line names the root lockfile instead.
- **Workspace-protocol dependencies** are reported from every dependency group,
  e.g. `Workspace dependencies: greeting workspace:* (dependencies)`. Bun links
  those to the local member, and `bun publish` rewrites `workspace:*` to the
  member's declared version (verified through `bun pm pack`: the `web-0.1.0.tgz`
  manifest contained `"greeting": "0.2.0"`).
- **Linker** is reported for the root and for a member (resolved against the
  root): `isolated` / `hoisted` / `unknown`, with the evidence source (`bunfig`,
  `node_modules/.bun`, or `node_modules`).
- Recommended commands for a member are workspace-aware:
  `bun install --filter <member>`, `bun pm ls --all`, `bun install`.
- `bun_exec` operations that match Bun's CLI: `mode: "pm"` (forwards `args` to
  `bun pm`, e.g. `["ls", "--all"]`, `["hash"]`, `["bin"]`), `filter` with modes
  `run`/`test` (`bun --filter <pattern> <script>`) and `install`
  (`bun install --filter <pattern>`), and `mode: "add"` targeted with `cwd`
  (`bun add <spec>` under `bun --cwd`), because Bun has no `add --filter`.
- `workspaces` is read in both supported shapes (`string[]` and
  `{ "packages": [...] }`), and workspace `catalog`/`catalogs` keys are reported
  when the root declares them.

Verified against a real multi-glob fixture,
[examples/bun-workspace](examples/bun-workspace/package.json)
(`workspaces: ["packages/*", "apps/*"]`; `apps/web` depends on
`packages/greeting` via `workspace:*`; one committed `bun.lock`, isolated
linker):

| Check | Result |
|---|---|
| `bun_project` at the root | `Workspace: root of patterns packages/*, apps/*`, `bun.lock … lockfileVersion 2`, `node_modules present (isolated store node_modules/.bun)`, `Linker: isolated (from node_modules/.bun)`, recommends `bun ci`, `bun pm ls --all` |
| `bun_project` at `apps/web` | `bun-native (strong)`, signals `scripts:bun, workspace:member`, `Lockfile: none here — workspace root bun.lock …`, `Workspace: member \`web\` of … (patterns: packages/*, apps/*)`, `Workspace dependencies: greeting workspace:* (dependencies)`, recommends `bun install --filter web` |
| `bun_exec` `{ mode: "pm", args: ["ls", "--all"] }` | lists `greeting@workspace:packages\greeting`, `web@workspace:apps\web` |
| `bun_exec` `{ mode: "pm", args: ["hash"] }` | prints the lockfile hash (`B671A1374515D657-…`); `["bin"]` prints `node_modules\.bin` |
| `bun_exec` `{ mode: "install", filter: "web" }` | `Done! Checked 3 packages (no changes)` |
| `bun_exec` `{ mode: "run", target: "test" }` inside `apps/web` | runs the member's `bun:test` suite, 1 pass |

### Bun 1.4.4 notes the plugin encodes

- `bun --filter <pattern> run build` is **not** valid: the token after the
  pattern is the *script name*, so Bun answers `Script "run" not found`. The
  correct form is `bun --filter <pattern> build`; `bun run --filter` is not a
  flag at all.
- There is no `bun add --filter`; target a member with `bun add --cwd
  packages/web <spec>` and keep using `bun install --filter` for installs.
- The default linker is **isolated** for new workspaces/monorepos and hoisted
  for new single-package projects (and projects made before v1.3.2). Both were
  verified with `[install] linker` in a throwaway copy.
- `bun pm bin` prints the `node_modules/.bin` folder, not one binary; `bun pm`
  also has `pkg`, `cache` (`rm`, `prune`), `fetch`, `migrate`, `trust`,
  `untrusted`, `pack`, `licenses`, `why`, `diff`, `scan`, `hash-string` and
  `hash-print` — all reachable through `mode: "pm"`.
- Filtered script execution fails in this sandboxed session with `error: Failed
  to start process` (also with `--shell system`), while plain `bun run
  <script>` inside the member works. The plugin still builds the correct argv
  and surfaces Bun's error instead of hiding it; `bun install --filter` and
  workspace-only installs do work.
- `bun install` that needs the global cache (`~/.bun/install/cache`) is denied
  under `workspace-write` (EPERM) exactly like the host shell; `bun_exec` has no
  sandbox-escalation parameter.

## Verifying it

All four checks below were run in the desktop profile with the bundle installed
and active, not just against stubs:

1. `bun_project` on `examples/bun-demo` → `kind: "bun-native"`, `confidence:
   "strong"`, signals `bunfig.toml, scripts:bun`, runtime `Bun 1.4.4`, the
   `[install]`/`[test]` bunfig sections, and the four demo scripts.
   On a directory with no `package.json` and no Bun marker it reports
   `kind: "none"` with no recommended commands.
2. `bun_exec` `{ mode: "run", target: "test" }` in that directory → the
   `bun:test` suite runs (2 pass) with exit code 0; `bun_exec` `{ mode: "test" }`
   runs `bun test` directly.
3. `bun_api` `{ name: "Bun.serve" }` → signature, summary and a runnable
   example; `bun_api` with no arguments lists the 12 categories covering 69
   APIs; `{ query: "sqlite" }` returns `bun:sqlite Database` and `Bun.SQL`.
4. `bun_exec` `{ mode: "eval", code: "…" }` → prints `Bun 1.4.4` through the
   sandbox; `{ mode: "run", target: "start", timeoutMs: 3000 }` against the
   demo's blocking server prints its URL and then reports
   `[timed out after 3000ms]`; `{ mode: "run", target: "does-not-exist" }`
   reports `error: Script not found` with `[exit code: 1]` instead of failing
   the call.
5. `examples/bun-workspace` → the root/member behaviour in the workspace table
   above, including `bun pm ls --all`, `bun pm hash` and `bun install --filter
   web`. Run `bun install` in it once after cloning; the committed `bun.lock` is
   what detection reads.

A temporary `bun.lock` fixture was also inspected: it reported
`Lockfile: bun.lock (text, …) — lockfileVersion 2` and recommended `bun ci`.
`tools/smoke.mjs` is the pre-install harness used to exercise `apply()` and the
three tools against a stub context (`bun bun-native/tools/smoke.mjs`).

`examples/bun-demo` is intentionally dependency-free (no network needed to try
it), so its `tsconfig.json` asks for Bun types that are not installed; add them
with `bun add -d @types/bun` before running `bun check` in it. Note that in Bun
1.4.x `bun check` is the native type checker but a `package.json` script named
`check` shadows it.

## Plugin market index

The repository publishes this bundle through a **format‑1 DSH plugin market
index** in `market/` (a sibling of this package, not part of the installed
bundle):

- index URL:
  `https://raw.githubusercontent.com/brendadeeznuts1111/dsh-bun-native/main/market/index.json`
- register it in **Plugins → Discover → Add index source** (enable
  **Custom plugin indexes** first), then install the `Bun native` card.

The index pins the install source to a Git commit
(`git+https://github.com/brendadeeznuts1111/dsh-bun-native.git#<commit>&path:/bun-native`)
and declares `engines.dsh` from this manifest. `market/build-index.mjs`
regenerates it, `market/validate-index.mjs` is a port of DSH's own format‑1
validator, and `market/README.md` documents the release procedure and rules.

## Catalog data

`data/bun-globals.json` is an offline digest of
<https://bun.com/reference/globals/bun>, keyed to the installed Bun 1.4.x
surface. Regenerate it after a Bun upgrade: names are enumerable from the
runtime (`bun -e "console.log(Object.getOwnPropertyNames(Bun))"`), while
signatures, summaries and examples come from the reference pages.
