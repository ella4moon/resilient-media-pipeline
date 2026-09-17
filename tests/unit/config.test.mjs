import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateConfig } from '../../src/config.mjs';
const main = JSON.parse(await readFile(new URL('../../config/main.json', import.meta.url), 'utf8'));
const target = JSON.parse(await readFile(new URL('../../config/targets/demo.json', import.meta.url), 'utf8'));
test('environment overrides are typed and private headers require explicit origins', () => {
  const c = validateConfig(main, target, { env: { MAX_ATTEMPTS: '5', REQUEST_TIMEOUT_MS: '1234' } });
  assert.equal(c.retry.attempts, 5); assert.equal(c.network.timeoutMs, 1234);
  assert.throws(() => validateConfig(main, target, { env: { MAX_ATTEMPTS: 'NaN' } }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateConfig(main, { ...target, headersFromEnv: { Authorization: 'TOKEN' } }, { env: { TOKEN: 'secret' } }), { code: 'INVALID_CONFIG' });
});
test('rejects unknown settings, bad selectors, credentials in URLs, invalid ranges', () => {
  assert.throws(() => validateConfig({ ...main, surprise: true }, target, { env: {} }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateConfig(main, { ...target, metadata: { title: { selector: '[' } } }, { env: {} }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateConfig(main, { ...target, baseUrl: 'http://user:pass@example.test' }, { env: {} }), { code: 'INVALID_URL' });
  assert.throws(() => validateConfig(main, { ...target, validation: { minimumBytes: 100, maximumBytes: 1 } }, { env: {} }), { code: 'INVALID_CONFIG' });
});
test('omitted optional sections receive complete nested defaults', () => {
  const { retry, network, media, ...minimal } = main;
  const { validation, ...minimalTarget } = target;
  const config = validateConfig(minimal, minimalTarget, { env: {} });
  assert.equal(config.retry.attempts, 3);
  assert.equal(config.network.timeoutMs, 30000);
  assert.equal(config.media.maxSegments, 1000);
  assert.deepEqual(config.target.validation.requiredMetadata, ['title']);
});
test('scalar metadata cannot be configured as an array', () => {
  assert.throws(() => validateConfig(main, { ...target, metadata: { title: { selector: 'h1', multiple: true } } }, { env: {} }), { code: 'INVALID_CONFIG' });
});
