import { setTimeout as delay } from 'node:timers/promises';

/** attempts includes the initial call. Only explicitly transient failures retry. */
export async function retry(operation, policy, { signal, onRetry = () => {}, sleep = delay, random = Math.random } = {}) {
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(attempt); }
    catch (error) {
      signal?.throwIfAborted();
      if (!error.retryable || attempt === policy.attempts) throw error;
      const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      const backoff = policy.jitter ? Math.floor(random() * cap) : cap;
      // Do not retry sooner than Retry-After. Decline a wait beyond our configured budget.
      if (error.retryAfterMs > policy.maxDelayMs) throw error;
      const waitMs = Math.max(backoff, error.retryAfterMs || 0);
      onRetry({ attempt, nextAttempt: attempt + 1, waitMs, code: error.code });
      await sleep(waitMs, undefined, { signal });
    }
  }
  throw new Error('Retry policy must allow at least one attempt');
}
