import type { ToolDefinition } from '@opafex/mcp-shared';
import type { WebResearchService } from './web-research-service.js';

export function webResearchTools(service: WebResearchService): ToolDefinition[] {
  return [
    {
      name: 'web_search',
      description:
        'Search the web (Brave Search API, or the opt-in DuckDuckGo scraper). Returns an array of results with title, URL, and snippet. Returns an error naming the env var to set if no search provider is configured.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query string',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results (1-20, default 10)',
            minimum: 1,
            maximum: 20,
          },
          domain: {
            type: 'string',
            description: 'Optional domain filter (e.g. "example.com") — restricts results to this domain',
          },
        },
        required: ['query'],
      },
      handler: async (args) => {
        return service.webSearch(
          args.query as string,
          (args.maxResults as number) || 10,
          args.domain as string | undefined
        );
      },
    },
    {
      name: 'fetch_webpage',
      description:
        'Fetch a URL and extract clean text content. Includes SSRF protection (blocks private IPs, localhost, cloud metadata). Supports extracting text, links, or both.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch',
          },
          extractMode: {
            type: 'string',
            description: 'What to extract: "text" (default), "links", or "all" (text + links)',
            enum: ['text', 'links', 'all'],
          },
          maxLength: {
            type: 'number',
            description: 'Maximum text length in characters (default 4000)',
          },
        },
        required: ['url'],
      },
      handler: async (args) => {
        return service.fetchWebpage(
          args.url as string,
          (args.extractMode as 'text' | 'links' | 'all') || 'text',
          (args.maxLength as number) || 4000
        );
      },
    },
    {
      name: 'research_topic',
      description:
        'Two-stage interpreted search: searches the web for a topic, fetches top results, and compiles a structured summary organized by source. No LLM involved — extracts key sentences and organizes them. Needs a search provider, like web_search.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'The topic to research',
          },
          depth: {
            type: 'string',
            description: 'Research depth: "quick" (3 sources, shorter text), "standard" (5 sources, default), or "deep" (10 sources, more text)',
            enum: ['quick', 'standard', 'deep'],
          },
          maxSources: {
            type: 'number',
            description: 'Maximum number of sources to fetch and include (1-10, default 5)',
            minimum: 1,
            maximum: 10,
          },
        },
        required: ['topic'],
      },
      handler: async (args) => {
        return service.researchTopic(
          args.topic as string,
          (args.depth as 'quick' | 'standard' | 'deep') || 'standard',
          (args.maxSources as number) || 5
        );
      },
    },
    {
      name: 'extract_structured_data',
      description:
        'Extract specific data fields from a webpage. Fetches the page and searches for sections matching the requested field names (e.g. "pricing", "features", "contact").',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to extract data from',
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Fields to extract (e.g. ["pricing", "features", "contact"])',
          },
        },
        required: ['url', 'fields'],
      },
      handler: async (args) => {
        return service.extractStructuredData(
          args.url as string,
          args.fields as string[]
        );
      },
    },
    {
      name: 'compare_pages',
      description:
        'Fetch multiple URLs and compare their content. Returns page metadata and a text comparison, optionally focused on a specific aspect.',
      inputSchema: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'URLs to compare (2-5 required)',
            minItems: 2,
            maxItems: 5,
          },
          focus: {
            type: 'string',
            description: 'Optional focus area for comparison (e.g. "pricing", "features")',
          },
        },
        required: ['urls'],
      },
      handler: async (args) => {
        return service.comparePages(
          args.urls as string[],
          args.focus as string | undefined
        );
      },
    },
  ];
}
