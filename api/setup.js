import { Telegraf } from 'telegraf';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) throw new Error('BOT_TOKEN is not configured in Vercel');

    const baseUrl = process.env.WEBHOOK_URL
      ? process.env.WEBHOOK_URL.replace(/\/$/, '')
      : 'https://' + process.env.VERCEL_URL;

    if (!baseUrl || baseUrl === 'https://undefined') {
      throw new Error('VERCEL_URL or WEBHOOK_URL is not available');
    }

    const webhookUrl = baseUrl + '/api/webhook';
    const bot = new Telegraf(botToken);

    await bot.telegram.setWebhook(webhookUrl, {
      allowed_updates: ['message', 'callback_query', 'chat_member']
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
