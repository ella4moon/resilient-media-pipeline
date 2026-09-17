import test from 'node:test';
import assert from 'node:assert/strict';
import { retry } from '../../src/utilities/retry.mjs';
import { PipelineError } from '../../src/utilities/errors.mjs';
const policy = { attempts: 3, baseDelayMs: 10, maxDelayMs: 50, jitter: false };
test('retries transient failures with bounded exponential delay', async () => {
  let attempts = 0; const waits = [];
  const value = await retry(() => { if (++attempts < 3) throw new PipelineError('TRANSIENT','temporary',{ retryable: true }); return 42; }, policy, { sleep: ms => waits.push(ms) });
  assert.equal(value, 42); assert.equal(attempts, 3); assert.deepEqual(waits, [10,20]);
});
test('permanent errors and exhaustion are propagated', async () => {
  let attempts = 0;
  await assert.rejects(retry(() => { attempts++; throw new Error('permanent'); }, policy), /permanent/);
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(retry(() => { attempts++; throw new PipelineError('TRANSIENT','temporary',{ retryable: true }); }, policy, { sleep: () => {} }), /temporary/);
  assert.equal(attempts, 3);
});
test('Retry-After is honored and excessive Retry-After stops retrying', async () => {
  let attempts = 0; const waits = [];
  await retry(() => { if (!attempts++) throw new PipelineError('RATE_LIMIT','limited',{ retryable: true, retryAfterMs: 40 }); }, policy, { sleep: ms => waits.push(ms) });
  assert.deepEqual(waits, [40]);
  await assert.rejects(retry(() => { throw new PipelineError('RATE_LIMIT','limited',{ retryable: true, retryAfterMs: 1000 }); }, policy, { sleep: () => assert.fail('Must not sleep') }), /limited/);
});
test('abort interrupts a retry wait', async () => {
  const controller = new AbortController();
  const pending = retry(() => { throw new PipelineError('TRANSIENT','temporary',{ retryable: true }); }, { ...policy, baseDelayMs: 1000, maxDelayMs: 1000 }, { signal: controller.signal, onRetry: () => controller.abort() });
  await assert.rejects(pending, { name: 'AbortError' });
});
