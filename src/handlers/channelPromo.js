import { Markup } from 'telegraf';
import { Account, Campaign } from '../db.js';
import { ensureAccountClient, listWritableChannels } from '../services/telegramClient.js';
import { runCampaign, pauseCampaign, cancelCampaign } from '../services/campaignService.js';

const pendingChannel = new Map();

const home = () => Markup.inlineKeyboard([
  [Markup.button.callback('✉️ New Channel Promotion', 'channel_new')],
  [Markup.button.callback('🔎 Scan Writable Channels', 'channel_scan')],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

const draftKeyboard = id => Markup.inlineKeyboard([
  [Markup.button.callback('▶️ Publish to Channels', 'channel_send:' + id)],
  [Markup.button.callback('✏️ Edit Message', 'channel_edit:' + id)],
  [Markup.button.callback('🔎 Scan Channels', 'channel_scan')],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

const runningKeyboard = id => Markup.inlineKeyboard([
  [Markup.button.callback('⏸️ Pause', 'channel_pause:' + id), Markup.button.callback('🛑 Stop', 'channel_stop:' + id)],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

const pausedKeyboard = id => Markup.inlineKeyboard([
  [Markup.button.callback('▶️ Resume', 'channel_resume:' + id), Markup.button.callback('🛑 Stop', 'channel_stop:' + id)],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

async function connectedAccount(ownerId, config) {
  const accounts = await Account.find({ ownerId }).sort({ updatedAt: -1 });
  for (const account of accounts) {
    try {
      await ensureAccountClient(account._id, config.encryptionKey);
      return account;
    } catch {}
  }
  return null;
}

function progress(c) {
  const s=c.stats || {};
  return '📢 CHANNEL PROMOTION\n\nStatus: ' + String(c.status).toUpperCase() +
    '\nSent: ' + (s.sent || 0) +
    '\nFailed: ' + (s.failed || 0) +
    '\nSkipped: ' + (s.skipped || 0) +
    '\nTotal: ' + (s.total || 0);
}

async function start(ctx, campaign, config) {
  const account = await connectedAccount(ctx.from.id, config);
  if (!account) return ctx.editMessageText('❌ Connect your Telegram account first.', home());

  const channels = campaign.status === 'paused'
    ? (campaign.targetIds || []).map(String)
    : (await listWritableChannels(account._id)).map(x => x.id);

  if (!channels.length) return ctx.editMessageText('❌ No writable channels found. The connected account must have permission to post.', home());
  if (channels.length > config.maxRecipients) return ctx.editMessageText('❌ Too many channels for one campaign.', home());

  campaign.accountId = account._id;
  campaign.targetIds = channels;
  if (campaign.status !== 'paused') campaign.stats = { total: channels.length, sent: 0, failed: 0, skipped: 0 };
  await campaign.save();

  await ctx.editMessageText(progress(campaign), runningKeyboard(campaign._id));

  runCampaign(campaign._id, {
    delayMs: Math.max(1000, Number(campaign.delayMs) || config.sendDelayMs || 3000),
    requireConsent: config.requireConsent,
    requireGroupPermission: true,
    onProgress: async updated => {
      const kb = updated.status === 'paused' ? pausedKeyboard(updated._id)
        : updated.status === 'running' ? runningKeyboard(updated._id) : home();
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, progress(updated), kb).catch(() => {});
    }
  }).catch(async error => {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, '❌ Channel promotion failed\n\n' + error.message, home()).catch(() => {});
  });
}

export function registerChannelPromoHandlers(bot, config) {
  bot.action('campaign_channel', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('📢 CHANNEL PROMOTION\n\nPublish a product, offer or announcement to channels where the connected account has posting permission.', home());
  });

  bot.action('channel_scan', async ctx => {
    await ctx.answerCbQuery('Scanning channels...');
    const account = await connectedAccount(ctx.from.id, config);
    if (!account) return ctx.editMessageText('❌ Connect your Telegram account first.', home());
    const channels = await listWritableChannels(account._id);
    const body = channels.length
      ? channels.slice(0, 50).map((x,i) => (i+1) + '. ' + x.title + (x.username ? ' @' + x.username : '')).join('\n')
      : 'No writable channels found.';
    await ctx.editMessageText('🔎 WRITABLE CHANNELS\n\nFound: ' + channels.length + '\n\n' + body, home());
  });

  bot.action('channel_new', async ctx => {
    await ctx.answerCbQuery();
    pendingChannel.set(ctx.from.id, { messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText('✉️ NEW CHANNEL PROMOTION\n\nSend the product/offer message you want to publish.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'campaign_channel')]]));
  });

  bot.action(/^channel_edit:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    pendingChannel.set(ctx.from.id, { messageId: ctx.callbackQuery.message.message_id, campaignId: ctx.match[1] });
    await ctx.editMessageText('✏️ Send the updated promotion message.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'campaign_channel')]]));
  });

  bot.action(/^channel_send:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Checking channels...');
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'channel' });
    if (!campaign) return ctx.editMessageText('❌ Campaign not found.', home());
    await start(ctx, campaign, config);
  });

  bot.action(/^channel_pause:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Pausing...');
    const c = await pauseCampaign(ctx.match[1], ctx.from.id);
    if (c) await ctx.editMessageText(progress(c), pausedKeyboard(c._id));
  });

  bot.action(/^channel_resume:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Resuming...');
    const c = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'channel' });
    if (c) await start(ctx, c, config);
  });

  bot.action(/^channel_stop:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Stopping...');
    const c = await cancelCampaign(ctx.match[1], ctx.from.id);
    if (c) await ctx.editMessageText(progress(c), home());
  });

  bot.on('text', async (ctx, next) => {
    const state = pendingChannel.get(ctx.from.id);
    if (!state) return next();
    const message = ctx.message.text?.trim();
    if (!message || message.startsWith('/')) return ctx.reply('❌ Send the promotion as normal text.');
    if (message.length > config.maxMessageLength) return ctx.reply('❌ Message is too long.');

    const account = await connectedAccount(ctx.from.id, config);
    if (!account) {
      pendingChannel.delete(ctx.from.id);
      return ctx.reply('❌ Connect your Telegram account first.');
    }

    let campaign;
    if (state.campaignId) {
      campaign = await Campaign.findOneAndUpdate(
        { _id: state.campaignId, ownerId: ctx.from.id, type: 'channel', status: 'draft' },
        { $set: { message, accountId: account._id } },
        { new: true }
      );
    } else {
      campaign = await Campaign.create({
        ownerId: ctx.from.id,
        accountId: account._id,
        type: 'channel',
        targetIds: [],
        message,
        delayMs: config.sendDelayMs || 3000
      });
    }
    pendingChannel.delete(ctx.from.id);
    await ctx.deleteMessage().catch(() => {});
    await ctx.telegram.editMessageText(ctx.chat.id, state.messageId, undefined,
      '📝 CHANNEL PROMOTION SAVED\n\n' + message + '\n\nThe bot will publish only to channels where posting permission is available.',
      draftKeyboard(campaign._id));
  });
}
