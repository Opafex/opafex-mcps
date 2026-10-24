import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { ApprovalQueueService, type ServiceOptions } from '../src/approval-service.js';
import { StateStore } from '../src/store.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'approval-queue-'));
  dirs.push(dir);
  return dir;
}

export function makeService(options: ServiceOptions = {}, dir = tempDir()): ApprovalQueueService {
  return new ApprovalQueueService(new StateStore(dir), options);
}
