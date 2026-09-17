import { load } from 'cheerio';
import { httpUrl, checkOrigin } from '../utilities/url.mjs';
import { errorInfo } from '../utilities/errors.mjs';
export class WebSource {
  constructor(target, client, { maxPageBytes, logger }) { Object.assign(this, { target, client, maxPageBytes, logger }); }
  async *discover({ signal, onError = () => {} } = {}) {
    const { discovery: d, baseUrl, allowedOrigins } = this.target;
    const pending = d.startUrls.map(u => httpUrl(u, baseUrl));
    const visited = new Set();
    let jobs = 0;
    while (pending.length && visited.size < d.maxPages && jobs < d.maxJobs) {
      signal?.throwIfAborted();
      const url = pending.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        const page = await this.client.text(checkOrigin(url, allowedOrigins), { signal, maxBytes: this.maxPageBytes });
        const $ = load(page.text);
        const links = $(d.pageLinkSelector).toArray();
        for (const element of links) {
          if (jobs >= d.maxJobs) break;
          const href = $(element).attr('href');
          if (!href) continue;
          let normalized;
          try { normalized = checkOrigin(httpUrl(href, page.url), allowedOrigins); } catch { continue; }
          jobs++;
          yield normalized;
        }
        if (d.nextPageSelector) {
          for (const element of $(d.nextPageSelector).toArray()) {
            const href = $(element).attr('href');
            if (!href) continue;
            try {
              const next = checkOrigin(httpUrl(href, page.url), allowedOrigins);
              if (!visited.has(next) && !pending.includes(next) && pending.length < d.maxPages) pending.push(next);
            } catch { /* Ignore links outside the configured crawl boundary. */ }
          }
        }
      } catch (error) {
        signal?.throwIfAborted();
        const info = errorInfo(error);
        onError(info); this.logger?.warn('listing_failed', info);
      }
    }
  }
}
