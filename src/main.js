import { loadConfig } from './config.mjs';
import { createPipeline } from './create-pipeline.mjs';
import { createLogger } from './utilities/logger.mjs';
import { errorInfo } from './utilities/errors.mjs';

const controller = new AbortController();
let signalCode;
const stop = name => { signalCode ||= name === 'SIGINT' ? 130 : 143; controller.abort(new Error('Shutdown requested')); };
const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
try {
  const args = process.argv.slice(2);
  if (args[0] === '--help') {
    console.log('Usage: npm start -- [--config path/to/main.json]\nRun once; JSON logs on stdout. See README.md for the local demo.');
  } else {
    if (args.length && (args.length !== 2 || args[0] !== '--config')) throw new Error('Invalid CLI arguments');
    const config = await loadConfig(args[1]);
    const result = await createPipeline(config).run({ signal: controller.signal });
    process.exitCode = signalCode || (result.status === 'failed' ? 1 : 0);
  }
} catch (error) {
  createLogger().error('startup_failed', errorInfo(error));
  process.exitCode = signalCode || 1;
} finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
}
