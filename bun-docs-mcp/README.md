# Bun docs MCP

A configuration-only DSH bundle that connects Bun's **official documentation MCP
server** at <https://bun.com/docs/mcp> and exposes its read-only tools to the
agent.

| Tool | What it does |
|---|---|
| `mcp__bun_docs__search_bun` | Ranked sections across bun.com docs, guides and blog, with deep links. |
| `mcp__bun_docs__read_bun_page` | Full markdown of one page by site path or full URL. |
| `mcp__bun_docs__list_bun_pages` | List pages under a path prefix. |
| `mcp__bun_docs__grep_bun` | Regex search over page markdown, with context and caps. |

The server also publishes the `bun://skill` resource (a short Bun primer and a
guide to these tools), readable through `read_mcp_resource`.

## Install

- From the market index: Discover → install the **Bun docs MCP** card.
- Or directly: `plugin_manager` `install_bundle` with this directory or
  `git+https://github.com/brendadeeznuts1111/dsh-bun-native.git#<commit>&path:/bun-docs-mcp`.

There are no package dependencies. The DSH profile must provide
`@deepseek-ai/dsh-mcp-client`, which ships with the Harness.

## Configuration

The bundle's patch inserts one MCP client row:

```yaml
- id: bun-docs-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: bun_docs
    transport: streamable-http
    url: https://bun.com/docs/mcp
    failOnStartupError: true
```

Override the row in the profile patch layer to rename `serverName`, point at a
different endpoint, or set `failOnStartupError: false`. Disable it with
`enabled: false`; the tools then disappear from the agent's tool list.

## Verify

Call `mcp__bun_docs__search_bun` with `{ "query": "Bun.serve" }`. A result with
bun.com links means the connection is live. `list_mcp_resources` with
`server: "bun_docs"` returns `bun://skill`.

The endpoint is a POST JSON-RPC MCP server speaking Streamable HTTP; a browser
GET returns 404 by design.

## Relationship to `@local/bun-native`

`@local/bun-native`'s `bun_api` answers from an offline digest of the Bun globals
and keeps working without a network. This bundle adds live docs, guides, blog
search and full-page reads. Install either or both; `bun-native`'s prompt and
`bun_api` mention these tools when they are available.

The server is read-only, scoped to bun.com, holds no session state, and requires
no credentials.
