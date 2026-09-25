import { Telegraf } from 'telegraf';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) throw new Error('BOT_TOKEN is not configured in Vercel');

    // Always prefer the stable production alias. VERCEL_URL can point to
    // an individual deployment URL, which would make Telegram stay pinned
    // to an old deployment after the next redeploy.
    const productionHost =
      process.env.WEBHOOK_URL?.replace(/^https?:\/\//, '').replace(/\/$/, '') ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      'auto-reply-adarsh-patels-projects-6a25ba02.vercel.app';

    const webhookUrl = 'https://' + productionHost + '/api/webhook';
    const bot = new Telegraf(botToken);

    await bot.telegram.setWebhook(webhookUrl, {
      allowed_updates: ['message', 'callback_query', 'chat_member', 'chat_join_request']
    });

    const info = await bot.telegram.getWebhookInfo();

    res.status(200).json({
      ok: true,
      webhookUrl,
      pendingUpdates: info.pending_update_count,
      lastError: info.last_error_message || null
    });
  } catch (error) {
    console.error('Webhook setup error:', error);
    res.status(500).json({ ok: false, error: error?.message || 'Webhook setup failed' });
  }
}
