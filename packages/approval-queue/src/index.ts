#!/usr/bin/env node

import { createMCPServer } from '@opafex/mcp-shared';
import { ApprovalQueueService } from './approval-service.js';
import { StateStore } from './store.js';
import { approvalQueueTools } from './tools.js';
import { runCli } from './cli.js';

export const VERSION = '0.2.0';

const ttlHours = Number(process.env.APPROVAL_QUEUE_TTL_HOURS) || undefined;
const service = new ApprovalQueueService(new StateStore(), { ttlHours });
const argv = process.argv.slice(2);

if (argv.length) {
  // A human at a terminal: decide, list, manage rules.
  runCli(argv, service).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  );
} else {
  createMCPServer({
    name: 'opafex-approval-queue',
    version: VERSION,
    tools: approvalQueueTools(service),
    resources: [
      {
        uri: 'approval://stats',
        name: 'Queue Statistics',
        description: 'Pending, approved, rejected, auto-approved and expired counts, and the average human wait',
        handler: async () => JSON.stringify(await service.getStats(), null, 2),
      },
      {
        uri: 'approval://rules',
        name: 'Auto-Approval Rules',
        description: 'Rules a human has set that let matching low/medium risk actions skip review',
        handler: async () => JSON.stringify(await service.listRules(), null, 2),
      },
      {
        uri: 'approval://history',
        name: 'Recent Decisions',
        description: 'Last 50 decisions',
        handler: async () => JSON.stringify(await service.getHistory(50), null, 2),
      },
    ],
  }).catch((err) => {
    console.error('[ApprovalQueue] Failed to start:', err);
    process.exit(1);
  });
}
