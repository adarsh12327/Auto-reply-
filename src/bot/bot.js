import { Telegraf } from 'telegraf';
import { User } from '../db.js';
import { mainKeyboard } from './keyboards.js';
import { startHandler } from '../handlers/start.js';
import { registerAccountHandlers } from '../handlers/account.js';
import { registerAutoReplyHandlers } from '../handlers/autoReply.js';
import { registerCampaignHandlers } from '../handlers/campaign.js';
import { registerAdminHandlers } from '../handlers/admin.js';

export function createBot(config) {
  const bot = new Telegraf(config.botToken);

  bot.start(startHandler);

  bot.command('menu', async ctx => ctx.reply('🏠 Main Menu', mainKeyboard()));
  bot.command('subscribe', async ctx => {
    await User.findOneAndUpdate({ telegramId: ctx.from.id }, { subscribed: true }, { upsert: true });
    await ctx.reply('✅ Promotional updates enabled.');
  });
  bot.command('unsubscribe', async ctx => {
    await User.findOneAndUpdate({ telegramId: ctx.from.id }, { subscribed: false }, { upsert: true });
    await ctx.reply('✅ Promotional updates disabled.');
  });

  bot.action('main_menu', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('🏠 Main Menu', mainKeyboard());
  });

  bot.action('accounts', async ctx => {
    await ctx.answerCbQuery();
    const accounts = await import('../db.js').then(m => m.Account.find({ ownerId: ctx.from.id }).sort({ createdAt: -1 }).lean());
    const text = accounts.length
      ? accounts.map((a, i) => `${i + 1}. ${a.phoneMasked || 'Account'} — ${a.status}`).join('\n')
      : 'No accounts connected yet.';
    await ctx.editMessageText(`👤 Accounts\n\n${text}`, mainKeyboard());
  });

  bot.action('referrals', async ctx => {
    await ctx.answerCbQuery();
    const user = await User.findOne({ telegramId: ctx.from.id });
    await ctx.editMessageText(`👥 Refer & Earn\n\nReferrals: ${user?.referrals || 0}\n💰 Earned: ₹${user?.referralEarned || 0}\n\nhttps://t.me/${config.botUsername}?start=ref_${ctx.from.id}`, mainKeyboard());
  });

  bot.action('premium', async ctx => { await ctx.answerCbQuery(); await ctx.editMessageText('⭐ Premium\n\nPremium plans will be connected to the payment module.', mainKeyboard()); });
  bot.action('redeem', async ctx => { await ctx.answerCbQuery(); await ctx.editMessageText('🎁 Redeem Code\n\nThe redeem-code management layer is ready to be connected.', mainKeyboard()); });
  bot.action('stats', async ctx => {
    await ctx.answerCbQuery();
    const { Campaign, Account } = await import('../db.js');
    const [accounts, campaigns] = await Promise.all([
      Account.countDocuments({ ownerId: ctx.from.id }),
      Campaign.countDocuments({ ownerId: ctx.from.id })
    ]);
    await ctx.editMessageText(`📊 Statistics\n\nAccounts: ${accounts}\nCampaigns: ${campaigns}`, mainKeyboard());
  });
  bot.action('support', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(config.supportUrl ? `🆘 Support\n\n${config.supportUrl}` : '🆘 Support is not configured.', mainKeyboard());
  });

  registerAccountHandlers(bot, config);
  registerAutoReplyHandlers(bot, config);
  registerCampaignHandlers(bot, config);
  registerAdminHandlers(bot, config);

  bot.catch((error, ctx) => {
    console.error('Bot error:', error);
    return ctx.reply('❌ Something went wrong.').catch(() => {});
  });

  return bot;
}
