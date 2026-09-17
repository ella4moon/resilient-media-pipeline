import { Pipeline } from './core/pipeline.mjs';
import { WebSource } from './sources/web-source.mjs';
import { HttpClient } from './utilities/network.mjs';
import { createLogger } from './utilities/logger.mjs';
import { HttpDestination } from './destinations/http-api.mjs';
import { downloadDirect } from './downloaders/direct.mjs';
import { downloadHls } from './downloaders/hls.mjs';

export function createPipeline(config, { logger = createLogger(config.logLevel), destination, source } = {}) {
  const client = new HttpClient({ ...config.target, ...config.network, retry: config.retry, logger });
  return new Pipeline({ config, client, logger,
    source: source || new WebSource(config.target, client, { ...config.network, logger }),
    downloaders: { direct: downloadDirect, hls: downloadHls },
    destination: destination || new HttpDestination(config.destination, { retry: config.retry, logger }),
  });
}
