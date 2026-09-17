export class PipelineError extends Error {
  constructor(code, message, { retryable = false, retryAfterMs, cause } = {}) {
    super(message, { cause });
    this.name = 'PipelineError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}
export const rejection = (code, message) => new PipelineError(code, message);
export function errorInfo(error) {
  // Arbitrary exception messages can contain signed URLs or credentials.
  return { code: error instanceof PipelineError ? error.code : 'UNEXPECTED_ERROR',
    message: error instanceof PipelineError ? error.message : 'Unexpected failure; inspect the component configuration.' };
}
