/**
 * File-backed state for the approval queue.
 *
 * ONE file (`state.json`) holds requests, rules and history, because two
 * processes share it: the MCP server the agent talks to, and the CLI a human
 * decides with. Every operation is load → change → save under a lock file, and
 * the save is atomic (write a temp file, then rename), so a decision made in a
 * terminal is what the server reads on its next call.
 */

import { readFile, writeFile, rename, mkdir, open, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { RiskLevel } from './risk-assessor.js';

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'auto_approved' | 'expired';

export interface ApprovalRequest {
  id: string;
  action: string;
  params?: Record<string, unknown>;
  context?: string;
  category: string;
  status: RequestStatus;
  riskLevel: RiskLevel;
  riskScore: number;
  reason?: string;
  requestedAt: string;
  expiresAt: string;
  decidedAt?: string;
  /** `human:<channel>` for a person's decision, `rule:<id>` for an auto-approval, `system` for expiry. */
  decidedBy?: string;
}

export interface AutoApprovalRule {
  id: string;
  actionPattern: string;
  maxRisk: 'low' | 'medium';
  description: string;
  source: 'manual' | 'always_approve';
  useCount: number;
  createdAt: string;
  active: boolean;
}

export interface Decision {
  id: string;
  action: string;
  category: string;
  status: Exclude<RequestStatus, 'pending'>;
  riskLevel: RiskLevel;
  reason?: string;
  decidedAt: string;
  decidedBy: string;
}

export interface QueueState {
  version: 1;
  requests: ApprovalRequest[];
  rules: AutoApprovalRule[];
  history: Decision[];
}

/** Decided requests kept for check_status; pending ones are never trimmed. */
const MAX_DECIDED_REQUESTS = 500;
const MAX_HISTORY = 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

export function defaultStateDir(): string {
  return (
    process.env.APPROVAL_QUEUE_STATE_DIR ||
    // Name used before 0.2; kept so an existing setup finds its rules.
    process.env.APPROVAL_QUEUE_PERSISTENCE_PATH ||
    join(homedir(), '.opafex', 'approval-queue')
  );
}

function emptyState(): QueueState {
  return { version: 1, requests: [], rules: [], history: [] };
}

export class StateStore {
  readonly dir: string;
  private readonly statePath: string;
  private readonly lockPath: string;

  constructor(dir: string = defaultStateDir()) {
    this.dir = dir;
    this.statePath = join(dir, 'state.json');
    this.lockPath = join(dir, 'state.lock');
  }

  /** Read the current state without taking the lock. */
  async read(): Promise<QueueState> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as QueueState;
      return {
        version: 1,
        requests: parsed.requests ?? [],
        rules: parsed.rules ?? [],
        history: parsed.history ?? [],
      };
    } catch {
      // A corrupt file must not silently become an empty queue with no rules:
      // that would drop pending requests a human is about to decide.
      throw new Error(`Approval queue state at ${this.statePath} is not valid JSON; fix or remove it`);
    }
  }

  /** Load, apply `change`, save — atomically and under the lock. */
  async update<T>(change: (state: QueueState) => T): Promise<T> {
    await mkdir(this.dir, { recursive: true });
    await this.acquire();
    try {
      const state = await this.read();
      const result = change(state);
      this.trim(state);
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
      await rename(tmp, this.statePath);
      return result;
    } finally {
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private trim(state: QueueState): void {
    const decided = state.requests.filter((r) => r.status !== 'pending');
    if (decided.length > MAX_DECIDED_REQUESTS) {
      const drop = new Set(
        decided
          .sort((a, b) => (a.decidedAt ?? '').localeCompare(b.decidedAt ?? ''))
          .slice(0, decided.length - MAX_DECIDED_REQUESTS)
          .map((r) => r.id)
      );
      state.requests = state.requests.filter((r) => !drop.has(r.id));
    }
    if (state.history.length > MAX_HISTORY) {
      state.history = state.history.slice(-MAX_HISTORY);
    }
  }

  private async acquire(): Promise<void> {
    const started = Date.now();
    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      // A lock left behind by a crashed process is broken after LOCK_STALE_MS.
      const info = await stat(this.lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await unlink(this.lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for the approval queue lock at ${this.lockPath}`);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}
