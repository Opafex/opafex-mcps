#!/usr/bin/env node

import { createMCPServer } from '@opafex/mcp-shared';
import { WebResearchService } from './web-research-service.js';
import { selectSearchProvider } from './search-providers.js';
import { webResearchTools } from './tools.js';
import { PACKAGE_NAME, VERSION } from './version.js';

/** A positive integer from the environment, or the default if unset or malformed. */
function intFromEnv(name: string, fallback: number): number {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const service = new WebResearchService({
  searchCacheTtl: intFromEnv('SEARCH_CACHE_TTL', 900),
  pageCacheTtl: intFromEnv('PAGE_CACHE_TTL', 3600),
  fetchTimeoutMs: intFromEnv('FETCH_TIMEOUT_MS', 10000),
  maxHtmlSize: intFromEnv('MAX_HTML_SIZE', 1000000),
  userAgent: process.env.USER_AGENT || undefined,
  search: selectSearchProvider(process.env),
});

createMCPServer({
  name: PACKAGE_NAME,
  version: VERSION,
  tools: webResearchTools(service),
  resources: [
    {
      uri: 'web-research://status',
      name: 'Web Research Status',
      description: 'Shows the search provider, cache stats and configuration',
      handler: async () => JSON.stringify(service.getStatus(), null, 2),
    },
    {
      uri: 'web-research://cache',
      name: 'Cached Search Queries',
      description: 'Shows cached search queries',
      handler: async () => JSON.stringify(service.getCachedQueries(), null, 2),
    },
  ],
});
