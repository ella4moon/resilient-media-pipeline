import { PipelineError } from './errors.mjs';
import { retry } from './retry.mjs';
import { checkOrigin } from './url.mjs';

export function retryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - Date.now()) || undefined;
}
export async function readBytes(response, maximumBytes) {
  const chunks = [];
  let size = 0;
  if (Number(response.headers.get('content-length')) > maximumBytes) {
    await response.body?.cancel();
    throw new PipelineError('RESPONSE_TOO_LARGE', 'Response exceeds the configured byte limit.');
  }
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximumBytes) throw new PipelineError('RESPONSE_TOO_LARGE', 'Response exceeds the configured byte limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export class HttpClient {
  constructor({ allowedOrigins, headerOrigins = [], headers = {}, timeoutMs, retry: policy, logger }) {
    Object.assign(this, { allowedOrigins, headerOrigins, headers, timeoutMs, policy, logger });
  }
  async request(url, { signal, method = 'GET', headers = {}, bodyFactory, timeoutMs = this.timeoutMs } = {}, consume) {
    return retry(async () => {
      const timed = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timed]) : timed;
      let response;
      try {
        let current = checkOrigin(url, this.allowedOrigins);
        for (let redirects = 0; ; redirects++) {
          const scopedHeaders = this.headerOrigins.includes(new URL(current).origin) ? this.headers : {};
          response = await fetch(current, { method, headers: { ...scopedHeaders, ...headers },
            body: bodyFactory ? await bodyFactory() : undefined, signal: combined, redirect: 'manual' });
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            if (method !== 'GET' || redirects >= 5 || !response.headers.get('location')) {
              throw new PipelineError('REDIRECT_REJECTED', 'Unexpected redirect or redirect limit exceeded.');
            }
            current = checkOrigin(new URL(response.headers.get('location'), current).href, this.allowedOrigins);
            continue;
          }
          break;
        }
        if (!response.ok) {
          const status = response.status;
          const after = retryAfter(response.headers.get('retry-after'));
          await response.body?.cancel();
          throw new PipelineError(`HTTP_${status}`, `Remote server returned HTTP ${status}.`, {
            retryable: [408, 425, 429, 500, 502, 503, 504].includes(status), retryAfterMs: after,
          });
        }
        // Consumption is inside the retry boundary: interrupted bodies retry too.
        return await consume(response, combined);
      } catch (error) {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        signal?.throwIfAborted();
        if (error instanceof PipelineError) throw error;
        if (timed.aborted) throw new PipelineError('REQUEST_TIMEOUT', 'Remote operation timed out.', { retryable: true });
        const code = error.cause?.code || error.code;
        if (error instanceof TypeError || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) {
          throw new PipelineError('NETWORK_ERROR', 'Network operation failed.', { retryable: true, cause: error });
        }
        throw error;
      }
    }, this.policy, { signal, onRetry: fields => this.logger?.warn('request_retry', fields) });
  }
  text(url, { signal, maxBytes = 2097152 } = {}) {
    return this.request(url, { signal }, async response => ({
      text: (await readBytes(response, maxBytes)).toString('utf8'), url: response.url,
    }));
  }
}
