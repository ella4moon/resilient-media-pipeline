import { openAsBlob } from 'node:fs';
import { createHash } from 'node:crypto';
import { HttpClient, readBytes } from '../utilities/network.mjs';
import { PipelineError } from '../utilities/errors.mjs';

export class HttpDestination {
  constructor(config, { retry, logger }) {
    this.config = config;
    this.client = new HttpClient({ allowedOrigins: [new URL(config.url).origin], timeoutMs: config.timeoutMs, retry, logger });
  }
  async publish({ metadata, file, sha256, facts }, { signal } = {}) {
    // Stable across retries and restarts. Destination must enforce this contract.
    const key = createHash('sha256').update(metadata.sourceUrl).update('\0').update(sha256).digest('hex');
    const headers = { 'Idempotency-Key': key };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return this.client.request(this.config.url, { method: 'POST', signal, headers, bodyFactory: async () => {
      const form = new FormData();
      form.set('metadata', JSON.stringify({ ...metadata, sha256, media: facts }));
      form.set('file', await openAsBlob(file.path, { type: file.contentType }), 'media.bin');
      return form;
    } }, async response => {
      let receipt;
      try { receipt = JSON.parse((await readBytes(response, 65536)).toString('utf8')); }
      catch (error) {
        if (error instanceof SyntaxError) throw new PipelineError('INVALID_RECEIPT', 'Destination must return a JSON receipt containing id.');
        throw error;
      }
      if (!receipt || !['string','number'].includes(typeof receipt.id) || String(receipt.id).trim() === '') throw new PipelineError('INVALID_RECEIPT', 'Destination must return a JSON receipt containing id.');
      // Do not persist arbitrary response fields (which may contain credentials).
      return { id: String(receipt.id), idempotencyKey: key };
    });
  }
}
