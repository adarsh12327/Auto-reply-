import { Telegraf, Markup } from 'telegraf';
import { User, Account, Campaign, Setting } from '../db.js';
import { mainKeyboard, backKeyboard } from './keyboards.js';
import { startHandler } from '../handlers/start.js';
import { registerAccountHandlers } from '../handlers/account.js';
import { registerAutoReplyHandlers } from '../handlers/autoReply.js';
import { registerCampaignHandlers } from '../handlers/campaign.js';
import { registerAdminHandlers } from '../handlers/admin.js';

export function createBot(config) {
  const bot = new Telegraf(config.botToken);

  bot.start(startHandler);

  bot.command('menu', async ctx => {
    await ctx.reply('🏠 Main Menu', mainKeyboard());
  });

  bot.command('subscribe', async ctx => {
    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      {
        $set: {
          subscribed: true,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastSeenAt: new Date()
        },
        $setOnInsert: { telegramId: ctx.from.id }
      },
      { upsert: true }
    );
    await ctx.reply('✅ Promotional updates enabled.');
  });

  bot.command('unsubscribe', async ctx => {
    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      { $set: { subscribed: false, lastSeenAt: new Date() }, $setOnInsert: { telegramId: ctx.from.id } },
      { upsert: true }
    );
    await ctx.reply('✅ Promotional updates disabled.');
  });

  bot.action('main_menu', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('🏠 Main Menu', mainKeyboard());
  });

  bot.action('accounts', async ctx => {
    await ctx.answerCbQuery();
    const accounts = await Account.find({ ownerId: ctx.from.id }).sort({ createdAt: -1 }).lean();
    const text = accounts.length
      ? accounts.map((a, i) => {
          const icon = a.status === 'connected' ? '🟢' : a.status === 'error' ? '🔴' : '🟡';
          return (i + 1) + '. ' + (a.phoneMasked || 'Account') + ' — ' + icon + ' ' + a.status;
        }).join('\n')
      : 'No accounts connected yet.';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add Account', 'add_account')],
      [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
    ]);
    await ctx.editMessageText('👤 Accounts\n\n' + text, keyboard);
  });

  bot.action('referrals', async ctx => {
    await ctx.answerCbQuery();
    const [user, setting] = await Promise.all([
      User.findOne({ telegramId: ctx.from.id }).lean(),
      Setting.findOne({ key: 'referral_percent' }).lean()
    ]);
    const referralPercent = setting?.value ?? config.referralPercent;
    const link = 'https://t.me/' + config.botUsername + '?start=ref_' + ctx.from.id;
    await ctx.editMessageText(
      '👥 Refer & Earn\n\nReferrals: ' + (user?.referrals || 0) + '\n💰 Earned: ₹' + (user?.referralEarned || 0) + '\n🎯 Referral rate: ' + referralPercent + '%\n\n🔗 Your referral link:\n' + link,
      backKeyboard()
    );
  });

  bot.action('premium', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('⭐ Premium\n\nPremium plans are not configured yet.', backKeyboard());
  });

  bot.action('redeem', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('🎁 Redeem Code\n\nRedeem-code management is not configured yet.', backKeyboard());
  });

  bot.action('stats', async ctx => {
    await ctx.answerCbQuery();
    const [accounts, campaigns, aggregate] = await Promise.all([
      Account.countDocuments({ ownerId: ctx.from.id }),
      Campaign.countDocuments({ ownerId: ctx.from.id }),
      Campaign.aggregate([
        { $match: { ownerId: ctx.from.id } },
        { $group: { _id: null, sent: { $sum: '$stats.sent' }, failed: { $sum: '$stats.failed' }, skipped: { $sum: '$stats.skipped' } } }
      ])
    ]);
    const stats = aggregate[0] || { sent: 0, failed: 0, skipped: 0 };
    await ctx.editMessageText(
      '📊 Statistics\n\nAccounts: ' + accounts + '\nCampaigns: ' + campaigns + '\n\n📤 Sent: ' + (stats.sent || 0) + '\n❌ Failed: ' + (stats.failed || 0) + '\n⏭️ Skipped: ' + (stats.skipped || 0),
      backKeyboard()
    );
  });

  bot.action('support', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      config.supportUrl ? '🆘 Support\n\n' + config.supportUrl : '🆘 Support is not configured.',
      backKeyboard()
    );
  });

  registerAccountHandlers(bot, config);
  registerAutoReplyHandlers(bot, config);
  registerCampaignHandlers(bot, config);
  registerAdminHandlers(bot, config);

  bot.catch((error, ctx) => {
    console.error('Bot error:', error);
    return ctx.reply('❌ Something went wrong. Please try again.').catch(() => {});
  });

  return bot;
}
