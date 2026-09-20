import { Telegraf } from 'telegraf';
import { User, Account, Campaign } from '../db.js';
import { mainKeyboard, backKeyboard } from './keyboards.js';
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
    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      {
        $set: {
          subscribed: true,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastSeenAt: new Date()
        }
      },
      { upsert: true }
    );
    await ctx.reply('✅ Promotional updates enabled.');
  });

  bot.command('unsubscribe', async ctx => {
    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      { $set: { subscribed: false, lastSeenAt: new Date() } },
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

    const accounts = await Account.find({ ownerId: ctx.from.id })
      .sort({ createdAt: -1 })
      .lean();

    const text = accounts.length
      ? accounts.map((a, i) => {
          const icon = a.status === 'connected' ? '🟢' : a.status === 'error' ? '🔴' : '🟡';
          return `${i + 1}. ${a.phoneMasked || 'Account'} — ${icon} ${a.status}`;
        }).join('\n')
      : 'No accounts connected yet.';

    const keyboard = accounts.length
      ? backKeyboard()
      : {
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ Add Account', callback_data: 'add_account' }],
              [{ text: '⬅️ Back to Home', callback_data: 'main_menu' }]
            ]
          }
        };

    await ctx.editMessageText(
      `👤 Accounts\n\n${text}`,
      keyboard
    );
  });

  bot.action('referrals', async ctx => {
    await ctx.answerCbQuery();

    const user = await User.findOne({ telegramId: ctx.from.id }).lean();
    const link = `https://t.me/${config.botUsername}?start=ref_${ctx.from.id}`;

    await ctx.editMessageText(
      `👥 Refer & Earn\n\nReferrals: ${user?.referrals || 0}\n💰 Earned: ₹${user?.referralEarned || 0}\n🎯 Referral rate: ${config.referralPercent}%\n\n🔗 Your referral link:\n${link}`,
      backKeyboard()
    );
  });

  bot.action('premium', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '⭐ Premium\n\nPremium plans will be connected to the payment module.',
      backKeyboard()
    );
  });

  bot.action('redeem', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '🎁 Redeem Code\n\nThe redeem-code management layer is ready to be connected.',
      backKeyboard()
    );
  });

  bot.action('stats', async ctx => {
    await ctx.answerCbQuery();

    const [accounts, campaigns, sent] = await Promise.all([
      Account.countDocuments({ ownerId: ctx.from.id }),
      Campaign.countDocuments({ ownerId: ctx.from.id }),
      Campaign.aggregate([
        { $match: { ownerId: ctx.from.id } },
        { $group: { _id: null, total: { $sum: '$stats.sent' } } }
      ])
    ]);

    await ctx.editMessageText(
      `📊 Statistics\n\nAccounts: ${accounts}\nCampaigns: ${campaigns}\nMessages sent: ${sent[0]?.total || 0}`,
      backKeyboard()
    );
  });

  bot.action('support', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      config.supportUrl
        ? `🆘 Support\n\n${config.supportUrl}`
        : '🆘 Support is not configured.',
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
