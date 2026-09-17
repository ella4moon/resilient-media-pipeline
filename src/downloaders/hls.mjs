import { mkdir, writeFile, stat, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { downloadDirect } from './direct.mjs';
import { PipelineError } from '../utilities/errors.mjs';
import { httpUrl, checkOrigin } from '../utilities/url.mjs';
import { runProcess } from '../utilities/process.mjs';

const unsupported = () => new PipelineError('UNSUPPORTED_HLS', 'V1 requires unencrypted finite HLS with muxed audio, no byte ranges, and at most one init segment.');
export function parsePlaylist(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new PipelineError('INVALID_HLS', 'Response is not an HLS playlist.');
  if (lines.some(l => l.startsWith('#EXT-X-KEY:') && !/^#EXT-X-KEY:METHOD=NONE$/.test(l)) ||
      lines.some(l => /^#EXT-X-(BYTERANGE|SESSION-KEY|I-FRAMES-ONLY|PART|SKIP)/.test(l))) throw unsupported();
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      if (/\bAUDIO=/.test(lines[i])) throw unsupported();
      if (!lines[i+1] || lines[i+1].startsWith('#')) throw new PipelineError('INVALID_HLS', 'Variant URI is missing.');
      variants.push({ url: lines[i+1], bandwidth: Number(/(?:^|[:,])BANDWIDTH=(\d+)/.exec(lines[i])?.[1] || 0) });
    }
  }
  if (variants.length) return { variants: variants.sort((a,b) => b.bandwidth - a.bandwidth) };
  if (!lines.includes('#EXT-X-ENDLIST')) throw unsupported();
  const maps = lines.filter(l => l.startsWith('#EXT-X-MAP:'));
  if (maps.length > 1 || maps.some(l => /BYTERANGE=/.test(l))) throw unsupported();
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXTINF:')) {
      const duration = Number(lines[i].slice(8).split(',')[0]);
      let j = i + 1;
      while (lines[j]?.startsWith('#')) j++;
      if (!Number.isFinite(duration) || duration <= 0 || !lines[j]) throw new PipelineError('INVALID_HLS', 'Invalid HLS segment.');
      segments.push({ url: lines[j], duration, lineIndex: j });
    }
  }
  if (!segments.length) throw new PipelineError('INVALID_HLS', 'HLS playlist has no segments.');
  // Unknown URI-bearing tags must never cause FFmpeg to fetch additional resources.
  if (lines.some(l => l.includes('URI=') && !l.startsWith('#EXT-X-MAP:'))) throw unsupported();
  const init = maps.length ? /URI="([^"]+)"/.exec(maps[0])?.[1] : undefined;
  if (maps.length && !init) throw unsupported();
  return { lines, segments, init, duration: segments.reduce((sum, s) => sum + s.duration, 0) };
}
export async function downloadHls(url, path, { client, maxBytes, signal, ffmpegPath, timeoutMs, maxSegments, allowedOrigins, maxPageBytes }) {
  const folder = join(dirname(path), 'hls');
  await mkdir(folder, { recursive: true });
  const partial = `${path}.part`;
  try {
    let playlist, playlistUrl = url;
    for (let depth = 0; depth < 4; depth++) {
      const response = await client.text(playlistUrl, { signal, maxBytes: maxPageBytes });
      playlistUrl = response.url;
      playlist = parsePlaylist(response.text);
      if (!playlist.variants) break;
      playlistUrl = checkOrigin(httpUrl(playlist.variants[0].url, playlistUrl), allowedOrigins);
    }
    if (playlist.variants) throw new PipelineError('INVALID_HLS', 'Nested master playlist limit exceeded.');
    if (playlist.segments.length > maxSegments) throw new PipelineError('HLS_SEGMENT_LIMIT', 'HLS exceeds the configured segment limit.');
    let downloadedBytes = 0;
    const get = async (relative, filename) => {
      if (downloadedBytes >= maxBytes) throw new PipelineError('MEDIA_TOO_LARGE', 'HLS exceeds the total download byte limit.');
      const resource = checkOrigin(httpUrl(relative, playlistUrl), allowedOrigins);
      const file = await downloadDirect(resource, join(folder, filename), { client, maxBytes: maxBytes - downloadedBytes, signal });
      downloadedBytes += file.bytes;
    };
    // Rebuild an allowlisted local playlist; never pass remote playlist text to FFmpeg.
    const local = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:' + Math.ceil(Math.max(...playlist.segments.map(s => s.duration))), '#EXT-X-MEDIA-SEQUENCE:0'];
    if (playlist.init) { await get(playlist.init, 'init.mp4'); local.push('#EXT-X-MAP:URI="init.mp4"'); }
    for (let i = 0; i < playlist.segments.length; i++) {
      const segment = playlist.segments[i];
      const filename = `segment-${i}.${playlist.init ? 'm4s' : 'ts'}`;
      await get(segment.url, filename);
      const previousIndex = i ? playlist.segments[i-1].lineIndex + 1 : 0;
      if (playlist.lines.slice(previousIndex, segment.lineIndex).includes('#EXT-X-DISCONTINUITY')) local.push('#EXT-X-DISCONTINUITY');
      local.push(`#EXTINF:${segment.duration},`, filename);
    }
    local.push('#EXT-X-ENDLIST');
    const manifest = join(folder, 'local.m3u8');
    await writeFile(manifest, local.join('\n') + '\n');
    await runProcess(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-y', '-protocol_whitelist', 'file', '-i', manifest, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', partial], { signal, timeoutMs });
    const { size } = await stat(partial);
    if (!size || size > maxBytes) throw new PipelineError('MEDIA_TOO_LARGE', 'Assembled HLS is empty or exceeds the byte limit.');
    await rename(partial, path);
    return { path, bytes: size, contentType: 'video/mp4', expectedDurationSeconds: playlist.duration };
  } finally {
    await rm(partial, { force: true });
    await rm(folder, { recursive: true, force: true });
  }
}
