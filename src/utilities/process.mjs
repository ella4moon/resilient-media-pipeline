import { spawn } from 'node:child_process';
import { PipelineError } from './errors.mjs';

/** No shell; bounded output, deadline, cancellation, and wait-for-close cleanup. */
export function runProcess(command, args, { signal, timeoutMs = 300000, maxOutputBytes = 1048576 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', outputBytes = 0, failure, killTimer;
    const stop = error => {
      if (failure) return;
      failure = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    const abort = () => stop(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new PipelineError('PROCESS_TIMEOUT', 'Media process exceeded its time limit.')), timeoutMs);
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      stream.on('data', data => {
        outputBytes += data.length;
        if (outputBytes > maxOutputBytes) stop(new PipelineError('PROCESS_OUTPUT_LIMIT', 'Media process output exceeded its limit.'));
        else if (name === 'stdout') stdout += data.toString();
      });
    }
    child.on('error', error => { failure ||= new PipelineError('PROCESS_UNAVAILABLE', 'Could not start the configured FFmpeg/FFprobe executable.', { cause: error }); });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new PipelineError('MEDIA_PROCESS_FAILED', 'Media process rejected the input.'));
      else resolve(stdout);
    });
  });
}
