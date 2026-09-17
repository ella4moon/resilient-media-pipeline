import { stat } from 'node:fs/promises';
import { runProcess } from '../utilities/process.mjs';
import { PipelineError } from '../utilities/errors.mjs';

export function validateMetadata(metadata, rules) {
  const reasons = [];
  for (const field of rules.requiredMetadata) {
    const value = metadata[field];
    if (value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)) reasons.push(`missing_${field}`);
  }
  return reasons;
}
export function checkMediaFacts(facts, rules) {
  const reasons = [];
  if (!facts.hasVideo) reasons.push('missing_video_stream');
  if (!Number.isFinite(facts.durationSeconds) || facts.durationSeconds <= 0) reasons.push('invalid_duration');
  else {
    if (facts.durationSeconds < rules.minimumDurationSeconds) reasons.push('duration_too_short');
    if (rules.maximumDurationSeconds !== undefined && facts.durationSeconds > rules.maximumDurationSeconds) reasons.push('duration_too_long');
  }
  if (facts.bytes < rules.minimumBytes) reasons.push('file_too_small');
  if (facts.bytes > rules.maximumBytes) reasons.push('file_too_large');
  if (facts.width < rules.minimumWidth) reasons.push('width_too_small');
  if (facts.height < rules.minimumHeight) reasons.push('height_too_small');
  return reasons;
}
export async function validateMedia(file, rules, { ffprobePath, ffmpegPath, timeoutMs, signal }) {
  try {
    const stdout = await runProcess(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file', '-show_format', '-show_streams', '-of', 'json', file.path], { signal, timeoutMs });
    const probe = JSON.parse(stdout);
    const video = probe.streams?.find(s => s.codec_type === 'video');
    const facts = { bytes: (await stat(file.path)).size, hasVideo: !!video, durationSeconds: Number(probe.format?.duration || video?.duration), width: video?.width || 0, height: video?.height || 0, videoCodec: video?.codec_name || null, hasAudio: probe.streams?.some(s => s.codec_type === 'audio') || false };
    const reasons = checkMediaFacts(facts, rules);
    if (file.expectedDurationSeconds && Math.abs(facts.durationSeconds - file.expectedDurationSeconds) > Math.max(1, file.expectedDurationSeconds * 0.02)) reasons.push('hls_duration_mismatch');
    if (!reasons.length && rules.decode) await runProcess(ffmpegPath, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-i', file.path, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], { signal, timeoutMs });
    return { valid: !reasons.length, reasons, facts };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PipelineError && error.code === 'MEDIA_PROCESS_FAILED') return { valid: false, reasons: ['invalid_media'], facts: null };
    throw error;
  }
}
