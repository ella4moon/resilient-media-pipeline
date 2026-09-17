import { createWriteStream } from 'node:fs';
import { rm, rename } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PipelineError } from '../utilities/errors.mjs';

export async function downloadDirect(url, path, { client, maxBytes, signal }) {
  const partial = `${path}.part`;
  try {
    return await client.request(url, { signal }, async (response, timedSignal) => {
      const declared = response.headers.get('content-length');
      if (declared && Number(declared) > maxBytes) throw new PipelineError('MEDIA_TOO_LARGE', 'Media exceeds the download byte limit.');
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new PipelineError('MEDIA_TOO_LARGE', 'Media exceeds the download byte limit.') : null, chunk);
      } });
      try {
        if (!response.body) throw new PipelineError('EMPTY_MEDIA', 'Media response has no body.');
        await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(partial, { flags: 'w', mode: 0o600 }), { signal: timedSignal });
        if (!bytes) throw new PipelineError('EMPTY_MEDIA', 'Media response is empty.');
        await rename(partial, path);
        return { path, bytes, contentType: (response.headers.get('content-type') || 'application/octet-stream').split(';')[0] };
      } finally { await rm(partial, { force: true }); }
    });
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
