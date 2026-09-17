import { load } from 'cheerio';
import { checkOrigin, httpUrl } from '../utilities/url.mjs';
import { PipelineError } from '../utilities/errors.mjs';

/** Lazy ordered candidates: the pipeline may fall back after a download fails. */
export async function* mediaCandidates(html, pageUrl, strategies, { client, allowedOrigins, maxPageBytes, signal, logger, visited = new Set(), depth = 0 }) {
  if (depth > 3 || visited.has(pageUrl)) return;
  visited.add(pageUrl);
  const $ = load(html);
  const seen = new Set();
  for (const rule of strategies) {
    signal?.throwIfAborted();
    try {
      if (rule.type === 'iframe') {
        for (const element of $(rule.selector).toArray().slice(0, 10)) {
          const src = $(element).attr('src');
          if (!src) continue;
          try {
            const url = checkOrigin(httpUrl(src, pageUrl), allowedOrigins);
            if (visited.has(url)) continue;
            const frame = await client.text(url, { signal, maxBytes: maxPageBytes });
            yield* mediaCandidates(frame.text, frame.url, rule.strategies, { client, allowedOrigins, maxPageBytes, signal, logger, visited, depth: depth + 1 });
          } catch (error) {
            signal?.throwIfAborted();
            logger?.debug('iframe_failed', { code: error.code || 'EXTRACTION_FAILED' });
          }
        }
        continue;
      }
      let values = [];
      if (rule.type === 'selector') values = $(rule.selector).toArray().map(el => $(el).attr(rule.attribute));
      if (rule.type === 'json') {
        for (const element of $(rule.selector).toArray()) {
          try {
            let value = JSON.parse($(element).text());
            for (const key of rule.path.split('.')) value = value && Object.hasOwn(value, key) ? value[key] : undefined;
            values.push(value);
          } catch { /* Other strategies can still succeed. */ }
        }
      }
      if (rule.type === 'pattern') values = [new RegExp(rule.pattern, rule.flags).exec(html)?.[1]];
      for (const value of values.slice(0, 20)) {
        if (typeof value !== 'string' || !value.trim()) continue;
        let url;
        try { url = checkOrigin(httpUrl(value, pageUrl), allowedOrigins); } catch { continue; }
        const type = rule.mediaType || (/\.m3u8$/i.test(new URL(url).pathname) ? 'hls' : 'direct');
        const key = `${type}:${url}`;
        if (!seen.has(key)) { seen.add(key); yield { type, url }; }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof PipelineError)) throw error;
      logger?.debug('strategy_failed', { code: error.code });
    }
  }
}
