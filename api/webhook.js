import { createBot } from '../src/bot/bot.js';
import { loadConfig } from '../src/config.js';
import { connectDb } from '../src/db.js';

let readyPromise;

async function getBot() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const config = loadConfig();
      await connectDb(config.mongoUri);
      const bot = createBot(config);
      return { bot, config };
    })();
  }
  return readyPromise;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true, service: 'telegram-webhook', method: req.method });
    return;
  }

  try {
    const { bot } = await getBot();

    // Webhook configuration is handled by /api/setup. Never call
    // getWebhookInfo/setWebhook on every incoming update; that adds an
    // unnecessary Telegram API round-trip to every button/message click.

    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ ok: false, error: error?.message || 'Webhook failed' });
  }
}
