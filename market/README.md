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
commit that contains the regenerated index. The release script handles both
phases (and works for an existing repository, not just the first publish):

```powershell
pwsh scratch/publish-market.ps1 -Phase bundle   # commit bun-native/ + bun-docs-mcp/ + README
pwsh scratch/publish-market.ps1 -Phase market   # build, validate, upload the index
```

Manual equivalent:

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

## Notes and limits

- The npm/Git pinning rule is why these bundles cannot be listed as local
  directories: every version needs `name@version` from a registry or
  `https` Git URL + 40-hex commit. This index uses Git.
- Each plugin currently lists one version. Add versions by rebuilding with the
  new commit; the reader sorts them and installs the `latest` channel target
  recorded in `dist-tags`.
- `engines.dsh` is copied from each bundle's `package.json`. Keep it in sync
  with the bundle's actual DSH requirement.
- The index is unsigned: titles, author, labels and the install source are this
  repository's claims. DSH shows the URL and the pinned commit at install time,
  so review them before installing.
