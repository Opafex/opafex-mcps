#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`opafex-relay: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
