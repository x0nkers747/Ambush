// HTTP for the geographic services (docs/adr/0014): retries with backoff,
// rate limiting, cancellation and errors that name the service. The network,
// clock and timers are injected, so the behaviour is testable in Node.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** A failed request to a named service, with a message fit to show the player. */
export class ServiceError extends Error {
  override name = 'ServiceError';
  readonly service: string;
  readonly status: number | undefined;
  constructor(service: string, message: string, status?: number) {
    super(message);
    this.service = service;
    this.status = status;
  }
}

/** Thrown when the player cancels; never shown as an error. */
export class CancelledError extends Error {
  override name = 'CancelledError';
  constructor() {
    super('Cancelled');
  }
}

export const isCancelled = (error: unknown): boolean =>
  error instanceof CancelledError || (error instanceof DOMException && error.name === 'AbortError');

/** Waits `ms`, or rejects with `CancelledError` as soon as `signal` aborts. */
export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export interface RetryOptions {
  /** Service name for errors and progress, e.g. "OpenStreetMap (Overpass)". */
  readonly service: string;
  readonly fetch: FetchLike;
  readonly sleep?: Sleep;
  readonly signal?: AbortSignal;
  /** Retries after the first attempt. Default 3. */
  readonly retries?: number;
  /** Waits before each retry, in ms; the last is reused. Default 2 s, 5 s, 15 s. */
  readonly backoffMs?: readonly number[];
  /** Wait after HTTP 429 or 406 (rate limited), in ms. Default 30 s, as Overpass asks. */
  readonly rateLimitedWaitMs?: number;
  /** Called before each retry, e.g. to show "retrying in 5 s". */
  readonly onRetry?: (info: { attempt: number; waitMs: number; reason: string }) => void;
  /** Statuses that mean "no such resource" and are returned, not retried (e.g. 404 for a tile). */
  readonly passStatuses?: readonly number[];
}

const RETRYABLE = new Set([429, 406, 500, 502, 503, 504]);

/**
 * Fetches with retries for network failures, rate limiting and server
 * errors. Returns the response for 2xx and for `passStatuses`; throws a
 * `ServiceError` for other statuses or once retries run out, and a
 * `CancelledError` when cancelled.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions,
): Promise<Response> {
  const wait = options.sleep ?? sleep;
  const retries = options.retries ?? 3;
  const backoff = options.backoffMs ?? [2000, 5000, 15000];
  let lastReason = '';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted) throw new CancelledError();
    let response: Response | null = null;
    try {
      response = await options.fetch(url, {
        ...init,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (isCancelled(error) || options.signal?.aborted) throw new CancelledError();
      lastReason = 'the service could not be reached (network error)';
    }
    if (response) {
      if (response.ok || options.passStatuses?.includes(response.status)) return response;
      lastReason = `the service answered HTTP ${String(response.status)}${response.statusText ? ` ${response.statusText}` : ''}`;
      if (!RETRYABLE.has(response.status)) {
        throw new ServiceError(
          options.service,
          `${options.service} failed: ${lastReason}.`,
          response.status,
        );
      }
    }
    if (attempt === retries) break;
    const rateLimited = response?.status === 429 || response?.status === 406;
    const retryAfter = Number(response?.headers.get('retry-after'));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 120000)
        : rateLimited
          ? (options.rateLimitedWaitMs ?? 30000)
          : (backoff[Math.min(attempt, backoff.length - 1)] ?? 5000);
    options.onRetry?.({ attempt: attempt + 1, waitMs, reason: lastReason });
    await wait(waitMs, options.signal);
  }
  throw new ServiceError(
    options.service,
    `${options.service} failed after ${String(retries + 1)} attempts: ${lastReason}.`,
  );
}

/**
 * Spaces calls at least `minIntervalMs` apart (e.g. Nominatim's one request
 * per second). Calls queue in order.
 */
export function createRateLimiter(
  minIntervalMs: number,
  now: () => number = () => Date.now(),
  wait: Sleep = sleep,
): <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
  let next = 0;
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const run = chain.then(async () => {
      const delay = next - now();
      if (delay > 0) await wait(delay, signal);
      next = now() + minIntervalMs;
      return task();
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

/** Runs `tasks` with at most `limit` at once, preserving result order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      const item = items[i];
      if (item !== undefined) results[i] = await task(item, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
