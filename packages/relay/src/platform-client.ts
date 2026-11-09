import { RELAY_VERSION } from './version.js';

/** The most the relay reads of any platform response. Its answers are small. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type StopReason = 'unauthorized' | 'not_entitled' | 'paused' | 'forbidden' | 'refused' | 'hello_loop';

/** The 403 codes that name the ACCOUNT, not the request: the relay stops on them wherever they come. */
const ACCOUNT_REFUSALS: Record<string, StopReason> = { relay_not_entitled: 'not_entitled', relay_account_paused: 'paused' };

export type ApiOutcome<T> =
  | { status: 'ok'; httpStatus: number; body: T | null; serverDate?: number }
  | { status: 'stop'; reason: StopReason; httpStatus: number; message: string; code?: string }
  | { status: 'retry'; httpStatus?: number; message: string };

export type ResultOutcome =
  | { status: 'stored' }
  | { status: 'settled' }
  | { status: 'expired' }
  | { status: 'not_ours' }
  | { status: 'rejected'; message: string }
  | { status: 'stop'; reason: StopReason; message: string }
  | { status: 'retry'; message: string };

export interface PlatformClientOptions {
  baseUrl: string;
  key: string;
  fetchImpl?: typeof fetch;
}

/** Platform text shown in a terminal: control characters removed (no escape sequences), length capped. */
export function safeText(v: unknown, max = 300): string {
  const s = typeof v === 'string' ? v : '';
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Reads `{ error, code }`, `{ error: { code, message } }` or `{ message }` without trusting the shape. */
export function errorOf(body: unknown): { code?: string; message?: string } {
  if (typeof body !== 'object' || body === null) return {};
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    return { code: typeof e.code === 'string' ? e.code : undefined, message: typeof e.message === 'string' ? e.message : undefined };
  }
  return {
    code: typeof b.code === 'string' ? b.code : undefined,
    message: typeof err === 'string' ? err : typeof b.message === 'string' ? b.message : undefined,
  };
}

/** The platform's success envelope is `{ success, data }`; a bare body is accepted too. */
export function unwrap(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (b.success === true && 'data' in b) return b.data;
  }
  return body;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('the platform response was too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `AbortSignal.any` arrived in Node 20.3; this works on every Node 20. */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctl = new AbortController();
  const onA = () => ctl.abort(a.reason);
  const onB = () => ctl.abort(b.reason);
  a.addEventListener('abort', onA, { once: true });
  b.addEventListener('abort', onB, { once: true });
  ctl.signal.addEventListener('abort', () => {
    a.removeEventListener('abort', onA);
    b.removeEventListener('abort', onB);
  }, { once: true });
  return ctl.signal;
}

/** Talks to `/api/relay/v1/*`, outbound only. The key goes in one header and nowhere else. */
export class PlatformClient {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PlatformClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.key = opts.key;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(method: 'GET' | 'POST', route: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<ApiOutcome<T>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? anySignal(signal, timeout) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/relay/v1${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          'X-Relay-Version': RELAY_VERSION,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // The relay talks to its configured platform only; a redirect would take the key elsewhere.
        redirect: 'error',
        signal: combined,
      });
    } catch (e) {
      if (signal?.aborted) return { status: 'retry', message: 'stopped' };
      const why = timeout.aborted ? 'timed out' : (e as Error).message;
      return { status: 'retry', message: `could not reach ${this.baseUrl}: ${safeText(why)}` };
    }

    let text = '';
    try {
      text = await readCapped(res);
    } catch (e) {
      return { status: 'retry', httpStatus: res.status, message: (e as Error).message };
    }
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    const dateHeader = res.headers.get('date');
    const serverDate = dateHeader ? Date.parse(dateHeader) : NaN;

    if (res.status >= 200 && res.status < 300) {
      return { status: 'ok', httpStatus: res.status, body: (unwrap(parsed) as T) ?? null, ...(Number.isFinite(serverDate) ? { serverDate } : {}) };
    }
    const { code, message } = errorOf(parsed);
    const said = safeText(message) || safeText(code) || `HTTP ${res.status}`;
    if (res.status === 401) {
      return { status: 'stop', reason: 'unauthorized', httpStatus: 401, message: said };
    }
    if (res.status === 403) {
      return { status: 'stop', reason: (code && ACCOUNT_REFUSALS[code]) || 'forbidden', httpStatus: 403, message: said, ...(code ? { code } : {}) };
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return { status: 'retry', httpStatus: res.status, message: said };
    }
    return { status: 'stop', reason: 'refused', httpStatus: res.status, message: said, ...(code ? { code } : {}) };
  }

  hello<T>(payload: unknown): Promise<ApiOutcome<T>> {
    return this.call<T>('POST', '/hello', payload, 30_000);
  }

  next<T>(waitSeconds: number, signal?: AbortSignal): Promise<ApiOutcome<T>> {
    return this.call<T>('GET', `/next?wait=${waitSeconds}`, undefined, (waitSeconds + 20) * 1000, signal);
  }

  async postResult(requestId: string, body: unknown): Promise<ResultOutcome> {
    const out = await this.call('POST', `/requests/${encodeURIComponent(requestId)}/result`, body, 30_000);
    if (out.status === 'ok') return { status: 'stored' };
    if (out.status === 'retry') return { status: 'retry', message: out.message };
    if (out.httpStatus === 401) return { status: 'stop', reason: 'unauthorized', message: out.message };
    if (out.httpStatus === 409) return { status: 'settled' };
    if (out.httpStatus === 410) return { status: 'expired' };
    // An account-level 403 (no relay on the plan, the account paused) stops the relay; any other 403
    // on a result means another relay claimed the request.
    if (out.httpStatus === 403 && (out.reason === 'not_entitled' || out.reason === 'paused')) return { status: 'stop', reason: out.reason, message: out.message };
    if (out.httpStatus === 403) return { status: 'not_ours' };
    // Any other 4xx: the platform will not take this result, and sending it again will not change that.
    return { status: 'rejected', message: out.message };
  }
}
