import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { startDemoServer } from './demo-site/server.mjs';
import { validateConfig } from '../src/config.mjs';
import { createPipeline } from '../src/create-pipeline.mjs';
import { createLogger } from '../src/utilities/logger.mjs';
import { errorInfo } from '../src/utilities/errors.mjs';

const controller = new AbortController();
const stop = () => controller.abort(new Error('Demo cancelled'));
process.on('SIGINT', stop); process.on('SIGTERM', stop);
let server;
try {
  const directory = resolve('storage/demo', randomUUID());
  await mkdir(directory, { recursive: true });
  console.log('Generating four small synthetic clips and starting the local demo...');
  server = await startDemoServer({ directory, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg' });
  const main = JSON.parse(await readFile(new URL('../config/main.json', import.meta.url), 'utf8'));
  const target = JSON.parse(await readFile(new URL('../config/targets/demo.json', import.meta.url), 'utf8'));
  target.baseUrl = server.baseUrl; target.allowedOrigins = [server.baseUrl];
  main.destination.url = `${server.baseUrl}/api/media`;
  main.storage = { temp: 'temp', output: 'output', reports: 'reports', keepCompleted: true };
  main.retry = { attempts: 3, baseDelayMs: 50, maxDelayMs: 1000, jitter: false };
  // Demo ignores real destination credentials and target settings, including .env.
  const config = validateConfig(main, target, { root: directory, env: { FFMPEG_PATH: process.env.FFMPEG_PATH, FFPROBE_PATH: process.env.FFPROBE_PATH } });
  const result = await createPipeline(config).run({ signal: controller.signal });
  if (controller.signal.aborted) process.exitCode = 130;
  else {
    assert.deepEqual(result.summary, { total: 8, completed: 4, skipped: 3, failed: 1, cancelled: 0 });
    assert.equal(server.receipts.size, 4);
    assert.equal(server.uploadAttempts, 6);
    console.log('\nDemo passed: 4 uploads, 3 intentional skips, 1 isolated missing-media failure.');
    console.log('Recovered from source/API 503s and an accepted upload with a lost acknowledgement.');
    console.log(`Report: ${result.reportPath}\nReceived media: ${server.receivedDir}`);
  }
} catch (error) {
  createLogger().error('demo_failed', errorInfo(error));
  // Assertion diagnostics contain only local demo expectations.
  if (error.code === 'ERR_ASSERTION') console.error(error.message);
  process.exitCode = 1;
} finally {
  await server?.close();
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
}
