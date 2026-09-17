import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJob, finishJob } from './job.mjs';
import { statistics } from './statistics.mjs';
import { writeJson, hashFile } from '../utilities/files.mjs';
import { errorInfo, PipelineError } from '../utilities/errors.mjs';
import { extractMetadata } from '../extractors/metadata.mjs';
import { mediaCandidates } from '../extractors/media.mjs';
import { validateMetadata, validateMedia } from '../validators/media.mjs';

export class Pipeline {
  constructor({ config, source, client, downloaders, destination, logger }) {
    Object.assign(this, { config, source, client, downloaders, destination, logger });
  }
  async run({ signal } = {}) {
    const c = this.config;
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0,8)}`;
    const reportPath = join(c.storage.reports, `${runId}.json`);
    const report = { runId, startedAt: new Date().toISOString(), finishedAt: null, status: 'running', jobs: [], sourceErrors: [], summary: {} };
    const pages = new Set(), hashes = new Set();
    await mkdir(c.storage.temp, { recursive: true });
    const checkpoint = async () => { report.summary = statistics(report.jobs); await writeJson(reportPath, report); };
    // Fail before remote side effects if reports cannot be written.
    await checkpoint();
    try {
      for await (const url of this.source.discover({ signal, onError: error => report.sourceErrors.push(error) })) {
        signal?.throwIfAborted();
        const job = createJob(url, report.jobs.length + 1);
        report.jobs.push(job);
        if (pages.has(url)) {
          job.reasons = ['duplicate_page']; finishJob(job, 'skipped');
        } else {
          pages.add(url);
          await this.processJob(job, { runId, hashes, signal });
        }
        this.logger.info('job_finished', { jobId: job.id, status: job.status, stage: job.stage, reasons: job.reasons, error: job.error });
        await checkpoint();
      }
      report.status = report.sourceErrors.length || report.jobs.some(j => j.status === 'failed') ? 'failed' : 'completed';
    } catch (error) {
      if (signal?.aborted) report.status = 'cancelled';
      else { report.status = 'failed'; report.error = errorInfo(error); }
    } finally {
      if (signal?.aborted) report.status = 'cancelled';
      report.finishedAt = new Date().toISOString();
      await checkpoint();
    }
    this.logger.info('run_finished', { runId, status: report.status, ...report.summary, sourceErrors: report.sourceErrors.length });
    return { ...report, reportPath };
  }
  async processJob(job, { runId, hashes, signal }) {
    const c = this.config, t = c.target;
    let folder;
    try {
      folder = await mkdtemp(join(c.storage.temp, `${job.id}-`));
      job.stage = 'extraction';
      const page = await this.client.text(job.sourcePageUrl, { signal, maxBytes: c.network.maxPageBytes });
      job.metadata = extractMetadata(page.text, job.sourcePageUrl, t.metadata);
      job.reasons = validateMetadata(job.metadata, t.validation);
      if (job.reasons.length) return finishJob(job, 'skipped');
      let accepted, lastError, attempted = 0, rejected = false;
      const candidateOptions = { client: this.client, allowedOrigins: t.allowedOrigins, maxPageBytes: c.network.maxPageBytes, signal, logger: this.logger };
      for await (const candidate of mediaCandidates(page.text, page.url, t.mediaDiscovery, candidateOptions)) {
        if (++attempted > 20) break;
        job.stage = 'download';
        const attemptFolder = join(folder, String(attempted));
        await mkdir(attemptFolder);
        try {
          const downloader = this.downloaders[candidate.type];
          if (!downloader) throw new PipelineError('UNSUPPORTED_MEDIA', 'No downloader registered for this media type.');
          const file = await downloader(candidate.url, join(attemptFolder, 'media.bin'), {
            ...candidateOptions, maxBytes: c.media.maxDownloadBytes, maxSegments: c.media.maxSegments,
            ffmpegPath: c.ffmpegPath, timeoutMs: c.media.processTimeoutMs,
          });
          job.stage = 'validation';
          const validation = await validateMedia(file, t.validation, { ffprobePath: c.ffprobePath, ffmpegPath: c.ffmpegPath, timeoutMs: c.media.processTimeoutMs, signal });
          job.validation = validation;
          if (!validation.valid) { rejected = true; job.reasons = validation.reasons; await rm(attemptFolder, { recursive: true, force: true }); continue; }
          const sha256 = await hashFile(file.path, signal);
          if (hashes.has(sha256)) { job.reasons = ['duplicate_content']; return finishJob(job, 'skipped'); }
          accepted = { file, sha256, facts: validation.facts, type: candidate.type };
          job.reasons = []; break;
        } catch (error) {
          signal?.throwIfAborted();
          lastError = error;
          this.logger.warn('candidate_failed', { jobId: job.id, candidate: attempted, ...errorInfo(error) });
          await rm(attemptFolder, { recursive: true, force: true });
        }
      }
      if (!accepted) {
        if (rejected) return finishJob(job, 'skipped');
        throw lastError || new PipelineError('MEDIA_NOT_FOUND', 'No configured strategy found usable media.');
      }
      job.media = { type: accepted.type, sha256: accepted.sha256, ...accepted.facts };
      job.stage = 'publish';
      job.destination = await this.destination.publish({ ...accepted, metadata: job.metadata }, { signal });
      hashes.add(accepted.sha256);
      // A confirmed remote publish stays completed even if optional local retention fails.
      finishJob(job, 'completed');
      if (c.storage.keepCompleted) {
        try {
          const output = join(c.storage.output, runId, job.id);
          await mkdir(output, { recursive: true });
          await copyFile(accepted.file.path, join(output, 'media.bin'));
          await writeJson(join(output, 'metadata.json'), { ...job.metadata, ...job.media, destination: job.destination });
          job.media.localPath = join(output, 'media.bin');
        } catch (error) { job.retentionError = errorInfo(error); this.logger.warn('retention_failed', { jobId: job.id }); }
      }
      job.stage = 'done';
    } catch (error) {
      job.error = signal?.aborted ? { code: 'CANCELLED', message: 'Processing was cancelled.' } : errorInfo(error);
      finishJob(job, signal?.aborted ? 'cancelled' : 'failed');
    } finally {
      if (folder) {
        try { await rm(folder, { recursive: true, force: true }); }
        catch { job.cleanupError = { code: 'CLEANUP_FAILED', message: 'Temporary directory could not be removed.' }; this.logger.warn('cleanup_failed', { jobId: job.id }); }
      }
    }
  }
}
