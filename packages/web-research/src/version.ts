/**
 * Package name and version, read from package.json so the server never
 * reports a version that differs from the one published. `__dirname` is
 * `src/` under tsx/vitest and `dist/` when built — package.json is one level
 * up from both.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
  name: string;
  version: string;
};

export const PACKAGE_NAME: string = pkg.name;
export const VERSION: string = pkg.version;

/** Identifies the bot honestly. Override with the USER_AGENT env var. */
export const DEFAULT_USER_AGENT = `opafex-mcp-web-research/${VERSION} (+https://github.com/Opafex/opafex-mcps)`;
