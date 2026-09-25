import { Markup } from 'telegraf';
import { User, Account, ReplyLog, ScannedPeer } from '../db.js';
import { BusinessCampaign } from '../models/campaigns.js';
import { MessageTemplate } from '../models/messages.js';
import { AdCampaign } from '../models/ads.js';
import { Wallet } from '../models/wallet.js';
import { ReferralProfile } from '../models/referrals.js';
import { UiState } from '../models/uiState.js';
import {
  mainKeyboard,
  simpleBackKeyboard,
  accountManageKeyboard,
  accountConfirmRemoveKeyboard,
  templateKeyboard,
  templateManageKeyboard,
  messageInputKeyboard
} from '../bot/keyboards.js';
import { getBusinessSettings } from '../services/businessSettings.js';
import { setUiState, getUiState, clearUiState } from '../services/uiState.js';
import { disconnectAccount } from '../services/telegramClient.js';
import { syncAccountGroups } from '../services/accountService.js';
import { checkRequiredJoin } from '../services/accessService.js';

const stateKey = 'dashboard_flow';

async function edit(ctx, text, keyboard = simpleBackKeyboard()) {
  try {
    await ctx.editMessageText(text, keyboard);
  } catch (error) {
    const msg = String(error?.description || error?.message || '');
    if (!msg.includes('message is not modified')) throw error;
  }
}

async function requireMaintenanceBypass(ctx) {
  const settings = await getBusinessSettings();
  if (!settings.maintenanceMode) return true;
  const user = await User.findOne({ telegramId: ctx.from.id }).lean();
  const admin = (process.env.ADMIN_IDS || '').split(',').map(Number).includes(ctx.from.id);
  if (admin || user?.telegramId === Number(process.env.OWNER_ID || 0)) return true;
  await edit(ctx, '🚧 <b>Maintenance Mode</b>\n\nThe bot is currently under maintenance. Please try again later.', simpleBackKeyboard());
  return false;
}

async function showMessages(ctx) {
  const templates = await MessageTemplate.find({ ownerId: ctx.from.id }).sort({ createdAt: -1 }).lean();
  await edit(
    ctx,
    templates.length
      ? '💬 <b>MY MESSAGES</b>\n\nCreate reusable messages for DM, Group Message and Auto Reply.'
      : '💬 <b>MY MESSAGES</b>\n\nNo saved messages yet.',
    templateKeyboard(templates)
  );
}

async function showStats(ctx) {
  const ownerId = ctx.from.id;
  const [accounts, campaigns, ads, wallet, aggregate, replies] = await Promise.all([
    Account.countDocuments({ ownerId }),
    BusinessCampaign.countDocuments({ ownerId }),
    AdCampaign.countDocuments({ ownerId }),
    Wallet.findOne({ ownerId }).lean(),
    BusinessCampaign.aggregate([
      { $match: { ownerId } },
      { $group: { _id: null, sent: { $sum: '$stats.sent' }, failed: { $sum: '$stats.failed' }, skipped: { $sum: '$stats.skipped' } } }
    ]),
    ReplyLog.countDocuments({ accountId: { $in: (await Account.find({ ownerId }).select('_id').lean()).map(x => x._id) } })
  ]);
  const s = aggregate[0] || {};
  await edit(ctx,
    '📊 <b>MY STATS</b>\n\n' +
    '👤 Accounts: ' + accounts + '\n' +
    '📨 Campaigns: ' + campaigns + '\n' +
    '📤 Messages sent: ' + (s.sent || 0) + '\n' +
    '❌ Failed: ' + (s.failed || 0) + '\n' +
    '⏭️ Skipped: ' + (s.skipped || 0) + '\n' +
    '🤖 Auto replies: ' + replies + '\n' +
    '📢 Ads: ' + ads + '\n' +
    '💰 Wallet: ₹' + Number(wallet?.balance || 0).toFixed(2),
    simpleBackKeyboard()
  );
}

export function registerDashboardHandlers(bot, config) {
  bot.action('main_menu', async ctx => {
    await ctx.answerCbQuery();
    if (!(await requireMaintenanceBypass(ctx))) return;
    const access = await checkRequiredJoin(ctx);
    if (!access.allowed) {
      const { joinRequiredKeyboard } = await import('../bot/keyboards.js');
      return edit(ctx, '🔐 <b>Join verification required</b>\n\nJoin the required channel first, then verify.', joinRequiredKeyboard(access.url));
    }
    await edit(ctx, '🏠 <b>BUSINESS COMMAND CENTER</b>\n\nManage accounts, messages, campaigns, automation and business tools from one place.', mainKeyboard());
  });

  bot.action('verify_join', async ctx => {
    await ctx.answerCbQuery('Checking membership...');
    const access = await checkRequiredJoin(ctx);
    if (!access.allowed) {
      const { joinRequiredKeyboard } = await import('../bot/keyboards.js');
      return edit(ctx, '❌ <b>Verification failed</b>\n\nPlease join the required channel and try again.', joinRequiredKeyboard(access.url));
    }
    await edit(ctx, '✅ <b>Verified</b>\n\nWelcome to the Business Command Center.', mainKeyboard());
  });

  bot.action('feature_messages', async ctx => {
    await ctx.answerCbQuery();
    await showMessages(ctx);
  });

  bot.action('template_new', async ctx => {
    await ctx.answerCbQuery();
    await setUiState(ctx.from.id, stateKey, { action: 'template_name' });
    await edit(ctx, '➕ <b>New Message</b>\n\nSend a name for this message template.\n\nExample: Promotion');
  });

  bot.action(/^template_open:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const t = await MessageTemplate.findOne({ _id: ctx.match[1], ownerId: ctx.from.id }).lean();
    if (!t) return showMessages(ctx);
    await edit(ctx,
      '💬 <b>' + t.name + '</b>\n\n' +
      (t.text || 'No text saved.') + '\n\n' +
      'Status: ' + (t.active ? '🟢 Active' : '⚪ Inactive') + '\n' +
      'Used: ' + (t.useCount || 0),
      templateManageKeyboard(t._id)
    );
  });

  bot.action(/^template_preview:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const t = await MessageTemplate.findOne({ _id: ctx.match[1], ownerId: ctx.from.id }).lean();
    if (!t) return showMessages(ctx);
    await ctx.reply(t.text || 'No text saved.', { parse_mode: t.parseMode || 'HTML' }).catch(async () => {
      await ctx.reply(t.text || 'No text saved.');
    });
  });

  bot.action(/^template_active:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Activated');
    const t = await MessageTemplate.findOne({ _id: ctx.match[1], ownerId: ctx.from.id });
    if (!t) return showMessages(ctx);
    await MessageTemplate.updateMany({ ownerId: ctx.from.id }, { $set: { active: false } });
    t.active = true;
    await t.save();
    await edit(ctx, '🟢 <b>Active message updated</b>\n\n' + t.name, templateManageKeyboard(t._id));
  });

  bot.action(/^template_edit:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const t = await MessageTemplate.findOne({ _id: ctx.match[1], ownerId: ctx.from.id });
    if (!t) return showMessages(ctx);
    await setUiState(ctx.from.id, stateKey, { action: 'template_edit', templateId: String(t._id) });
    await edit(ctx, '✏️ <b>Edit Message</b>\n\nSend the new message text.', messageInputKeyboard('template_open:' + t._id));
  });

  bot.action(/^template_delete:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    await MessageTemplate.deleteOne({ _id: ctx.match[1], ownerId: ctx.from.id });
    await showMessages(ctx);
  });

  bot.action('feature_account', async ctx => {
    await ctx.answerCbQuery();
    const accounts = await Account.find({ ownerId: ctx.from.id }).sort({ createdAt: -1 }).lean();
    await edit(ctx,
      accounts.length
        ? '👤 <b>MY ACCOUNT</b>\n\nSelect an account to view its status.'
        : '👤 <b>MY ACCOUNT</b>\n\nNo Telegram accounts connected yet.',
      accountManageKeyboard(accounts)
    );
  });

  bot.action('feature_remove_account', async ctx => {
    await ctx.answerCbQuery();
    const accounts = await Account.find({ ownerId: ctx.from.id }).sort({ createdAt: -1 }).lean();
    await edit(ctx,
      accounts.length
        ? '➖ <b>REMOVE ACCOUNT</b>\n\nSelect the Telegram account you want to disconnect.'
        : '➖ <b>REMOVE ACCOUNT</b>\n\nNo accounts available.',
      accountManageKeyboard(accounts)
    );
  });

  bot.action(/^account_manage:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const account = await Account.findOne({ _id: ctx.match[1], ownerId: ctx.from.id }).lean();
    if (!account) return edit(ctx, '❌ Account not found.', simpleBackKeyboard('feature_account'));
    await edit(ctx,
      '👤 <b>ACCOUNT DETAILS</b>\n\n' +
      'Account: ' + (account.phoneMasked || 'Telegram Account') + '\n' +
      'Telegram ID: ' + (account.telegramUserId || 'Not available') + '\n' +
      'Status: ' + account.status + '\n' +
      'Added: ' + new Date(account.createdAt).toLocaleString() + '\n' +
      'Last activity: ' + (account.lastSeenAt ? new Date(account.lastSeenAt).toLocaleString() : '—'),
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh Groups', 'account_sync:' + account._id)],
        [Markup.button.callback('➖ Remove Account', 'account_remove:' + account._id)],
        [Markup.button.callback('⬅️ My Account', 'feature_account')]
      ])
    );
  });

  bot.action(/^account_remove:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const account = await Account.findOne({ _id: ctx.match[1], ownerId: ctx.from.id }).lean();
    if (!account) return edit(ctx, '❌ Account not found.', simpleBackKeyboard('feature_account'));
    await edit(ctx, '⚠️ <b>Remove Account?</b>\n\n' + (account.phoneMasked || 'Telegram Account') + '\n\nThis disconnects the saved Telegram session and removes account-specific business data.', accountConfirmRemoveKeyboard(account._id));
  });

  bot.action(/^account_remove_confirm:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Removing...');
    const account = await Account.findOne({ _id: ctx.match[1], ownerId: ctx.from.id });
    if (!account) return edit(ctx, '❌ Account not found.', simpleBackKeyboard('feature_account'));
    await disconnectAccount(account._id).catch(() => {});
    await Promise.all([
      BusinessCampaign.deleteMany({ ownerId: ctx.from.id, accountIds: account._id }),
      MessageTemplate.updateMany({ ownerId: ctx.from.id }, { $set: { active: false } })
    ]);
    await Account.deleteOne({ _id: account._id, ownerId: ctx.from.id });
    await edit(ctx, '✅ <b>Account removed</b>\n\nThe account session record has been removed from this account.', simpleBackKeyboard('feature_account'));
  });

  bot.action(/^account_sync:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Syncing groups...');
    try {
      const groups = await syncAccountGroups(ctx.from.id, ctx.match[1], config.encryptionKey);
      await edit(ctx, '🔄 <b>Groups synchronized</b>\n\nFound: ' + groups.length + '\n\nThe database was updated without creating duplicate group records.', simpleBackKeyboard('feature_account'));
    } catch (error) {
      await edit(ctx, '❌ Group sync failed.\n\n' + (error.message || 'Please try again.'), simpleBackKeyboard('feature_account'));
    }
  });

  bot.action('feature_stats', async ctx => {
    await ctx.answerCbQuery();
    await showStats(ctx);
  });

  bot.action('feature_premium', async ctx => {
    await ctx.answerCbQuery();
    await edit(ctx, '⭐ <b>VIP PREMIUM</b>\n\n🚧 Coming Soon\n\nPremium limits are already supported by the architecture and can be configured by Admin.', simpleBackKeyboard());
  });

  bot.action('feature_pending', async ctx => {
    await ctx.answerCbQuery();
    await edit(ctx, '⏳ <b>ACCEPT PENDING</b>\n\n🚧 Coming Soon', simpleBackKeyboard());
  });

  bot.action('feature_howto', async ctx => {
    await ctx.answerCbQuery();
    const settings = await getBusinessSettings();
    const buttons = settings.howToUrl
      ? Markup.inlineKeyboard([[Markup.button.url('▶️ Open How-To', settings.howToUrl)], [Markup.button.callback('⬅️ Dashboard', 'main_menu')]])
      : simpleBackKeyboard();
    await edit(ctx, settings.howToUrl ? '📖 <b>HOW TO USE</b>\n\nOpen the configured guide/video below.' : '📖 <b>HOW TO USE</b>\n\nAdmin has not configured the guide yet.', buttons);
  });

  bot.action('feature_create_bot', async ctx => {
    await ctx.answerCbQuery();
    const settings = await getBusinessSettings();
    const owner = String(settings.createBotOwner || '').replace(/^@/, '');
    const message = String(settings.createBotMessage || '');
    if (!owner) return edit(ctx, '🤖 <b>CREATE YOUR OWN BOT</b>\n\nAdmin has not configured the owner destination yet.', simpleBackKeyboard());
    const url = 'https://t.me/' + owner + '?text=' + encodeURIComponent(message);
    await edit(ctx, '🤖 <b>CREATE YOUR OWN BOT</b>\n\nPress Send to contact the configured owner.\n\n<i>Message:</i> ' + message, Markup.inlineKeyboard([
      [Markup.button.url('📤 Send', url)],
      [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
    ]));
  });

  bot.action('feature_referral', async ctx => {
    await ctx.answerCbQuery();
    const user = await User.findOne({ telegramId: ctx.from.id }).lean();
    const profile = await ReferralProfile.findOne({ ownerId: ctx.from.id }).lean();
    const settings = await getBusinessSettings();
    const link = 'https://t.me/' + config.botUsername + '?start=ref_' + ctx.from.id;
    await edit(ctx,
      '👥 <b>REFER & EARN</b>\n\n' +
      'Referral link:\n' + link + '\n\n' +
      'Referrals: ' + (user?.referrals || profile?.successfulCount || 0) + '\n' +
      'Earned: ₹' + (user?.referralEarned || profile?.earned || 0) + '\n' +
      'Reward: ₹' + settings.referralReward,
      simpleBackKeyboard()
    );
  });

  bot.action('feature_preview', async ctx => {
    await ctx.answerCbQuery();
    const templates = await MessageTemplate.find({ ownerId: ctx.from.id }).sort({ createdAt: -1 }).lean();
    if (!templates.length) return edit(ctx, '👁️ <b>PREVIEW MESSAGE</b>\n\nNo saved messages yet.', simpleBackKeyboard());
    await edit(ctx, '👁️ <b>PREVIEW MESSAGE</b>\n\nSelect a saved message to preview.', templateKeyboard(templates));
  });

  bot.on('text', async (ctx, next) => {
    const state = await getUiState(ctx.from.id, stateKey);
    if (!state) return next();
    const text = String(ctx.message.text || '').trim();
    if (text === '/cancel') {
      await clearUiState(ctx.from.id, stateKey);
      await ctx.reply('❌ Cancelled.');
      return;
    }
    if (state.data?.action === 'template_name') {
      if (!text) return ctx.reply('❌ Message name cannot be empty.');
      const name = text.slice(0, 100);
      const existing = await MessageTemplate.findOne({ ownerId: ctx.from.id, name }).lean();
      if (existing) return ctx.reply('❌ A message with this name already exists. Send another name.');
      const template = await MessageTemplate.create({ ownerId: ctx.from.id, name, type: 'text', text: '', active: false });
      await setUiState(ctx.from.id, stateKey, { action: 'template_edit', templateId: String(template._id) });
      await ctx.reply('✏️ Now send the message text for <b>' + name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</b>.', { parse_mode: 'HTML' });
      return;
    }
    if (state.data?.action === 'template_edit') {
      const template = await MessageTemplate.findOne({ _id: state.data.templateId, ownerId: ctx.from.id });
      if (!template) {
        await clearUiState(ctx.from.id, stateKey);
        return ctx.reply('❌ Message template not found.');
      }
      template.text = text.slice(0, 4096);
      template.type = 'text';
      await template.save();
      await clearUiState(ctx.from.id, stateKey);
      await ctx.reply('✅ Message saved successfully.');
      return;
    }
    return next();
  });
}
