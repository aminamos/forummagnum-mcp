<div align="center">

# forummagnum-mcp

MCP server for LessWrong + the EA Forum — nine read-only tools over full-text search, posts, comments, users, tags, and feeds, with a `site` switch on every call.

[![MIT License][license-shield]][license-url]
[![TypeScript][typescript-shield]][typescript-url]
[![MCP][mcp-shield]][mcp-url]
[![Node][node-shield]][node-url]

</div>

## About

Thin, stateless MCP server (stdio transport) over the public ForumMagnum APIs:

- `POST {site}/api/search` — the same native search proxy the site frontends use (posts, comments, users, tags, sequences; no auth).
- `POST {site}/graphql` — post/user/tag detail, comments, and frontpage/curated/top/new feeds.

Every tool takes a `site` param (`lesswrong` | `eaforum`, default `lesswrong`) and returns trimmed `{ results, meta }` (or `{ result, meta }` for single-document tools). No auth, no state, no deep-offset pagination. Polite by default: descriptive `User-Agent` with contact, ≥1.5 s between requests plus jitter, exponential backoff on 429/5xx.

### Built With

- [TypeScript](https://www.typescriptlang.org/)
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`)
- [Zod](https://zod.dev/) (tool input schemas)
- [ForumMagnum](https://github.com/ForumMagnum/ForumMagnum) public search + GraphQL APIs (data source)

## Getting Started

### Prerequisites

- Node.js 18+
- An MCP client (Claude Desktop, Claude Code, etc.)

### Installation

```bash
git clone https://github.com/aminamos/forummagnum-mcp.git
cd forummagnum-mcp
npm install
npm run build
```

Point your MCP client at the built server. Claude Desktop (`claude_desktop_config.json`) / Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "forummagnum": {
      "command": "node",
      "args": ["/absolute/path/to/forummagnum-mcp/dist/index.js"]
    }
  }
}
```

No build step — run from source with `tsx`:

```json
{
  "mcpServers": {
    "forummagnum": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/forummagnum-mcp/src/index.ts"]
    }
  }
}
```

## Usage

```json
{ "tool": "search_posts", "arguments": { "query": "shard theory", "site": "lesswrong", "limit": 5 } }
{ "tool": "get_post", "arguments": { "slug": "better-games-or-bednets", "site": "eaforum", "topComments": 3 } }
{ "tool": "list_posts", "arguments": { "view": "curated", "site": "lesswrong", "limit": 5 } }
{ "tool": "get_user", "arguments": { "slug": "eliezer-yudkowsky", "site": "lesswrong" } }
{ "tool": "get_tag", "arguments": { "slug": "ai", "site": "lesswrong" } }
```

| Tool | Source | Args |
|---|---|---|
| `search_posts` | search index | `query`, `site`, `limit` (1–25), `sort` (relevance\|karma\|newest_first\|oldest_first) |
| `search_comments` | search index | `query`, `site`, `limit`, `sort` |
| `search_users` | search index | `query`, `site`, `limit` |
| `search_tags` | search index | `query`, `site`, `limit` |
| `search_sequences` | search index | `query`, `site`, `limit` |
| `get_post` | GraphQL | `site`, `id` or `slug`, `includeBody` (default true), `topComments` (0–20, default 5) |
| `list_posts` | GraphQL | `site`, `view` (frontpage\|curated\|top\|new), `limit` |
| `get_user` | GraphQL | `site`, `slug` or `id` |
| `get_tag` | GraphQL | `site`, `slug` |

Output trimming: plain strings cap at 1000 chars, body/bio/description fields at 4000, total payload at ~20k chars.

### Politeness

- `User-Agent: forummagnum-mcp/1.0 (https://github.com/aminamos/forummagnum-mcp)` on every request.
- Minimum 1.5 s gap + jitter between upstream requests; exponential backoff (2 s → 4 s → 8 s) with retries on 429/5xx/network errors.
- No `offset` pagination past the upstream ceiling — list/search tools cap at 25 rows per call.

## Roadmap

- [x] Full-text search over posts/comments/users/tags/sequences on both forums
- [x] Post detail + top comments, user/tag detail, feed listings
- [x] Polite throttle + backoff + output trimming
- [ ] Sequence/chapter contents detail tool
- [ ] Event/start-time filters on `list_posts`

## Contributing

PRs welcome. Keep it boring: stdio transport, stateless, no new runtime deps without a reason.

1. Fork the repo
2. Create your branch (`git checkout -b feature/thing`)
3. Commit (`git commit -m 'Add thing'`)
4. Push (`git push origin feature/thing`)
5. Open a pull request

## License

Server code: MIT — see [`LICENSE`](LICENSE). Post/comment/user content belongs to its authors via LessWrong / the EA Forum — credit the source when using the data.

## Contact

Amin Amos — [@aminamos](https://github.com/aminamos)

Project link: [https://github.com/aminamos/forummagnum-mcp](https://github.com/aminamos/forummagnum-mcp)

## Acknowledgments

- [ForumMagnum](https://github.com/ForumMagnum/ForumMagnum) for the open forum software and public APIs
- [Best-README-Template](https://github.com/othneildrew/Best-README-Template) for the README structure

[license-shield]: https://img.shields.io/badge/license-MIT-green.svg
[license-url]: https://github.com/aminamos/forummagnum-mcp/blob/main/LICENSE
[typescript-shield]: https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white
[typescript-url]: https://www.typescriptlang.org/
[mcp-shield]: https://img.shields.io/badge/MCP-stdio-blueviolet
[mcp-url]: https://modelcontextprotocol.io/
[node-shield]: https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white
[node-url]: https://nodejs.org/
