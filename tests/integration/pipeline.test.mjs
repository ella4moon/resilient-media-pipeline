import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoServer } from '../../examples/demo-site/server.mjs';
import { validateConfig } from '../../src/config.mjs';
import { createPipeline } from '../../src/create-pipeline.mjs';
import { HttpClient } from '../../src/utilities/network.mjs';
import { downloadDirect } from '../../src/downloaders/direct.mjs';
import { downloadHls } from '../../src/downloaders/hls.mjs';
import { createLogger } from '../../src/utilities/logger.mjs';
import { runProcess } from '../../src/utilities/process.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const main = JSON.parse(await readFile(new URL('../../config/main.json', import.meta.url), 'utf8'));
const target = JSON.parse(await readFile(new URL('../../config/targets/demo.json', import.meta.url), 'utf8'));
let directory, server;
const logger = createLogger('silent');
const policy = { attempts: 3, baseDelayMs: 5, maxDelayMs: 20, jitter: false };
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pipeline-tests-'));
  server = await startDemoServer({ directory });
});
after(async () => { await server?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
function configuration(name, overrides = {}) {
  return validateConfig({ ...main, retry: policy, storage: { temp: `${name}/temp`, output: `${name}/output`, reports: `${name}/reports`, keepCompleted: true }, destination: { url: `${server.baseUrl}/api/media`, timeoutMs: 1000 }, ...overrides },
    { ...target, baseUrl: server.baseUrl, allowedOrigins: [server.baseUrl] }, { root: directory, env: { LOG_LEVEL: 'silent' } });
}
function client(overrides = {}) { return new HttpClient({ allowedOrigins: [server.baseUrl], timeoutMs: 1000, retry: policy, logger, ...overrides }); }

test('real pipeline: pagination, direct/HLS/iframe/fallback, validation, dedupe, retry and upload acknowledgement loss', async () => {
  const config = configuration('complete');
  const result = await createPipeline(config, { logger }).run();
  assert.deepEqual(result.summary, { total: 8, completed: 4, skipped: 3, failed: 1, cancelled: 0 });
  assert.equal(result.status, 'failed'); // An intentionally missing video, not a hidden failure.
  assert.equal(server.receipts.size, 4); assert.equal(server.uploadAttempts, 6);
  assert.equal(server.counts.get('/media/segment-000.ts'), 2);
  assert.equal(server.counts.get('/list'), 1); assert.equal(server.counts.get('/list/2'), 1);
  assert.deepEqual(await readdir(config.storage.temp), []);
  assert.equal(JSON.parse(await readFile(result.reportPath)).summary.completed, 4);
  const hls = result.jobs.find(j => j.media?.type === 'hls');
  assert.ok(hls.media.hasAudio); assert.ok(hls.media.durationSeconds > 1);
  for (const job of result.jobs.filter(j => j.status === 'completed')) assert.ok((await readFile(job.media.localPath)).length > 100);
});
test('streaming download retries an interrupted body and removes partial files', async () => {
  const path = join(directory, 'truncated.bin');
  const file = await downloadDirect(`${server.baseUrl}/truncated`, path, { client: client(), maxBytes: 100000, signal: undefined });
  assert.ok(file.bytes > 100); assert.equal(server.counts.get('/truncated'), 2);
  assert.deepEqual(await readFile(path), await readFile(join(directory, 'source/1.mp4')));
  assert.ok(!(await readdir(directory)).some(name => name.endsWith('.part')));
});
test('oversized download is rejected without retries or partial output', async () => {
  const path = join(directory, 'too-large.bin');
  const before = server.counts.get('/media/4.mp4') || 0;
  await assert.rejects(downloadDirect(`${server.baseUrl}/media/4.mp4`, path, { client: client(), maxBytes: 5 }), { code: 'MEDIA_TOO_LARGE' });
  assert.equal(server.counts.get('/media/4.mp4'), before + 1);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  await assert.rejects(readFile(path + '.part'), { code: 'ENOENT' });
});
test('redirects stay within allowlist and POST redirects are rejected', async () => {
  const result = await client().text(`${server.baseUrl}/redirect-good`);
  assert.ok(result.text.length > 100);
  await assert.rejects(client().text(`${server.baseUrl}/redirect-bad`), { code: 'ORIGIN_BLOCKED' });
  await assert.rejects(client().request(`${server.baseUrl}/redirect-good`, { method: 'POST' }, () => {}), { code: 'REDIRECT_REJECTED' });
});
test('HTTP timeout includes the response body, not only headers', async () => {
  const c = client({ timeoutMs: 30, retry: { ...policy, attempts: 1 } });
  await assert.rejects(c.text(`${server.baseUrl}/slow`), { code: 'REQUEST_TIMEOUT' });
});
test('abort during download cancels the active job, writes a report, and cleans temp storage', async () => {
  const config = configuration('cancel');
  const controller = new AbortController();
  const pipeline = createPipeline(config, { logger, source: { async *discover() { yield `${server.baseUrl}/video/direct`; } } });
  pipeline.downloaders.direct = (url, path, options) => {
    setTimeout(() => controller.abort(), 25);
    return downloadDirect(`${server.baseUrl}/slow`, path, options);
  };
  const result = await pipeline.run({ signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.jobs[0].status, 'cancelled');
  assert.equal(result.jobs[0].stage, 'download');
  assert.deepEqual(await readdir(config.storage.temp), []);
  assert.equal(JSON.parse(await readFile(result.reportPath)).status, 'cancelled');
});
test('an unavailable listing is reported while subsequent start URLs still run', async () => {
  const config = configuration('listing-error');
  config.target.discovery.startUrls = ['/does-not-exist', '/list']; config.target.discovery.maxJobs = 1;
  const result = await createPipeline(config, { logger, destination: { async publish() { return { id: 'test' }; } } }).run();
  assert.equal(result.sourceErrors.length, 1); assert.equal(result.summary.completed, 1); assert.equal(result.status, 'failed');
});
test('HLS missing segment fails and removes downloaded segment files', async () => {
  const { mkdir } = await import('node:fs/promises');
  const folder = join(directory, 'broken-hls'); await mkdir(folder);
  const c = client();
  c.text = async () => ({ url: `${server.baseUrl}/media/index.m3u8`, text: '#EXTM3U\n#EXTINF:1,\n1.mp4\n#EXTINF:1,\nmissing.ts\n#EXT-X-ENDLIST' });
  await assert.rejects(downloadHls(`${server.baseUrl}/media/index.m3u8`, join(folder, 'media.bin'), { client: c, maxBytes: 100000, ffmpegPath: 'ffmpeg', timeoutMs: 1000, maxSegments: 10, allowedOrigins: [server.baseUrl], maxPageBytes: 10000 }), { code: 'HTTP_404' });
  assert.deepEqual(await readdir(folder), []);
});
test('process cancellation waits for process exit and reports missing executables', async () => {
  const controller = new AbortController();
  const promise = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(promise, { name: 'AbortError' });
  await assert.rejects(runProcess('pipeline-nonexistent-executable', [], { timeoutMs: 1000 }), { code: 'PROCESS_UNAVAILABLE' });
});
test('CLI SIGTERM exits 143 after writing a cancelled run report', async () => {
  const localTarget = { ...target, baseUrl: server.baseUrl, allowedOrigins: [server.baseUrl], discovery: { ...target.discovery, startUrls: ['/slow'] } };
  const targetPath = join(directory,'cli-target.json'), configPath = join(directory,'cli.json');
  await writeFile(targetPath, JSON.stringify(localTarget));
  await writeFile(configPath, JSON.stringify({ ...main, target: targetPath, storage: { temp: 'cli/temp', output: 'cli/output', reports: 'cli/reports', keepCompleted: false } }));
  const env = { ...process.env, PIPELINE_CONFIG: configPath, LOG_LEVEL: 'silent', DESTINATION_API_URL: `${server.baseUrl}/api/media` };
  const child = spawn(process.execPath, ['src/main.js'], { cwd: new URL('../../', import.meta.url), env, stdio: 'pipe' });
  const closed = once(child, 'close');
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await readdir(join(directory,'cli/reports'))).some(n => n.endsWith('.json'))) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.kill('SIGTERM');
  const [code] = await closed;
  assert.ok(ready, 'CLI started'); assert.equal(code, 143);
  const [filename] = await readdir(join(directory,'cli/reports'));
  assert.equal(JSON.parse(await readFile(join(directory,'cli/reports',filename))).status, 'cancelled');
});
test('failed publication does not poison content dedupe; a later identical file can publish', async () => {
  const { PipelineError } = await import('../../src/utilities/errors.mjs');
  const config = configuration('publish-failure'); config.storage.keepCompleted = false;
  let calls = 0;
  const pipeline = createPipeline(config, { logger,
    source: { async *discover() { yield `${server.baseUrl}/video/direct`; yield `${server.baseUrl}/video/duplicate`; } },
    destination: { async publish() { if (++calls === 1) throw new PipelineError('HTTP_503', 'Destination unavailable.'); return { id: 'accepted' }; } },
  });
  const result = await pipeline.run();
  assert.deepEqual(result.jobs.map(job => job.status), ['failed','completed']);
  assert.equal(calls, 2); assert.deepEqual(await readdir(config.storage.temp), []);
  await assert.rejects(readdir(config.storage.output), { code: 'ENOENT' });
});
test('origin-scoped source headers are not forwarded to another allowed origin', async () => {
  const { createServer } = await import('node:http');
  let authorization;
  const receiver = createServer((req,res) => { authorization = req.headers.authorization; res.end('ok'); });
  await new Promise(resolve => receiver.listen(0,'127.0.0.1',resolve));
  const second = `http://127.0.0.1:${receiver.address().port}`;
  const redirector = createServer((req,res) => { assert.equal(req.headers.authorization, 'Bearer private-test'); res.writeHead(302,{ location: second }); res.end(); });
  await new Promise(resolve => redirector.listen(0,'127.0.0.1',resolve));
  const first = `http://127.0.0.1:${redirector.address().port}`;
  try {
    const c = client({ allowedOrigins: [first,second], headerOrigins: [first], headers: { Authorization: 'Bearer private-test' } });
    assert.equal((await c.text(first)).text, 'ok'); assert.equal(authorization, undefined);
  } finally {
    receiver.closeAllConnections(); redirector.closeAllConnections();
    await Promise.all([new Promise(resolve => receiver.close(resolve)), new Promise(resolve => redirector.close(resolve))]);
  }
});
