# @opafex/mcp-web-research

MCP server for web research — search the web, fetch pages as clean text, pull named sections out of a page, compare pages side by side, and run a two-stage "search then read the top results" pass.

No LLM is involved: `research_topic` and `compare_pages` organise extracted text, they do not generate it. Every page fetch is SSRF-checked, including every redirect hop.

Search uses the [Brave Search API](https://brave.com/search/api/) (free tier available). Without a key, the four page tools still work and the two search tools return an error telling you which variable to set.

## Installation

```bash
npx -y @opafex/mcp-web-research
```

Requires **Node.js 20+**. No other dependencies to install.

## Quick Start

### Claude Code

```bash
claude mcp add web-research -e BRAVE_SEARCH_API_KEY=your-key -- npx -y @opafex/mcp-web-research
```

Or add it to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "web-research": {
      "command": "npx",
      "args": ["-y", "@opafex/mcp-web-research"],
      "env": {
        "BRAVE_SEARCH_API_KEY": "your-key"
      }
    }
  }
}
```

### Claude Desktop

Add the same block to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "web-research": {
      "command": "npx",
      "args": ["-y", "@opafex/mcp-web-research"],
      "env": {
        "BRAVE_SEARCH_API_KEY": "your-key"
      }
    }
  }
}
```

Omit `BRAVE_SEARCH_API_KEY` to run with the page tools only.

## Tools

| Tool | What it does | Needs a search provider |
|------|--------------|:-----------------------:|
| `web_search` | Search the web; returns title, URL and snippet per result | Yes |
| `fetch_webpage` | Fetch a URL and return its title and clean text, links, or both | No |
| `research_topic` | Search a topic, fetch the top results, and compile the key sentences from each, by source | Yes |
| `extract_structured_data` | Fetch a page and return the section around each requested field (e.g. `pricing`, `contact`) | No |
| `compare_pages` | Fetch 2–5 pages and compare them, optionally around one focus area | No |
| `server_info` | Server name, version, tools and resources (built in, from `@opafex/mcp-shared`) | No |

### `web_search`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `maxResults` | number | No | 1–20, default 10 |
| `domain` | string | No | Restrict results to this domain (e.g. `"example.com"`); adds `site:` and filters the result URLs |

Result URLs that fail the SSRF check (below) are dropped before they are returned.

<details>
<summary>Example response</summary>

```json
[
  {
    "title": "Model Context Protocol",
    "url": "https://modelcontextprotocol.io/",
    "snippet": "An open protocol that enables seamless integration between LLM applications and external data sources and tools."
  }
]
```
</details>

### `fetch_webpage`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | `http` or `https` URL |
| `extractMode` | `"text"` \| `"links"` \| `"all"` | No | Default `"text"` |
| `maxLength` | number | No | Maximum characters of text returned, default 4000 |

Scripts, styles, `<nav>` and `<footer>` are removed. `finalUrl` is included when the page was reached through redirects.

<details>
<summary>Example response</summary>

```json
{
  "title": "Example Domain",
  "text": "Example Domain\nThis domain is for use in illustrative examples in documents.",
  "url": "http://example.com/",
  "fetchedAt": "2026-10-24T12:00:00.000Z"
}
```
</details>

### `research_topic`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `topic` | string | Yes | What to research |
| `depth` | `"quick"` \| `"standard"` \| `"deep"` | No | Search 3 / 5 / 10 results and read 2,000 / 4,000 / 8,000 characters of each. Default `"standard"` |
| `maxSources` | number | No | 1–10 sources to fetch, default 5 |

Key points are the sentences that mention the topic's words, up to five per source. A source that cannot be fetched falls back to its search snippet.

### `extract_structured_data`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Page to read |
| `fields` | string[] | Yes | Field names to look for (e.g. `["pricing", "features", "contact"]`) |

For each field, returns the first line mentioning it and the ten lines after, up to 1,000 characters — or `No "<field>" section found on page.` This is heading matching, not a schema extractor.

### `compare_pages`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `urls` | string[] | Yes | 2–5 URLs |
| `focus` | string | No | A field to pull from every page (e.g. `"pricing"`) |

A page that fails to fetch is listed with `"(fetch failed)"` and the reason; the others are still compared.

## Resources

| Resource | Description |
|----------|-------------|
| `web-research://status` | Search provider in use (or why search is unavailable), cache stats and configuration |
| `web-research://cache` | Search queries currently cached |

## Search providers

| Provider | How to select | Notes |
|----------|---------------|-------|
| **Brave Search API** (recommended) | Set `BRAVE_SEARCH_API_KEY` | An official API with a free tier. Up to 20 results per query. |
| DuckDuckGo HTML scraper | Set `WEB_RESEARCH_SEARCH_PROVIDER=duckduckgo` | Opt-in only — see below |
| none | Neither of the above | `web_search` and `research_topic` return an error naming `BRAVE_SEARCH_API_KEY`; the other tools work |

**About the DuckDuckGo option.** It parses the results page at `html.duckduckgo.com`. That is not an API: it breaks whenever DuckDuckGo changes its markup, it may be rate-limited or blocked, and DuckDuckGo's terms do not permit automated querying. It sends this server's honest user agent rather than pretending to be a browser, which makes blocking more likely. It is kept for personal experimentation; if you turn it on, you are responsible for complying with DuckDuckGo's terms. Use Brave for anything you depend on.

## Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `BRAVE_SEARCH_API_KEY` | string | — | Brave Search API key. Enables `web_search` and `research_topic` |
| `WEB_RESEARCH_SEARCH_PROVIDER` | `brave` \| `duckduckgo` | Brave if a key is set, else none | Choose the search provider explicitly |
| `USER_AGENT` | string | `opafex-mcp-web-research/<version> (+https://github.com/Opafex/opafex-mcps)` | User-Agent sent with every request |
| `FETCH_TIMEOUT_MS` | number | `10000` | Timeout per page, across all its redirect hops |
| `MAX_HTML_SIZE` | number (bytes) | `1000000` | Bytes read from a page body; the download stops there |
| `SEARCH_CACHE_TTL` | number (seconds) | `900` (15 min) | How long search results are cached |
| `PAGE_CACHE_TTL` | number (seconds) | `3600` (1 h) | How long fetched pages are cached |

## Security

The page tools fetch URLs chosen by a model, from the machine the server runs on. Without protection, that machine's private network and cloud metadata service are one tool call away (server-side request forgery). Every fetch is checked first, and refused if:

- the scheme is not `http` or `https`;
- the host is `localhost`, `*.localhost`, or a cloud metadata name (`metadata.google.internal`);
- the host is a literal IP — IPv4, or bracketed IPv6 — in a non-public range. Odd IPv4 spellings (`http://2130706433/`, `http://0x7f.1/`) are normalised before the check;
- **any** address the hostname resolves to, IPv4 (A) or IPv6 (AAAA), is in a non-public range. One public A record does not excuse a private AAAA record;
- the hostname cannot be resolved. **The check fails closed:** an address that could not be checked is not fetched.

Blocked ranges:

| IPv4 | IPv6 |
|------|------|
| `0.0.0.0/8` this network | `::` unspecified, `::1` loopback |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` private | `fc00::/7` unique local |
| `100.64.0.0/10` carrier-grade NAT | `fe80::/10` link-local, `fec0::/10` site-local |
| `127.0.0.0/8` loopback | `ff00::/8` multicast |
| `169.254.0.0/16` link-local, incl. cloud metadata `169.254.169.254` | `::ffff:0:0/96` IPv4-mapped — judged by the IPv4 address inside |
| `192.0.0.0/24`, `198.18.0.0/15` reserved / benchmarking | `64:ff9b::/96` NAT64 and `2002::/16` 6to4 — judged by the IPv4 address inside |
| `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` documentation | `::/96` IPv4-compatible, `64:ff9b:1::/48`, `2001::/32` Teredo, `2001:db8::/32` |
| `224.0.0.0/4` multicast, `240.0.0.0/4` reserved, broadcast | anything outside global unicast `2000::/3` |

**Redirects are followed by hand, and every hop is checked again** — at most 5 hops. A public page that redirects to `http://169.254.169.254/` is refused before the second request is made. Search result URLs are checked too, and dropped if they fail.

**Known limit — DNS rebinding.** The check resolves the hostname, then `fetch` resolves it again to connect. A hostile DNS server with a very short TTL could answer the two lookups differently. Closing that gap means pinning the connection to the checked address, which Node's built-in `fetch` does not expose without an extra dependency. If this server runs somewhere with sensitive internal services, also limit what it can reach at the network level (container network policy, egress firewall).

## Limits

- **Text only.** Pages must be `text/*`, `application/xhtml+xml` or `application/json`; PDFs, images and other binary types are refused.
- **No JavaScript.** Pages are fetched as served. Content rendered client-side will be missing.
- **Regex-based HTML parsing.** Fast and dependency-free, but not a full HTML parser; unusual markup can leak into the text.
- **Heuristic extraction.** `research_topic` key points and `extract_structured_data` sections are keyword matching, not understanding.
- **In-memory cache**, per process, lost on restart.
- **UTF-8 assumed.** Pages in other encodings may decode with replacement characters.
- **Not a crawler.** No robots.txt handling; it fetches the URLs it is given.

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Run with tsx (no build needed)
npm test         # Run tests (no network — fetch and DNS are faked)
npm start        # Run compiled server
```

## Contributing

Found a bug or have a feature request? [Open an issue](https://github.com/opafex/opafex-mcps/issues).

Pull requests welcome — see the [main repo](https://github.com/opafex/opafex-mcps) for development setup.

## License

MIT — see [LICENSE](./LICENSE).
