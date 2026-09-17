import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from '../../src/utilities/process.mjs';

/** Owned synthetic media; nothing is downloaded from a third-party website. */
export async function generateMedia(directory, ffmpegPath = 'ffmpeg') {
  await mkdir(directory, { recursive: true });
  for (const [index, color] of ['blue','red','green','yellow'].entries()) {
    await runProcess(ffmpegPath, ['-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`color=c=${color}:s=160x90:r=15:d=1.2`,'-f','lavfi','-i',`sine=frequency=${440 + index*110}:sample_rate=44100:duration=1.2`,'-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-g','15','-c:a','aac','-shortest',join(directory,`${index+1}.mp4`)]);
  }
  await runProcess(ffmpegPath, ['-nostdin','-hide_banner','-loglevel','error','-y','-i',join(directory,'2.mp4'),'-c','copy','-hls_time','1','-hls_list_size','0','-hls_segment_filename',join(directory,'segment-%03d.ts'),'-f','hls',join(directory,'index.m3u8')]);
  await writeFile(join(directory,'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90\nindex.m3u8\n');
}
const page = (title, media) => `<!doctype html><html><head><meta name="description" content="A synthetic pipeline demo clip."><meta property="og:image" content="/thumbnail.svg"></head><body><h1>${title}</h1><span class="tag">demo</span><span class="tag">synthetic</span>${media}</body></html>`;
export async function startDemoServer({ directory, faults = true, port = 0, ffmpegPath = 'ffmpeg', generate = true } = {}) {
  const mediaDir = join(directory,'source'), receivedDir = join(directory,'received');
  if (generate) await generateMedia(mediaDir, ffmpegPath);
  await mkdir(receivedDir, { recursive: true });
  const counts = new Map(), receipts = new Map();
  let uploadAttempts = 0, dropped = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    counts.set(path, (counts.get(path) || 0) + 1);
    const reply = (status, body, type = 'text/html') => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    try {
      if (path === '/list') return reply(200, '<a class="video" href="/video/direct">direct</a><a class="video" href="/video/hls">hls</a><a class="video" href="/video/iframe">iframe</a><a class="video" href="/video/duplicate">duplicate</a><a class="next" href="/list/2">next</a>');
      if (path === '/list/2') return reply(200, '<a class="video" href="/video/corrupt">corrupt</a><a class="video" href="/video/missing">missing</a><a class="video" href="/video/fallback">fallback</a><a class="video" href="/video/direct#duplicate">repeat</a><a class="next" href="/list">cycle</a>');
      const pages = {
        '/video/direct': page('Direct clip', '<video src="/media/1.mp4"></video>'),
        '/video/hls': page('HLS clip', '<script id="player-data" type="application/json">{"media":{"url":"/media/master.m3u8"}}</script>'),
        '/video/iframe': page('Embedded clip', '<iframe src="/player"></iframe>'),
        '/player': '<video src="/media/3.mp4"></video>',
        '/video/duplicate': page('Same bytes, different page', '<video src="/media/1.mp4"></video>'),
        '/video/corrupt': page('Corrupt input', '<video src="/corrupt.mp4"></video>'),
        '/video/missing': page('Missing media', '<video src="/missing.mp4"></video>'),
        '/video/fallback': page('Fallback clip', '<video src="/missing.mp4"></video><script id="player-data" type="application/json">{"media":{"url":"/media/4.mp4"}}</script>'),
      };
      if (pages[path]) return reply(200, pages[path]);
      if (path === '/corrupt.mp4') return reply(200, 'This is deliberately not a video.'.repeat(10), 'video/mp4');
      if (path === '/redirect-good') { res.writeHead(302, { location: '/media/1.mp4' }); return res.end(); }
      if (path === '/redirect-bad') { res.writeHead(302, { location: 'http://example.invalid/private' }); return res.end(); }
      if (path === '/slow') { res.writeHead(200); res.write('start'); return; }
      if (path === '/truncated') {
        const bytes = await readFile(join(mediaDir, '1.mp4'));
        res.writeHead(200, { 'content-length': bytes.length });
        if (counts.get(path) === 1) { res.write(bytes.subarray(0, 100)); setTimeout(() => res.destroy(), 20); }
        else res.end(bytes);
        return;
      }
      if (path.startsWith('/media/')) {
        const file = basename(path);
        if (!/^(\d\.mp4|master\.m3u8|index\.m3u8|segment-\d{3}\.ts)$/.test(file)) return reply(404, 'Missing');
        if (faults && ['/media/1.mp4','/media/segment-000.ts'].includes(path) && counts.get(path) === 1) {
          res.setHeader('Retry-After', '0'); return reply(503, 'Try again');
        }
        const data = await readFile(join(mediaDir, file));
        return reply(200, data, file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.ts') ? 'video/mp2t' : 'video/mp4');
      }
      if (path === '/api/media' && req.method === 'POST') {
        uploadAttempts++;
        if (faults && uploadAttempts === 1) { req.resume(); return reply(503, 'Temporary destination failure'); }
        const key = req.headers['idempotency-key'];
        if (!key || !/^[a-f0-9]{64}$/.test(key)) { req.resume(); return reply(400, 'Idempotency-Key required'); }
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 8388608) { reply(413, 'Demo upload limit: 8 MiB'); req.destroy(); return; }
          chunks.push(chunk);
        }
        const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const metadata = JSON.parse(form.get('metadata'));
        const file = Buffer.from(await form.get('file').arrayBuffer());
        const sha256 = createHash('sha256').update(file).digest('hex');
        const expectedKey = createHash('sha256').update(metadata.sourceUrl).update('\0').update(sha256).digest('hex');
        if (metadata.sha256 !== sha256 || key !== expectedKey) return reply(422, 'Hash or idempotency key mismatch');
        let receipt = receipts.get(key);
        if (!receipt) {
          receipt = { id: `demo-${receipts.size + 1}`, sha256, metadata, bytes: file.length };
          await writeFile(join(receivedDir, receipt.id + '.mp4'), file);
          await writeFile(join(receivedDir, receipt.id + '.json'), JSON.stringify(metadata, null, 2));
          receipts.set(key, receipt);
          if (faults && !dropped) { dropped = true; return res.destroy(); } // Accepted, but acknowledgement lost.
        }
        return reply(200, JSON.stringify({ id: receipt.id }), 'application/json');
      }
      return reply(404, 'Missing');
    } catch (error) {
      if (!res.headersSent) reply(error.code === 'ENOENT' ? 404 : 500, 'Demo request failed');
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, counts, receipts, get uploadAttempts() { return uploadAttempts; }, receivedDir,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
