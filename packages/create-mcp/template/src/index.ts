#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMCPServer } from '@opafex/mcp-shared';
import { TextService } from './services/text-service.js';
import { textTools } from './tools/text-tools.js';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const service = new TextService();

createMCPServer({
  name: pkg.name,
  version: pkg.version,
  tools: textTools(service),
});
