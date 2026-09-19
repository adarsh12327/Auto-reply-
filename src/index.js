import 'dotenv/config';
import { loadConfig } from './config.js';
import { connectDb, closeDb } from './db.js';
import { loadAccounts, shutdownAccounts } from './userClient.js';
import { launchBot, stopBot } from './bot.js';
import { logger, safeError } from './logger.js';

const config = loadConfig();
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutdown requested', { signal });

  try { await stopBot(signal); } catch (error) { logger.error('Bot shutdown failed', { error: safeError(error) }); }
  try { await shutdownAccounts(); } catch (error) { logger.error('Telegram account shutdown failed', { error: safeError(error) }); }
  try { await closeDb(); } catch (error) { logger.error('Database shutdown failed', { error: safeError(error) }); }

  process.exit(0);
}

async function start() {
  await connectDb(config.mongoUri);
  await loadAccounts();
  await launchBot();
  logger.info('Application ready', { version: config.appVersion, environment: config.nodeEnv });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: safeError(reason instanceof Error ? reason : new Error(String(reason)))
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: safeError(error) });
  void shutdown('uncaughtException');
});

start().catch(async (error) => {
  logger.error('Application startup failed', { error: safeError(error) });
  await shutdown('startup_failure');
});
