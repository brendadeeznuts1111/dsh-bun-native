# Plugin market index

This directory publishes `@local/bun-native` as a **format‑1 plugin market index**
for DSH's Discover tab (`plugin_market` reads the same document). The format is
defined by the DSH repo note
[`plugin-market-index-format`](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md)
and the rules are implemented by `@deepseek-ai/dsh-plugin-market-index`; the
publishing guide is <https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market>.

## Files

| Path | Purpose |
|---|---|
| `index.json` | The index DSH reads. Generated, never hand-edited. |
| `build-index.mjs` | Builds `index.json` from `../package.json` + the bundle locale files and a Git commit SHA. Validates before writing. |
| `validate-index.mjs` | Port of the shipped format‑1 validator (the one DSH runs), so a document accepted here is accepted by Discover. |
| `icons/bun-native.svg` | Icon served beside the index; the index references it relatively so it works on any host. |
| `serve.mjs` | Loopback static server for a local preview. |

## Index URL

Published from the `main` branch of <https://github.com/brendadeeznuts1111/dsh-bun-native>:

- index: `https://raw.githubusercontent.com/brendadeeznuts1111/dsh-bun-native/main/market/index.json`
- icon: `https://raw.githubusercontent.com/brendadeeznuts1111/dsh-bun-native/main/market/icons/bun-native.svg`
- jsDelivr mirror: `https://cdn.jsdelivr.net/gh/brendadeeznuts1111/dsh-bun-native@main/market/index.json`

DSH refuses an index served behind a redirect, so the raw URL is the primary
source; the jsDelivr copy is the same document for faster cold loads.

## Register it

1. Plugins → **Experimental plugins** → enable **Custom plugin indexes**.
2. Open **Discover** → **Add index source** and paste the index URL above.
3. The card shows `Bun native`; **Install** confirms the pinned source
   (`git+https://github.com/brendadeeznuts1111/dsh-bun-native.git#<commit>&path:/bun-native`).

The installed copy replaces the locally linked bundle only after a restart of
the Host; until then the linked workspace version is what runs.

## Rebuild after a release

Publishing a new version means a new commit that contains the bundle, then a
commit that contains the regenerated index:

```sh
bun market/build-index.mjs --commit <40-hex-sha-of-the-bundle-commit>
bun market/validate-index.mjs market/index.json
bun market/serve.mjs            # optional local preview
```

`build-index.mjs` copies `version`, `engines.dsh`, `keywords`, author and the
localized title/description (from `bun-native/locale/en.json` and
`bun-native/locale/zh.json`), and pins the version's source to the commit you
pass. `publishTimestamp` is the
commit time (`git log -1 --format=%ct`) unless you pass
`--publish-timestamp <unix>`, because the format defines it as the source
commit's committer time.

## Notes and limits

- The npm/Git pinning rule is why this bundle cannot be listed as a local
  directory: every version needs `name@version` from a registry or
  `https` Git URL + 40-hex commit. This index uses Git.
- `index.json` lists one version (`1.0.0`) and one plugin. Add versions by
  rebuilding with the new commit; the reader sorts them and installs the
  `latest` channel target recorded in `dist-tags`.
- `engines.dsh` in `../bun-native/package.json` is copied unchanged. Keep it in
  sync with the bundle's actual DSH requirement.
- The index is unsigned: titles, author, labels and the install source are this
  repository's claims. DSH shows the URL and the pinned commit at install time,
  so review them before installing.
