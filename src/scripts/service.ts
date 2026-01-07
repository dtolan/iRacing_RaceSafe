/**
 * RaceSafe Windows Service Entry Point
 *
 * This is the entry point when running as a Windows Service.
 * It starts RaceSafe in persistent mode with file logging.
 */

import { startService } from './racesafe';
import { initLogger, info, error } from '../utils/logger';

// Initialize logging first
initLogger({ consoleOutput: false });

info('='.repeat(60));
info('RaceSafe Service Starting');
info('='.repeat(60));

// Start the service
startService()
  .then(() => {
    info('RaceSafe Service stopped normally');
    process.exit(0);
  })
  .catch((err) => {
    error('RaceSafe Service crashed', err);
    process.exit(1);
  });
