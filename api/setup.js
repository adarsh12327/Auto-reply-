import { Telegraf } from 'telegraf';
import { loadConfig } from '../src/config.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const config = loadConfig();
    const bot = new Telegraf(config.botToken);
    const baseUrl = process.env.WEBHOOK_URL
      ? process.env.WEBHOOK_URL.replace(/\\/$/, '')
      : 'https://' + process.env.VERCEL_URL;
    const webhookUrl = baseUrl + '/api/webhook';

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
