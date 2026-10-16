import { consoleLogger } from '../jobs/log';
import { readR2Options } from '../uploads/config';
import { createR2Storage } from '../uploads/storage';
import { createCoinImageRehoster, type CoinImageRehoster } from './rehost';

/*
 * Production wiring of the coin image copy, built from the same R2 variables as coin uploads
 * (uploads/config.ts): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
 * R2_PUBLIC_URL and the optional R2_ENDPOINT. A missing or invalid variable throws
 * UploadConfigError, whose message names the variables only.
 */

export {
  CoinImageUnavailableError,
  createCoinImageRehoster,
  imageUnavailableMessage,
  type CoinImageRehoster,
  type ImageField,
} from './rehost';

let cached: CoinImageRehoster | null = null;

export function getDefaultCoinImageRehoster(): CoinImageRehoster {
  cached ??= createCoinImageRehoster({
    storage: createR2Storage(readR2Options(process.env)),
    logger: consoleLogger('coin-images'),
  });
  return cached;
}
