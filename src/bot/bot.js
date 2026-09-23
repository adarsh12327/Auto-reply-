import { Telegraf, Markup } from 'telegraf';
import { User, Account, Campaign, Setting } from '../db.js';
import { mainKeyboard, backKeyboard } from './keyboards.js';
import { startHandler } from '../handlers/start.js';
import { registerAccountHandlers, cancelPendingLogin } from '../handlers/account.js';
import { disconnectAccount } from '../services/telegramClient.js';
import { ReplyLog, ScannedPeer } from '../db.js';
import { registerAutoReplyHandlers } from '../handlers/autoReply.js';
import { registerCampaignHandlers } from '../handlers/campaign.js';
import { registerAdminHandlers } from '../handlers/admin.js';
import { registerChannelPromoHandlers } from '../handlers/channelPromo.js';

export function createBot(config) {
  const bot = new Telegraf(config.botToken);

  bot.start(startHandler);

  bot.command('menu', async ctx => {
    await ctx.reply('🏠 BUSINESS DASHBOARD\n\nManage accounts, contacts, automation and campaigns from one place.', mainKeyboard());
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
    await ctx.editMessageText('🏠 BUSINESS DASHBOARD\n\nManage accounts, contacts, automation and campaigns from one place.', mainKeyboard());
  });

  async function renderAccounts(ctx) {
    const accounts = await Account.find({ ownerId: ctx.from.id }).sort({ createdAt: -1 }).lean();
    const text = accounts.length
      ? accounts.map((a, i) => {
          const icon = a.status === 'connected' ? '🟢' : a.status === 'error' ? '🔴' : '🟡';
          return (i + 1) + '. ' + (a.phoneMasked || 'Account') + ' — ' + icon + ' ' + a.status;
        }).join('\n')
      : 'No accounts connected yet.';

    const rows = [];
    for (const a of accounts) {
      const label = a.status === 'connected' ? '🚪 Logout ' : a.status === 'pending' ? '🛑 Cancel Login ' : '🔄 Login ';
      rows.push([Markup.button.callback(label + (a.phoneMasked || 'Account'), 'account_logout:' + a._id)]);
    }
    rows.push([Markup.button.callback('➕ Add Account', 'add_account')]);
    rows.push([Markup.button.callback('⬅️ Back to Home', 'main_menu')]);

    await ctx.editMessageText('👤 ACCOUNT CENTER\n\n' + text + '\n\nSelect an account to manage it, or connect a new account:', Markup.inlineKeyboard(rows));
  }

  bot.action('accounts', async ctx => {
    await ctx.answerCbQuery();
    await renderAccounts(ctx);
  });

  bot.action(/^account_logout:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const accountId = ctx.match[1];
    const account = await Account.findOne({ _id: accountId, ownerId: ctx.from.id });
    if (!account) {
      await ctx.reply('❌ Account not found.');
      return;
    }

    await ctx.editMessageText(
      '🚪 Account logout\n\n' +
      (account.phoneMasked || 'Account') +
      '\n\nLogging out removes the saved Telegram session. You can add/login this account again later.\n\nContinue?',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm Logout', 'account_logout_confirm:' + account._id)],
        [Markup.button.callback('⬅️ Back to Accounts', 'accounts')]
      ])
    );
  });

  bot.action(/^account_logout_confirm:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const accountId = ctx.match[1];
    const account = await Account.findOne({ _id: accountId, ownerId: ctx.from.id });
    if (!account) {
      await renderAccounts(ctx);
      return;
    }

    await disconnectAccount(account._id).catch(() => {});
    cancelPendingLogin(ctx.from.id);

    // Logout is a full account removal: delete the Telegram session,
    // account record, and account-specific runtime data.
    await ReplyLog.deleteMany({ accountId: account._id });
    await ScannedPeer.deleteMany({ accountId: account._id });
    await Campaign.deleteMany({ accountId: account._id });
    await Account.deleteOne({ _id: account._id, ownerId: ctx.from.id });

    await ctx.editMessageText(
      '✅ Account removed successfully.\n\nThe saved Telegram session and account data were deleted.',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Account', 'add_account')],
        [Markup.button.callback('⬅️ Back to Accounts', 'accounts')],
        [Markup.button.callback('🏠 Back to Home', 'main_menu')]
      ])
    );
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
      '📊 BUSINESS ANALYTICS\n\n👤 Connected accounts: ' + accounts + '\n📣 Campaigns: ' + campaigns + '\n\n📤 Sent: ' + (stats.sent || 0) + '\n❌ Failed: ' + (stats.failed || 0) + '\n⏭️ Skipped: ' + (stats.skipped || 0),
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
  registerChannelPromoHandlers(bot, config);
  registerAdminHandlers(bot, config);

  bot.catch((error, ctx) => {
    console.error('Bot error:', error);
    return ctx.reply('❌ Something went wrong. Please try again.').catch(() => {});
  });

  return bot;
}
