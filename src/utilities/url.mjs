import { PipelineError } from './errors.mjs';
export function httpUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw new PipelineError('INVALID_URL', 'Expected an HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new PipelineError('INVALID_URL', 'Only HTTP(S) URLs without embedded credentials are supported.');
  }
  url.hash = '';
  return url.href;
}
export function checkOrigin(value, allowedOrigins) {
  const url = httpUrl(value);
  if (!allowedOrigins.includes(new URL(url).origin)) throw new PipelineError('ORIGIN_BLOCKED', 'URL origin is outside target.allowedOrigins.');
  return url;
}
