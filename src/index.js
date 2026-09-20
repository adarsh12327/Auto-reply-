import { loadConfig } from './config.js';
import { connectDb, closeDb, Account } from './db.js';
import { createBot } from './bot/bot.js';
import { createUserClient, attachAutoReply } from './services/telegramClient.js';
import { logger } from './logger.js';

const config = loadConfig();

await connectDb(config.mongoUri);
logger.info('MongoDB connected');

let loadingAccounts = false;

async function loadConnectedAccounts() {
  if (loadingAccounts) return;
  loadingAccounts = true;

  try {
    const accounts = await Account.find({ status: 'connected' })
    .select('+sessionEncrypted +apiHashEncrypted +phoneEncrypted');

  logger.info('Loading connected accounts', { count: accounts.length });

  for (const account of accounts) {
    try {
      const client = await createUserClient({
        account,
        encryptionKey: config.encryptionKey
      });
      await attachAutoReply(account, client);
      logger.info('Telegram account ready', {
        accountId: String(account._id),
        telegramUserId: account.telegramUserId
      });
    } catch (error) {
      // Keep the account connected in MongoDB. Telegram/network outages are
      // often temporary, so the retry loop can restore the client automatically.
      logger.error('Failed to load Telegram account; will retry', {
        accountId: String(account._id),
        error: error?.message
      });
    }
    }
  } finally {
    loadingAccounts = false;
  }
}

await loadConnectedAccounts();

// Retry accounts that could not connect because of a temporary Telegram/network
// problem. The clients map prevents duplicate clients/handlers.
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
