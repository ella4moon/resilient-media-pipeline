import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';
import { load } from 'cheerio';
import { httpUrl } from './utilities/url.mjs';
import { PipelineError } from './utilities/errors.mjs';
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().nonnegative().finite();
const field = z.object({ selector: z.string().min(1), attribute: z.string().min(1).optional(), multiple: z.boolean().optional() }).strict();
const strategy = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('selector'), selector: z.string().min(1), attribute: z.string().default('src'), mediaType: z.enum(['direct', 'hls']).optional() }).strict(),
  z.object({ type: z.literal('json'), selector: z.string().min(1), path: z.string().min(1), mediaType: z.enum(['direct', 'hls']).optional() }).strict(),
  z.object({ type: z.literal('pattern'), pattern: z.string().min(1).max(2000), flags: z.string().regex(/^[imsu]*$/).default(''), mediaType: z.enum(['direct', 'hls']).optional() }).strict(),
  z.object({ type: z.literal('iframe'), selector: z.string().default('iframe'), strategies: z.array(strategy).min(1) }).strict(),
]));
const mainSchema = z.object({
  target: z.string().min(1),
  storage: z.object({ temp: z.string(), output: z.string(), reports: z.string(), keepCompleted: z.boolean().default(true) }).strict(),
  retry: z.object({ attempts: positive.max(10).default(3), baseDelayMs: positive.default(500), maxDelayMs: positive.max(300000).default(10000), jitter: z.boolean().default(true) }).strict().prefault({}),
  network: z.object({ timeoutMs: positive.max(2147483647).default(30000), maxPageBytes: positive.max(16777216).default(2097152) }).strict().prefault({}),
  media: z.object({ maxDownloadBytes: positive.default(268435456), processTimeoutMs: positive.max(2147483647).default(300000), maxSegments: positive.max(100000).default(1000) }).strict().prefault({}),
  destination: z.object({ url: z.string(), timeoutMs: positive.max(2147483647).default(120000) }).strict(),
}).strict();
const targetSchema = z.object({
  baseUrl: z.string(), allowedOrigins: z.array(z.string()).min(1),
  headerOrigins: z.array(z.string()).default([]), headersFromEnv: z.record(z.string(), z.string()).default({}),
  discovery: z.object({ startUrls: z.array(z.string()).min(1), pageLinkSelector: z.string().min(1), nextPageSelector: z.string().optional(), maxPages: positive.max(10000).default(10), maxJobs: positive.max(100000).default(100) }).strict(),
  metadata: z.object({ title: field, description: field.optional(), thumbnailUrl: field.optional(), tags: field.optional() }).strict(),
  mediaDiscovery: z.array(strategy).min(1),
  validation: z.object({ requiredMetadata: z.array(z.enum(['title','description','thumbnailUrl','tags'])).default(['title']), minimumBytes: nonnegative.default(1), maximumBytes: positive.default(268435456), minimumDurationSeconds: nonnegative.default(0), maximumDurationSeconds: nonnegative.optional(), minimumWidth: nonnegative.default(0), minimumHeight: nonnegative.default(0), decode: z.boolean().default(false) }).strict().prefault({}),
}).strict();
function parse(schema, data, label) {
  const result = schema.safeParse(data);
  if (!result.success) throw new PipelineError('INVALID_CONFIG', `${label}: ${result.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; ')}`);
  return result.data;
}
export function validateConfig(main, target, { root = process.cwd(), env = process.env } = {}) {
  main = structuredClone(main); target = structuredClone(target);
  if (env.DESTINATION_API_URL) main.destination = { ...main.destination, url: env.DESTINATION_API_URL };
  if (env.MAX_ATTEMPTS) main.retry = { ...main.retry, attempts: Number(env.MAX_ATTEMPTS) };
  if (env.REQUEST_TIMEOUT_MS) main.network = { ...main.network, timeoutMs: Number(env.REQUEST_TIMEOUT_MS) };
  const config = parse(mainSchema, main, 'Main configuration');
  config.target = parse(targetSchema, target, 'Target configuration');
  const t = config.target;
  t.baseUrl = httpUrl(t.baseUrl);
  for (const origin of [...t.allowedOrigins, ...t.headerOrigins]) {
    if (new URL(httpUrl(origin)).origin !== origin) throw new PipelineError('INVALID_CONFIG', 'Origins must contain only scheme, host, and optional port.');
  }
  if (!t.allowedOrigins.includes(new URL(t.baseUrl).origin) || t.headerOrigins.some(o => !t.allowedOrigins.includes(o))) throw new PipelineError('INVALID_CONFIG', 'Base URL and header origins must be allowed.');
  config.destination.url = httpUrl(config.destination.url);
  config.destination.apiKey = env.DESTINATION_API_KEY || '';
  t.headers = {};
  for (const [header, variable] of Object.entries(t.headersFromEnv)) {
    if (!env[variable]) throw new PipelineError('INVALID_CONFIG', 'A configured source-header environment variable is missing.');
    t.headers[header] = env[variable];
  }
  try { new Headers(t.headers); new Headers({ authorization: `Bearer ${config.destination.apiKey}` }); }
  catch { throw new PipelineError('INVALID_CONFIG', 'Configured HTTP headers are invalid.'); }
  if (Object.keys(t.headers).length && !t.headerOrigins.length) throw new PipelineError('INVALID_CONFIG', 'Source headers require explicit headerOrigins.');
  const $ = load('');
  const checkSelector = s => { if (s) $(s); };
  const checkStrategies = (items, depth = 0) => {
    if (depth > 3) throw new Error('Iframe depth exceeds three');
    for (const item of items) {
      checkSelector(item.selector);
      if (item.type === 'pattern') new RegExp(item.pattern, item.flags);
      if (item.type === 'iframe') checkStrategies(item.strategies, depth + 1);
    }
  };
  try {
    checkSelector(t.discovery.pageLinkSelector); checkSelector(t.discovery.nextPageSelector);
    for (const rule of Object.values(t.metadata)) checkSelector(rule.selector);
    checkStrategies(t.mediaDiscovery);
  } catch { throw new PipelineError('INVALID_CONFIG', 'Invalid selector, regular expression, or iframe nesting depth.'); }
  for (const name of ['title', 'description', 'thumbnailUrl']) {
    if (t.metadata[name]?.multiple) throw new PipelineError('INVALID_CONFIG', 'Only tags may use multiple metadata values.');
  }
  const v = t.validation;
  if (v.minimumBytes > v.maximumBytes || (v.maximumDurationSeconds !== undefined && v.minimumDurationSeconds > v.maximumDurationSeconds)) throw new PipelineError('INVALID_CONFIG', 'Validation minimum must not exceed maximum.');
  config.media.maxDownloadBytes = Math.min(config.media.maxDownloadBytes, v.maximumBytes);
  for (const key of ['temp', 'output', 'reports']) config.storage[key] = resolve(root, config.storage[key]);
  config.ffmpegPath = env.FFMPEG_PATH || 'ffmpeg'; config.ffprobePath = env.FFPROBE_PATH || 'ffprobe';
  config.logLevel = env.LOG_LEVEL || 'info';
  if (!['debug','info','warn','error','silent'].includes(config.logLevel)) throw new PipelineError('INVALID_CONFIG', 'LOG_LEVEL is invalid.');
  return config;
}
export async function loadConfig(file, { env = process.env, loadDotEnv = true } = {}) {
  if (loadDotEnv) {
    try { loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const filename = resolve(file || env.PIPELINE_CONFIG || 'config/main.json');
  try {
    const main = JSON.parse(await readFile(filename, 'utf8'));
    const target = JSON.parse(await readFile(resolve(dirname(filename), main.target), 'utf8'));
    return validateConfig(main, target, { root: dirname(filename), env });
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new PipelineError('CONFIG_READ_FAILED', 'Could not read main/target JSON configuration. Check paths and JSON syntax.', { cause: error });
  }
}
