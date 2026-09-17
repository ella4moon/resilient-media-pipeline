import { load } from 'cheerio';
import { httpUrl } from '../utilities/url.mjs';
export function extractMetadata(html, pageUrl, rules) {
  const $ = load(html);
  const result = { sourceUrl: pageUrl, title: '', tags: [] };
  for (const [name, rule] of Object.entries(rules)) {
    const values = $(rule.selector).toArray().map(element => {
      const raw = rule.attribute ? $(element).attr(rule.attribute) : $(element).text();
      return (raw || '').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    result[name] = rule.multiple || name === 'tags' ? [...new Set(values)] : values[0] || '';
  }
  if (result.thumbnailUrl) {
    try { result.thumbnailUrl = httpUrl(result.thumbnailUrl, pageUrl); } catch { result.thumbnailUrl = ''; }
  }
  return result;
}
