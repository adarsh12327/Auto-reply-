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
    if (!accounts.length) return ctx.reply('No accounts connected yet.', mainKeyboard());
    await ctx.reply(accounts.map((a, i) => `${i + 1}. ${a.phoneMasked || 'Account'} — ${a.status}`).join('\n'), mainKeyboard());
  });

  bot.action('referrals', async ctx => {
    await ctx.answerCbQuery();
    const user = await User.findOne({ telegramId: ctx.from.id });
    await ctx.reply(`👥 Referrals: ${user?.referrals || 0}\n💰 Earned: ₹${user?.referralEarned || 0}\n\nhttps://t.me/${config.botUsername}?start=ref_${ctx.from.id}`, mainKeyboard());
  });

  bot.action('premium', async ctx => { await ctx.answerCbQuery(); await ctx.reply('⭐ Premium plans will be connected to the payment module.', mainKeyboard()); });
  bot.action('redeem', async ctx => { await ctx.answerCbQuery(); await ctx.reply('🎁 Redeem Code module is ready for the code-management layer.', mainKeyboard()); });
  bot.action('stats', async ctx => {
    await ctx.answerCbQuery();
    const { Campaign, Account } = await import('../db.js');
    const [accounts, campaigns] = await Promise.all([
      Account.countDocuments({ ownerId: ctx.from.id }),
      Campaign.countDocuments({ ownerId: ctx.from.id })
    ]);
    await ctx.reply(`📊 Statistics\n\nAccounts: ${accounts}\nCampaigns: ${campaigns}`, mainKeyboard());
  });
  bot.action('support', async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply(config.supportUrl ? `🆘 Support: ${config.supportUrl}` : '🆘 Support is not configured.', mainKeyboard());
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
