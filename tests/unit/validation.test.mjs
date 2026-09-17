import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMediaFacts, validateMetadata } from '../../src/validators/media.mjs';
import { parsePlaylist } from '../../src/downloaders/hls.mjs';
import { errorInfo } from '../../src/utilities/errors.mjs';
const rules = { minimumBytes: 10, maximumBytes: 100, minimumDurationSeconds: 1, maximumDurationSeconds: 10, minimumWidth: 64, minimumHeight: 64, requiredMetadata: ['title','tags'] };
test('rejects absent metadata and invalid video facts', () => {
  assert.deepEqual(validateMetadata({ title: ' ', tags: [] }, rules), ['missing_title','missing_tags']);
  assert.deepEqual(checkMediaFacts({ hasVideo: true, bytes: 50, durationSeconds: 2, width: 100, height: 100 }, rules), []);
  assert.deepEqual(checkMediaFacts({ hasVideo: false, bytes: 101, durationSeconds: NaN, width: 0, height: 0 }, rules), ['missing_video_stream','invalid_duration','file_too_large','width_too_small','height_too_small']);
});
test('HLS selects highest bandwidth and parses VOD durations', () => {
  const master = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=300\nb.m3u8');
  assert.equal(master.variants[0].url, 'b.m3u8');
  assert.equal(parsePlaylist('#EXTM3U\n#EXTINF:1.2,\na.ts\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST').duration, 3.2);
});
test('HLS rejects live, encrypted, byte-range, and external-audio formats explicitly', () => {
  for (const text of ['#EXTM3U\n#EXTINF:1,\na.ts', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXTM3U\n#EXT-X-BYTERANGE:100@0', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nx.m3u8']) {
    assert.throws(() => parsePlaylist(text), { code: 'UNSUPPORTED_HLS' });
  }
});
test('arbitrary errors never expose signed URLs or tokens in reports', () => {
  assert.ok(!JSON.stringify(errorInfo(new Error('https://secret.test/?token=SECRET'))).includes('SECRET'));
});
