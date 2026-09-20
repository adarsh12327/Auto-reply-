import { loadConfig } from './config.js';
import { connectDb, closeDb, Account } from './db.js';
import { createBot } from './bot/bot.js';
import { createUserClient, attachAutoReply } from './services/telegramClient.js';
import { logger } from './logger.js';

const config = loadConfig();

await connectDb(config.mongoUri);
logger.info('MongoDB connected');

let loadingAccounts = false;
const loadedAccounts = new Set();

async function loadConnectedAccounts() {
  if (loadingAccounts) return;
  loadingAccounts = true;

  try {
    const accounts = await Account.find({ status: 'connected' })
      .select('+sessionEncrypted +apiHashEncrypted +phoneEncrypted');

    for (const account of accounts) {
      const id = String(account._id);
      if (loadedAccounts.has(id)) continue;

      try {
        const client = await createUserClient({
          account,
          encryptionKey: config.encryptionKey
        });
        await attachAutoReply(account, client);
        loadedAccounts.add(id);
        logger.info('Telegram account ready', {
          accountId: id,
          telegramUserId: account.telegramUserId
        });
      } catch (error) {
        logger.error('Failed to load Telegram account; will retry', {
          accountId: id,
          error: error?.message
        });
      }
    }
  } finally {
    loadingAccounts = false;
  }
}

await loadConnectedAccounts();

const accountRetryTimer = setInterval(() => {
  loadConnectedAccounts().catch(error => {
    logger.error('Account retry cycle failed', { error: error?.message });
  });
}, 30000);

const bot = createBot(config);
await bot.launch();
logger.info('Bot started');

const shutdown = async signal => {
  logger.info('Shutting down', { signal });
  clearInterval(accountRetryTimer);
  bot.stop(signal);
  await closeDb();
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', error => logger.error('Unhandled rejection', { error: error?.message }));
process.on('uncaughtException', error => logger.error('Uncaught exception', { error: error?.message }));
