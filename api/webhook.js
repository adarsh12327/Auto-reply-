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

    // Keep Telegram pointed at the stable production alias rather than a
    // temporary deployment URL. This prevents old Vercel deployments from
    // continuing to serve stale bot keyboards after a redeploy.
    const productionHost =
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      'auto-reply-adarsh-patels-projects-6a25ba02.vercel.app';
    const stableWebhookUrl = 'https://' + productionHost + '/api/webhook';

    try {
      const currentWebhook = await bot.telegram.getWebhookInfo();
      if (currentWebhook.url !== stableWebhookUrl) {
        await bot.telegram.setWebhook(stableWebhookUrl, {
          allowed_updates: ['message', 'callback_query', 'chat_member']
        });
      }
    } catch (webhookError) {
      console.warn('Webhook self-heal failed:', webhookError?.message);
    }

    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ ok: false, error: error?.message || 'Webhook failed' });
  }
}
