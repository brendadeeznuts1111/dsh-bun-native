# Bun native

A DeepSeek Harness bundle that teaches the agent to work with **Bun-native
projects**, built around the global API surface documented at
<https://bun.com/reference/globals/bun>.

It registers four Host tools, a read-only dashboard endpoint and one short
system-prompt section:

| Tool | Kind | What it does |
|---|---|---|
| `bun_project` | read-only | Classifies a directory (`bun-native` / `bun-capable` / `none`) with a `confidence` and an ordered `signals` list, and reports its lockfile (`bun.lock` text or legacy `bun.lockb`, plus any foreign lockfiles), `bunfig.toml` sections, `package.json` scripts and dependency counts, workspaces, TypeScript setup, `node_modules`/isolated-store state, and the installed Bun version. |
| `bun_api` | read-only | Answers from a bundled offline digest of the Bun globals (`Bun.serve`, `Bun.file`, `Bun.$`, `bun:sqlite`, `Bun.spawn`, hashing, compression, parsers, …) with signatures, examples and doc links — no network round-trip. |
| `bun_exec` | runs a process | Runs a package.json script or file (`bun run`), `bun test`, `bun install` (with optional `filter`), `bun add`, `bun ci`, `bun check`, `bun lint`, `bun pm <utility>` or `bun --eval <code>` inside the session's sandbox policy, capped by a timeout, reporting stdout/stderr and the exit status. |
| `bun_doctor` | read-only | Runs a health report: a probe inside the project's Bun (version, platform, native APIs, `node:url` compatibility), project checks (classification, lockfile, workspace, linker, package manifest), catalog agreement (curated names resolve on this runtime plus coverage), and optionally the project's `bun:test` suite. |
| `bun_api` | read-only | Answers from the curated offline digest of Bun globals (70 entries over the runtime's 117 name-level `Bun` globals on 1.4.4; the rest are listed by `validate-catalog`), with signatures, examples and doc links — no network round-trip. |

The dashboard endpoint (`/api/bun-native/status`, owner-only) returns a cheap
doctor snapshot for a UI page without running tests.

Detection follows the verified Bun 1.4 conventions, strongest first: `bun.lock`,
`bun.lockb`, `bunfig.toml`, `packageManager: bun@…`, a script that invokes
`bun`/`bunx`, `.bun-version`, `@types/bun`. A plain `package.json` (or a
`node_modules` tree) without any of those is only `bun-capable`.

The prompt section (`promptGuidance`) tells the agent to use `bun_project`
before assuming a toolchain, to prefer built-in Bun APIs over new
dependencies, and not to introduce npm/yarn/pnpm into a Bun-native project. It
also points at the Bun docs MCP tools when the companion bundle is installed.

## Live Bun docs via MCP

The companion bundle `@local/bun-docs-mcp` connects Bun's official docs MCP
server at <https://bun.com/docs/mcp> and adds four read-only tools:
`mcp__bun_docs__search_bun`, `read_bun_page`, `list_bun_pages` and `grep_bun`
(plus the `bun://skill` resource).

`bun_api` keeps working offline for global API signatures; the MCP server is the
live source for guides, blog posts and full pages. `bun_api`'s no-match output
and the prompt section point at the MCP tools when they are present. Install
both cards from the market index, or install `bun-docs-mcp/` directly.

## Linting

`bun_exec` mode `lint` forwards to `bun lint` — useful for `--explain <rule>`,
`--rules`, `--fix`, `--type-aware`, `--staged` and `--changed`:

```json
{ "mode": "lint", "args": ["--explain", "prefer-const"] }
```

Bun 1.4.4 does not ship the built-in linter yet: `bun lint` resolves to a
package script and reports `error: Script not found "lint"`. Bun's docs describe
the linter and its 1,000+ rules, so the mode surfaces Bun's own error until the
runtime supports it.

Canary `1.4.4-canary.1+b1305ddc7` does ship it: `--rules -f json` returns 1,048
rules, `--explain` prints rule docs, and `--fix`, `--format json`, `--doctor`,
`--init`, `--staged` and type-aware rules were verified end-to-end through this
mode; see the research notes for the matrix.

## Type checking

`bun_exec` mode `check` runs the built-in type checker:

```json
{ "mode": "check", "target": "src", "args": ["--no-script"] }
```

`target` is a file or directory (`bun check src`); `args` carries flags such as
`["--no-script"]`, `["-p", "packages/server"]`, `["-b"]`, `["--all"]` or
`["--no-pretty"]`. A `package.json` `check` script shadows the type checker
(`bun check` runs the script); `--no-script` forces the checker. `bun check`
writes nothing — use `bun build`/`tsc` for emitted files. The separate
`bun --check` / `bun test --check` / `bun build --check` pre-run checks are a
different command.

## Dashboard

The bundle also ships a browser half (`client.js`) that registers a **Bun native**
page in Settings (`settings.section`, id `bun-native`, order 25). Opening it
fetches `GET /api/bun-native/status` and renders four cards:

| Card | Contents |
|---|---|
| Project | classification + confidence, directory, lockfile, linker, workspace root/member, scripts, signals |
| Bun runtime | version, platform/arch, and the result of the native-properties probe (12 required APIs, plus a separate `node:url` compatibility check) |
| API catalog | API and category counts, coverage bar against the running runtime, catalog/runtime version agreement, link to the Bun globals reference |
| Health checks | the `bun_doctor` pass/warn/fail checks with their details |

A **Refresh** button re-reads the endpoint; the page is read-only, so every
state-changing action remains a normal tool call. Text is registered through the
Client locale service (English and Chinese dictionaries), styles use only
`--dsw-alias-*` theme tokens, and the endpoint refuses non-owner peers. When the
workspace root is not itself a Bun project the Host picks the first child with
Bun markers (lockfile, `bunfig.toml`, or a Bun script) so the page describes the
project under the session's workspace.

## Tests

```sh
bun run test         # bun test ./test — 155 tests in five files
bun run smoke        # tools/smoke.mjs — stub-context harness for apply() and all tools
bun run catalog      # tools/validate-catalog.mjs — catalog against the running Bun
bun run verify:claims # tools/verify-claims.mjs — re-settle the README's Bun CLI/serve/node:url claims
```

`test/plugin.test.ts` covers configuration parsing, the `workspace:`/`bunfig`/
lockfile helpers, `rankApis`, the catalog (version match, unique names, every
`Bun.*` entry exists on the runtime, every example transpiles, the verified
`Bun.ModuleGraph` surface), project classification for the demo and the
workspace member, detection confidence rules (mixed lockfiles, unmatched
workspace globs, the ancestor cap), `bun_doctor` reports (passing probe, missing
native properties, failing `bun:test`), the dashboard snapshot's project
discovery, the catalog-version drift warning, and registration of the four tools
+ prompt section + status route.

`test/serve-properties.test.ts` keeps the four `Bun.serve` property domains in
**separate suites**, so a failure names the domain it belongs to:

| Suite | Properties asserted |
|---|---|
| `URL properties` | `server.url` is a `URL`; `href` is `http://host:port/`; `toString()` equals `href`; `origin` is protocol+host without a path; `pathname` is `/` and `search` empty; `host` is `hostname:port` |
| `protocol properties` | `server.protocol === "http"` (bare, no colon); `server.url.protocol === "http:"` (WHATWG, colon); the two differ only by the colon; `Server.protocol` exists |
| `hostname properties` | defaults to `localhost`; equals `url.hostname`; explicit `127.0.0.1` bind reflected in both; hostname appears in `url.origin` |
| `port properties` | `server.port` is an allocated integer 1–65535; `url.port` is its decimal string; origin ends with `:port`; port 70000 is rejected; two ephemeral servers get distinct ports |

`test/node-url-properties.test.ts` covers Bun's **"Fully supported — Fully
implemented"** claim for [`node:url`](https://bun.com/reference/node/url), again
one suite per property domain:

| Suite | Properties asserted |
|---|---|
| `module surface` | exports exactly the 14 Node-documented members (`URL`, `URLPattern`, `URLSearchParams`, `Url`, `domainToASCII`, `domainToUnicode`, `fileURLToPath`, `fileURLToPathBuffer`, `format`, `parse`, `pathToFileURL`, `resolve`, `resolveObject`, `urlToHttpOptions`); `URL`/`URLSearchParams` are the globals; every documented function is callable |
| `URL properties` | `protocol`, `hostname`, `port`, `pathname`, `search`, `hash`, `origin`, `username`, `password`, `href` on a WHATWG URL |
| `URLSearchParams properties` | `size`, `getAll`, `has`, `append`, `set`, `delete`, `sort`, `toString` encoding, `entries`/`keys`/`values`, `forEach` |
| `legacy parse properties` | `protocol`, `slashes`, `auth`, `host`, `hostname`, `port`, `pathname`, `search`, `query`, `hash`, `path`, `href`, `parseQueryString` object form, invalid input encoded into `pathname` |
| `legacy format properties` | `format(parse(url))` round-trip; object `protocol`/`hostname`/`port`/`pathname`, object query, `auth`, `hash` |
| `legacy resolve properties` | last-segment replacement, dot segments, absolute reference wins, `resolveObject` components |
| `file URL properties` | `pathToFileURL` produces `file:` + encoded spaces; `fileURLToPath` round-trips and decodes; `fileURLToPathBuffer` returns the path bytes; non-file scheme rejects |
| `domain properties` | `domainToASCII`/`domainToUnicode` round-trip; invalid domains return `""`/unchanged |
| `URL-to-HTTP-options properties` | `protocol`, `hostname`, numeric `port`, `path`, `auth`, `hash`/`search`, `href` |

`test/bun-1.4.4-regressions.test.ts` keeps Bun 1.4.4's release-note fixes
traceable. Timings from the notes are **not** reproduced; the suites assert the
behaviour each fix promises, plus two deliberately generous O(N²)-regression
budgets:

| Suite | Asserted |
|---|---|
| `URL.searchParams.append laziness` | 4000 appends under 250 ms (observed ~2 ms) and `href` reflects the last value; detached `URLSearchParams` within budget |
| `Bun.Glob brace groups` | nested brace alternatives match; literal dotfile segment matches without `dot: true` |
| `Bun.color fixes` | 24-bit number is opaque (`rgba(255, 0, 0, 1)`); ansi-16 emits printable digits; ansi-256 grey stays 232–255; `hsl`/`lab` outputs are parseable |
| `Bun.Cookie RFC 6265 fixes` | `Expires` parses to the correct instant; `Expires`/`Max-Age` recorded in either order; `Max-Age` wins in `isExpired()` |
| `parser fixes` | `Bun.YAML` combines surrogate-pair escapes; `Bun.JSONC.parse` throws `SyntaxError` on bad input and still accepts comments/trailing commas |
| `Bun.stringWidth fixes` | bidi controls and Mongolian variation selectors are zero width; ANSI escapes ignored |
| `Bun.escapeHTML zero-allocation path` | clean input returned unchanged; markup escaped exactly |
| `Bun.hash.crc32` | standard check vector `crc32("123456789") === 0xCBF43926` |
| `structuredClone fast paths` | dense number arrays, typed arrays and arrays of flat objects clone correctly and deeply |
| `Buffer encodings` | hex/base64/base64url correctness and round-trips, including 64 KiB hex |
| `node:path.parse` | empty string → all-empty structure; posix split; equal inputs → equal results |
| `HTMLRewriter attribute fixes` | present-but-empty attribute → `""`; absent → `null` |
| `Bun.indexOfLine non-ASCII scan` | newline after a multi-byte character found at the correct byte offset; ASCII case |
| `expect matcher semantics` | `toContain` uses `===`: `[-0]` contains `0`, `[NaN]` does not contain `NaN`, identity still works |
| `Response.json default formatting` | compact JSON output with no indent argument |

`test/yaml-cyclic-anchors.test.ts` covers the Bun 1.4 announcement card
(`yaml-cyclic-anchors.jpg`): **`Bun.YAML.parse` supports cyclic anchors &
aliases**. The tweet example from the card resolves its `quote_tweet: *tweet`
alias to the same object, so `tweet.quote_tweet === tweet` and the chained
`tweet.quote_tweet.quote_tweet.quote_tweet.text` returns the block scalar.
Suites stay separate:

| Suite | Asserted |
|---|---|
| `Bun.YAML cyclic map anchors` | self-aliased tweet identity; chained traversal; exactly the two keys |
| `Bun.YAML anchor and alias identity` | aliased mappings/sequences are the same object; scalar aliases carry the value |
| `Bun.YAML merge keys` | `<<: *base` copies properties without sharing identity |
| `Bun.YAML cyclic arrays` | an anchored sequence including its own alias is self-referential |
| `Bun.YAML stringify cycles` | a cycle serializes as `&root`/`*root`; `parse(stringify(cycle))` restores the self reference for objects and arrays |
| `Bun.YAML stringify plain values` | plain values round-trip |
| `catalog documents cyclic anchors` | the `Bun.YAML` digest summary names cyclic anchors |

`research/bun-1.4.4-release-notes.md` is the traceability table: every verified
claim, every performance item deliberately left to Bun's own benchmarks, and the
API gotchas found while writing the tests.

`tools/verify-claims.mjs` runs the disputed Bun CLI forms against the installed
Bun in a throwaway workspace copy and fails when the prose no longer matches:
`--filter` forms and their exact errors, `bun add --cwd`, the `bun pm hash`
family, and `bun pm bin`. It repeats the same **four property domains as
separate labelled checks** (`URL property — …`, `protocol property — …`,
`hostname property — …`, `port property — …`), plus the server-behaviour checks
(handler round-trips, `stop()` closes the listener) and the `Bun.serve` example
from `data/bun-globals.json` executing as written. It also checks `node:url` per
domain against the installed Node.js when that binary is available: export
surface parity, the WHATWG class identity, URL/URLSearchParams/legacy
parse/format/resolve/file URL/domain/HTTP-options properties, each as its own
labelled check. Its output is also the source for the claims section below.

`tools/validate-catalog.mjs --json <path>` writes a machine-readable catalog
report (`curated`, `uncovered`, `missingOnRuntime`, per-category counts,
runtime/catalog versions, error count) — the feed a catalog governor can consume
instead of maintaining a second list.

## Automation

`bun_doctor` is the automation primitive: it returns a pass/warn/fail report and
never throws for a failing project, so a scheduled task can run it and report
deltas. A typical recipe, expressed with the schedules tool:

> Every Monday at 09:00 in this workspace: run `bun_doctor` with `runTests: true`
> and report every `fail` or new `warn` since the previous run.

`bun_exec` supports the CI-side steps the same prompt may need: `mode: "ci"`
(`bun ci`), `mode: "lint"` (`bun lint`, awaiting the 1.4 linter), `bun test`,
`bun build` and workspace-filtered installs. The dashboard stays read-only and
does not run tests on open, so automation cost stays in the scheduled task.

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
- **Bounded output.** Each stream is collected with a byte cap and a provider
  spill file, then trimmed to `maxOutputChars`; truncation is reported. The
  result's `spillPath` (when present) names the complete stream the subprocess
  provider wrote — the plugin neither chooses that directory nor deletes the
  file; retention belongs to the Host's spill policy.
- **Timeouts terminate, they do not fail the call.** The result carries
  `timedOut`, `exitCode` and `signal`; only infrastructure failures throw.
- **Detection confidence is explicit, not implied.** A `bun.lock`/`bun.lockb`
  next to another package manager's lockfile adds a `mixed-lockfiles` signal and
  lowers strong confidence to medium (the repo is not Bun-only, so
  `promptGuidance` must not forbid npm/yarn outright). A directory counts as a
  workspace member only when its `memberPath` matches the root's declared globs
  (`*`, `**`, `?`, leading `!`); otherwise it gets a "not matched" note instead
  of a false membership. The 8-ancestor cap is also a note ("root not found
  within 8 ancestors"), never a silent "no lockfile".
- **The catalog is pinned and says so.** `data/bun-globals.json` carries
  `bunVersion`; `bun_api` compares it with the workspace runtime (cached
  `bun --version`) and prepends a warning to every answer when they differ,
  rather than serving stale signatures with full confidence.
- **`bun pm` is a pass-through.** Read-only utilities (`ls`, `why`, `bin`,
  `hash`, `hash-string`, `hash-print`, `licenses`, `outdated`, `whoami`) are the
  expected agent use; mutating ones (`cache rm`/`prune`, `migrate`, `trust`,
  `pack`, `pkg set`, `version`) are allowed and run confined like any other
  `bun_exec` call, so each one is an audited tool call rather than a hidden
  side effect.

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
  (or `{ role: "root", root, patterns, … }` at the root). A directory is only a
  member when its `memberPath` matches the declared globs; the walk stops at 8
  ancestors and reports that cap in `notes` instead of silently reporting "no
  lockfile". The misleading "this Bun project has no lockfile" note is suppressed
  for members, and the lockfile line names the root lockfile instead.
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
| `bun_project` at `apps/web` | `bun-native (strong)`, signals `scripts:bun, workspace:member`, `Lockfile: none here — workspace root bun.lock …`, `Workspace: member web of … (patterns: packages/*, apps/*)`, `Workspace dependencies: greeting workspace:* (dependencies)`, recommends `bun install --filter web` |
| `bun_exec` `{ mode: "pm", args: ["ls", "--all"] }` | lists `greeting@workspace:packages/greeting`, `web@workspace:apps/web` |
| `bun_exec` `{ mode: "pm", args: ["hash"] }` | prints the lockfile hash (`B671A1374515D657-…`); `["bin"]` prints `node_modules/.bin` |
| `bun_exec` `{ mode: "install", filter: "web" }` | `Done! Checked 3 packages (no changes)` |
| `bun_exec` `{ mode: "run", target: "test" }` inside `apps/web` | runs the member's `bun:test` suite, 1 pass |

### Bun 1.4.4 notes the plugin encodes

Every claim below is re-checked by `bun run verify:claims` (`tools/verify-claims.mjs`)
against the installed Bun, in a throwaway copy of `examples/bun-workspace`.

- Targeted scripts: **both** `bun --filter <pattern> <script>` and
  `bun run --filter <pattern> <script>` are real 1.4.4 forms and run the member
  script (exit 0, tests pass) once the workspace is installed. The invalid form
  is `bun --filter <pattern> run <script>`: the token after the pattern is the
  *script name*, so Bun answers `error: Script "run" not found`.
- Filtered execution needs the workspace installed: with the root's
  `node_modules`/workspace links absent, both valid forms fail with
  `error: Failed to start process`; after `bun install` they succeed. The plugin
  passes the argv through and surfaces Bun's error, so the failure is visible.
- There is no `bun add --filter`. Target a member with
  `bun add --cwd <dir> <spec>` (verified: writes into that member's
  `package.json`). The global form is invalid: `bun --cwd <dir> add …` treats
  `add` as a script and fails with `error: Script not found "add"`.
- The default linker is **isolated** for new workspaces/monorepos and hoisted for
  new single-package projects (and projects made before v1.3.2). Both were
  verified with `[install] linker` in a throwaway copy.
- `bun pm hash`, `bun pm hash-string`, `bun pm hash-print` and `bun pm bin` all
  exist on 1.4.4: `hash` prints the lockfile hash, `hash-string` the hashed text
  with its marker lines, `hash-print` the checksum stored in `bun.lock`, and
  `bin` the `node_modules/.bin` folder path. `bun pm` also has `pkg`, `cache`
  (`rm`, `prune`), `fetch`, `migrate`, `trust`, `untrusted`, `pack`, `licenses`,
  `why`, `diff`, `scan` — all reachable through `mode: "pm"`.
- `Bun.serve` returns a `Server` whose `url` is a `URL` (`protocol === "http:"`
  without TLS, `port`/`hostname` agreeing with `server.port`/`server.hostname`),
  plus a separate `server.protocol` property whose value is `"http"` — without
  the colon, unlike `server.url.protocol`. These are asserted by
  `bun run verify:claims`, together with a live handler round-trip and
  `server.stop()` closing the listener.
- `bun install` that needs the global cache (`~/.bun/install/cache`) is denied
  under `workspace-write` (EPERM) exactly like the host shell; workspace-only
  installs do work. `bun_exec` has no sandbox-escalation parameter.

### Bun 1.4.4 install and registry notes

The 1.4.4 release carried a large batch of install and registry fixes. These are
the ones that change how `bun_exec` installs behave or how the agent should read
a monorepo's dependency state:

- **`bun outdated` and `bun update -i` fail honestly.** `bun outdated` exits 1
  with `error: … downloading package manifest …` when a manifest cannot be
  fetched (it used to print an empty table and exit 0), and `bun update -i`
  refuses to start without a TTY, pointing at `bun update` / `bun outdated`
  instead of hanging.
- **Registry credentials are sent again.** A registry URL with embedded
  credentials is sent as an `Authorization` header, whether it came from
  `--registry`, `BUN_CONFIG_REGISTRY`, `npm_config_registry`, or bunfig
  `[install] registry = { url = … }`; 1.3 had dropped them.
- **`.npmrc` parsing improved.** Quoted values expand environment variables
  (`registry = "${NPM_REGISTRY}"`), `${VAR?}` is the optional form, the `email`
  field is read for registries that require it, and `$HOME/.npmrc` is read when
  `XDG_CONFIG_HOME` is set but holds no `.npmrc`.
- **Frozen installs respect scoped registries** from bunfig when the lockfile
  entry has an empty registry URL.
- **Git installs are atomic and deduplicated.** A git dependency is cloned into
  a staging directory and moved into the cache only when the clone completes;
  the same repository via different protocols resolves correctly, GitHub
  custom-protocol URLs take the tarball path, and cold-cache installs cover
  every branch. `bun patch` now handles git and tarball dependencies.
- **Lockfiles stay text and stay smaller.** npm/yarn/pnpm migration writes
  `bun.lock` even when it fails partway, and packages reachable only through an
  optional peer's resolution slot are dropped.
- **Optional peers resolve to an installed copy** when one exists, removing
  duplicates under `node_modules/.bun` in monorepos.
- **Packing follows npm.** `bun pm pack` always includes `bin`/`directories.bin`
  files even when `files` excludes them; `bun pm pack` and `bun publish` re-read
  `package.json` after `prepublishOnly`/`prepack`/`prepare`, so lifecycle version
  bumps land in the tarball name and registry metadata.
- **Fewer crashes.** Rare crashes in `bun install`, `bun add`, `bun pm ls`,
  `bun pm patch`, and `bun update --interactive` are fixed, including registry
  request retries, `.npmrc` CA handling, local tarball resolution, git specifier
  parsing, package names, and lifecycle script filtering.
- **Smaller CLI fixes.** `bunx @scope/name` resolves the scoped package;
  `bun init` falls back to `-y` when stdin is not a TTY; `bun install` falls
  back to copying when a cache hardlink fails with `EACCES`/`EPERM`;
  `BUN_DISABLE_SLOW_FILESYSTEM_WARNING=1` silences the slow-filesystem notice;
  the isolated linker fails fast on bad integrity or error-tarball responses and
  gives a self-dependency its self-link. Long version labels (a tarball or
  `file:` spec, or a workspace's own version) work in the hoisted linker and
  with `bun patch`/`patchedDependencies`.

Verified locally on 1.4.4 (Windows, workspace sandbox): `bun outdated` against an unreachable registry exited 1
with `error: ConnectionRefused downloading package manifest is-odd`; a project
`.npmrc` with `registry="${PROBE_REGISTRY}"` used the environment-provided
registry; a local registry received `Authorization: Basic …` from a URL with
`user:pass@`; `bun pm pack` included `bin/cli.js` despite `files: ["index.js"]`;
a `prepack` version bump produced `pack-prepack-probe-1.0.1.tgz`; without a
TTY, `bun update -i` exited 1 and `bun init` created the project. The
remaining claims above come from the 1.4.4 release notes and were not
independently re-run here.

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
   example; `bun_api` with no arguments lists the 12 categories covering 70
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

The repository publishes this bundle **and the companion `@local/bun-docs-mcp`
bundle** through a **format‑1 DSH plugin market index** in `market/` (a sibling
of this package, not part of the installed bundle):

- index URL:
  `https://raw.githubusercontent.com/brendadeeznuts1111/dsh-bun-native/main/market/index.json`
- register it in **Plugins → Discover → Add index source** (enable
  **Custom plugin indexes** first), then install the `Bun native` and
  `Bun docs MCP` cards.

Each card pins its install source to the same Git commit
(`git+…#<commit>&path:/bun-native` and `…&path:/bun-docs-mcp`) and declares
`engines.dsh` from its manifest. `market/build-index.mjs` regenerates the
two-plugin index, `market/validate-index.mjs` is a port of DSH's own format‑1
validator, and `market/README.md` documents the release procedure and rules.

## Catalog data

`data/bun-globals.json` is a curated offline digest of
<https://bun.com/reference/globals/bun>, keyed to the installed Bun 1.4.x
surface. It holds **70 entries in 12 categories: 69 name-level `Bun` members
plus `bun:sqlite Database`**; on Bun 1.4.4 `Object.getOwnPropertyNames(Bun)`
reports 117 names, so **48 are not curated yet** and `tools/validate-catalog.mjs`
lists them (and can fail the check if a curated name disappears). Regenerate it
after a Bun upgrade: names are enumerable from the runtime
(`bun -e "console.log(Object.getOwnPropertyNames(Bun))"`), while signatures,
summaries and examples come from the reference pages. The digest is not a
complete API reference: members and methods inside a curated namespace are not
individually enumerated, and `bun_api` warns when the runtime version differs
from `data/bun-globals.json`'s `bunVersion` (`tools/validate-catalog.mjs` catches
the same drift).
