# Plugin market index

This directory publishes two bundles from
<https://github.com/brendadeeznuts1111/dsh-bun-native> as a **format‑1 plugin
market index** for DSH's Discover tab (`plugin_market` reads the same
document). The format is defined by the DSH repo note
[`plugin-market-index-format`](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md)
and the rules are implemented by `@deepseek-ai/dsh-plugin-market-index`; the
publishing guide is <https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market>.

| Plugin | Directory | What it adds |
|---|---|---|
| `@local/bun-native` | `bun-native/` | Project detection, the offline Bun globals digest, sandboxed Bun execution, and the doctor/dashboard. |
| `@local/bun-docs-mcp` | `bun-docs-mcp/` | Bun's official documentation MCP server as four read-only tools plus the `bun://skill` resource. |

## Files

| Path | Purpose |
|---|---|
| `index.json` | The index DSH reads. Generated, never hand-edited. |
| `build-index.mjs` | Builds `index.json` for both bundles from their `package.json` + locale files and one Git commit SHA. Validates before writing. |
| `validate-index.mjs` | Port of the shipped format‑1 validator (the one DSH runs), so a document accepted here is accepted by Discover. |
| `icons/bun-native.svg`, `icons/bun-docs-mcp.svg` | Icons served beside the index; referenced relatively so they work on any host. |
| `serve.mjs` | Loopback static server for a local preview. |
| `test/market.test.mjs` | `bun:test` coverage for the `dist-tags` channel rules and the multi-channel builder; `bun run test` runs it with the rest of the workspace. |

## Index URL

Published from the `main` branch of <https://github.com/brendadeeznuts1111/dsh-bun-native>:

- index: `https://raw.githubusercontent.com/brendadeeznuts1111/dsh-bun-native/main/market/index.json`
- icons: `…/main/market/icons/bun-native.svg`, `…/main/market/icons/bun-docs-mcp.svg`
- jsDelivr mirror: `https://cdn.jsdelivr.net/gh/brendadeeznuts1111/dsh-bun-native@main/market/index.json`

DSH refuses an index served behind a redirect, so the raw URL is the primary
source; the jsDelivr copy is the same document for faster cold loads.

## Register it

1. Plugins → **Experimental plugins** → enable **Custom plugin indexes**.
2. Open **Discover** → **Add index source** and paste the index URL above.
3. The index shows two cards: `Bun native` and `Bun docs MCP`. **Install**
   confirms the pinned source
   (`git+https://github.com/brendadeeznuts1111/dsh-bun-native.git#<commit>&path:/bun-native`
   or `…&path:/bun-docs-mcp`).

The installed copies replace the locally linked bundles only after a restart of
the Host; until then the linked workspace versions are what run.

## Rebuild after a release

Publishing a new version means a new commit that contains both bundles, then a
commit that contains the regenerated index. The maintainer's local release tool
automates both; the equivalent manual steps are:

```sh
bun market/build-index.mjs --commit <40-hex-sha-of-the-bundle-commit>
bun market/validate-index.mjs market/index.json
bun market/serve.mjs                            # optional local preview
```

`build-index.mjs` copies each bundle's `version`, `engines.dsh`, `keywords`,
author and localized title/description from its locale files, and pins every
version's source to the commit you pass. `publishTimestamp` is the commit time
(`git log -1 --format=%ct`) unless you pass `--publish-timestamp <unix>`,
because the format defines it as the source commit's committer time.

## Channels

A plugin may list several versions and point npm distribution tags at them, so
one index serves more than one channel. `latest` is the initial channel. DSH
installs the exact version a channel records — never `name@latest` — and names
the selected channel in the install confirmation. A channel target must be one
of that plugin's listed versions; otherwise the reader rejects the whole index,
and [`validate-index.mjs`](validate-index.mjs) enforces the same rule.

Pin each version to the commit that contains it and record the channels:

```sh
bun market/build-index.mjs \
  --release bun-native=1.2.4@565d85700f912a1dd795def0adae906bef4c7176#1793996858 \
  --release bun-native=1.3.0-rc.1@<40-hex-commit-of-the-rc>#<its-committer-unix> \
  --tag bun-native:latest=1.2.4 --tag bun-native:next=1.3.0-rc.1 \
  --release bun-docs-mcp=1.0.0@565d85700f912a1dd795def0adae906bef4c7176#1793996858
```

- `--release <dir>=<version>@<40-hex>[#<unix>]` pins one version of one bundle.
  `#<unix>` is that version's publish time — the commit's committer time; without
  it `--publish-timestamp` applies to every release.
- `--tag <dir>:<channel>=<version>` records a channel. A bundle with no `--tag`
  gets `latest` at its package.json version.
- `--commit <sha>` remains the single-channel shorthand: one release of every
  bundle at its package.json version, tagged `latest`. A bundle pinned with
  `--release` ignores it, so one index can mix both forms.
- The greatest listed version must be the bundle's current `package.json`
  version: title, description, icon and `engines.dsh` come from the working
  tree, and the format takes display metadata from the highest listed version.
  Publishing a channel therefore means bumping the bundle, committing, then
  re-running the builder with that commit pinned.
- Channel names are npm dist-tags: they must not be exact versions or SemVer
  ranges. `latest=1.2.4`, `next=1.3.0-rc.1` is a typical stable/preview pair.

The release tool rebuilds the index in its market phase, so pass the same pins
through `-ReleaseArgs` — otherwise it rebuilds a single `latest` channel from the
recorded bundle commit:

```powershell
pwsh scratch/publish-market.ps1 -Phase market -ReleaseArgs `
  '--release','bun-native=1.2.5@4e2b501cd645605218a5938eb7f45e2dea2d30d5#1794015173', `
  '--release','bun-native=1.2.4@565d85700f912a1dd795def0adae906bef4c7176#1793996858', `
  '--tag','bun-native:latest=1.2.5','--tag','bun-native:legacy=1.2.4'
```

## Notes and limits

- The npm/Git pinning rule is why these bundles cannot be listed as local
  directories: every version needs `name@version` from a registry or
  `https` Git URL + 40-hex commit. This index uses Git.
- Each plugin currently lists one version on one channel (`latest`). Add
  channels with `--release` pins and `--tag`, as in [Channels](#channels); the
  reader sorts versions by SemVer and installs the exact version each
  `dist-tags` entry records.
- `engines.dsh` is copied from each bundle's `package.json`. Keep it in sync
  with the bundle's actual DSH requirement.
- The index is unsigned: titles, author, labels and the install source are this
  repository's claims. DSH shows the URL and the pinned commit at install time,
  so review them before installing.
