import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractMetadata } from '../../src/extractors/metadata.mjs';
import { mediaCandidates } from '../../src/extractors/media.mjs';
const fixture = await readFile(new URL('../fixtures/video-page.html', import.meta.url), 'utf8');
const target = JSON.parse(await readFile(new URL('../../config/targets/demo.json', import.meta.url), 'utf8'));
test('metadata normalizes whitespace, entities, tags, and thumbnail URLs', () => {
  const metadata = extractMetadata(fixture, 'http://example.test/video/1', target.metadata);
  assert.equal(metadata.title, 'A & B'); assert.deepEqual(metadata.tags, ['one','two']);
  assert.equal(metadata.thumbnailUrl, 'http://example.test/cover.png');
});
test('selector and JSON discovery preserve configured fallback order', async () => {
  const result = [];
  for await (const candidate of mediaCandidates(fixture, 'http://example.test/video/1', target.mediaDiscovery, { allowedOrigins: ['http://example.test'] })) result.push(candidate);
  assert.deepEqual(result, [{ type: 'direct', url: 'http://example.test/missing.mp4' }, { type: 'direct', url: 'http://example.test/valid.mp4' }]);
});
test('pattern discovery resolves relative URLs and rejects disallowed origins', async () => {
  const strategies = [{ type: 'pattern', pattern: 'media="([^"]+)"', flags: '', mediaType: 'hls' }];
  const result = [];
  for await (const candidate of mediaCandidates('media="/a.m3u8"', 'http://example.test/a', strategies, { allowedOrigins: ['http://example.test'] })) result.push(candidate);
  assert.equal(result[0].type, 'hls');
  const blocked = [];
  for await (const candidate of mediaCandidates('media="http://other.test/a"', 'http://example.test/a', strategies, { allowedOrigins: ['http://example.test'] })) blocked.push(candidate);
  assert.deepEqual(blocked, []);
});
test('iframe cycles terminate', async () => {
  let requests = 0;
  const result = [];
  for await (const candidate of mediaCandidates('<iframe src="/loop"></iframe>', 'http://example.test/loop', [{ type: 'iframe', selector: 'iframe', strategies: target.mediaDiscovery }], {
    allowedOrigins: ['http://example.test'], client: { text() { requests++; throw new Error('Should not fetch a visited URL'); } },
  })) result.push(candidate);
  assert.equal(requests, 0); assert.deepEqual(result, []);
});
