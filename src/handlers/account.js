import { Account } from '../db.js';
import { mainKeyboard } from '../bot/keyboards.js';
import { createUserClient } from '../services/telegramClient.js';

const pending = new Map();

export function registerAccountHandlers(bot, config) {
  bot.action('add_account', async ctx => {
    await ctx.answerCbQuery();
    pending.set(ctx.from.id, { step: 'phone' });
    await ctx.reply('📱 Send your Telegram phone number in international format.\nExample: +919876543210\n\n/cancel to stop.');
  });

  bot.on('text', async ctx => {
    const state = pending.get(ctx.from.id);
    if (!state) return;

    const text = ctx.message.text.trim();
    if (text === '/cancel') {
      pending.delete(ctx.from.id);
      return ctx.reply('❌ Cancelled.', mainKeyboard());
    }

    if (state.step === 'phone') {
      const account = await Account.create({
        ownerId: ctx.from.id,
        phoneMasked: text.replace(/^(\+\d{2})\d+(\d{3})$/, '$1••••$2'),
        status: 'pending'
      });
      pending.set(ctx.from.id, { step: 'api_wait', accountId: account._id, phone: text });
      await ctx.reply('🔐 Account created. The next build step will attach the OTP/2FA login UI to this account.\n\nFor security, never send your Telegram password or API hash to anyone.');
    }
  });
}
