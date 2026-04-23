import { logger } from "./logger.js";
import { delay } from "./delay.js";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableCheck?: (error: unknown) => boolean;
}

export class RetryError extends Error {
  public readonly attempts: number;
  public readonly lastError: unknown;

  constructor(message: string, attempts: number, lastError: unknown) {
    super(message);
    this.name = "RetryError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxRetries,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    retryableCheck = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt > maxRetries || !retryableCheck(error)) {
        break;
      }

      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = backoff * 0.3 * Math.random();

      logger.warn(
        { attempt, maxRetries, delayMs: Math.round(backoff + jitter) },
        `Retry attempt ${attempt}/${maxRetries}`,
      );

      await delay(backoff + jitter);
    }
  }

  throw new RetryError(
    `Failed after ${maxRetries + 1} attempts`,
    maxRetries + 1,
    lastError,
  );
}
