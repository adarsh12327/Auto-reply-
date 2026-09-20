import { loadConfig } from './config.js';
import { connectDb, closeDb, Account } from './db.js';
import { createBot } from './bot/bot.js';
import { createUserClient, attachAutoReply } from './services/telegramClient.js';
import { logger } from './logger.js';

const config = loadConfig();

await connectDb(config.mongoUri);
logger.info('MongoDB connected');

const accounts = await Account.find({ status: 'connected' }).select('+sessionEncrypted');
logger.info('Loading connected accounts', { count: accounts.length });

for (const account of accounts) {
  try {
    const client = await createUserClient({
      account,
      apiId: account.apiId || config.telegramApiId,
      apiHash: config.telegramApiHash,
      encryptionKey: config.encryptionKey
    });
    await attachAutoReply(account, client);
  } catch (error) {
    account.status = 'error';
    account.lastError = error.message;
    await account.save();
    logger.error('Failed to load account', { accountId: String(account._id), error: error.message });
  }
}

const bot = createBot(config);
await bot.launch();
logger.info('Bot started');

const shutdown = async signal => {
  logger.info('Shutting down', { signal });
  bot.stop(signal);
  await closeDb();
  process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', error => logger.error('Unhandled rejection', { error: error?.message }));
process.on('uncaughtException', error => logger.error('Uncaught exception', { error: error?.message }));
