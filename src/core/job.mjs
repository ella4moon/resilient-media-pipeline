import { createHash } from 'node:crypto';
export function createJob(sourcePageUrl, sequence) {
  return { id: `${String(sequence).padStart(4, '0')}-${createHash('sha256').update(sourcePageUrl).digest('hex').slice(0, 12)}`,
    sourcePageUrl, status: 'discovered', stage: 'discovery', startedAt: new Date().toISOString(), finishedAt: null,
    metadata: null, media: null, validation: null, destination: null, error: null, reasons: [] };
}
export function finishJob(job, status) {
  job.status = status; job.finishedAt = new Date().toISOString(); return job;
}
