import { Campaign, Account, Consent } from '../db.js';
import {
  backKeyboard,
  dmMenuKeyboard,
  dmAudienceKeyboard,
  dmDraftKeyboard,
  dmRunningKeyboard,
  dmPausedKeyboard
} from '../bot/keyboards.js';
import {
  runCampaign,
  getAuthorizedDmTargets,
  pauseCampaign,
  cancelCampaign
} from '../services/campaignService.js';

const pendingDm = new Map();

function processedCount(campaign) {
  return Number(campaign.stats?.sent || 0) +
    Number(campaign.stats?.failed || 0) +
    Number(campaign.stats?.skipped || 0);
}

function progressText(campaign, processed, total) {
  const sent = campaign.stats?.sent || 0;
  const failed = campaign.stats?.failed || 0;
  const skipped = campaign.stats?.skipped || 0;

  if (campaign.status === 'completed') {
    return `📩 DM Campaign Complete

Sent: ${sent}
Failed: ${failed}
Skipped: ${skipped}
Total: ${total}`;
  }

  if (campaign.status === 'paused') {
    return `⏸️ DM Campaign Paused

Progress: ${processed}/${total}
Sent: ${sent}
Failed: ${failed}
Skipped: ${skipped}`;
  }

  if (campaign.status === 'cancelled') {
    return `🛑 DM Campaign Stopped

Progress: ${processed}/${total}
Sent: ${sent}
Failed: ${failed}
Skipped: ${skipped}`;
  }

  return `🚀 DM Campaign Running

Progress: ${processed}/${total}
Sent: ${sent}
Failed: ${failed}
Skipped: ${skipped}`;
}

async function safeEdit(ctx, text, keyboard) {
  try {
    await ctx.editMessageText(text, keyboard);
  } catch (error) {
    const message = String(error?.description || error?.message || '');
    if (!message.includes('message is not modified')) throw error;
  }
}

async function getAudienceRows(ownerId) {
  return Consent.find({ ownerId, active: true })
    .select('recipientId source createdAt')
    .sort({ createdAt: 1 })
    .lean();
}

async function audienceText(ownerId) {
  const rows = await getAudienceRows(ownerId);

  if (!rows.length) {
    return {
      text: '👥 Authorized DM Recipients\n\nNo authorized recipients found yet.\n\n🔎 Auto Scan checks the recipients already authorized by this account. People are not added just because they are friends or appeared in old chats.',
      rows
    };
  }

  const lines = rows.slice(0, 50).map((row, index) =>
    `${index + 1}. ${row.recipientId} · ${row.source}`
  );

  const extra = rows.length > 50 ? `\n\n…and ${rows.length - 50} more.` : '';

  return {
    text: `👥 Authorized DM Recipients\n\nTotal: ${rows.length}\n\n${lines.join('\n')}${extra}\n\n🔎 Auto Scan refreshes this authorized audience.`,
    rows
  };
}

async function showAudience(ctx) {
  const audience = await audienceText(ctx.from.id);
  await safeEdit(ctx, audience.text, dmAudienceKeyboard(audience.rows));
}

async function startDmCampaign(ctx, campaign, config) {
  const targets = await getAuthorizedDmTargets(ctx.from.id);

  if (!targets.length) {
    await safeEdit(
      ctx,
      '❌ No authorized DM recipients found.\n\nThe account must have authorized recipients first. Friends or old chat history are not automatically treated as promotional opt-ins.',
      dmAudienceKeyboard([])
    );
    return;
  }

  if (targets.length > config.maxRecipients) {
    await safeEdit(
      ctx,
      `❌ Too many authorized recipients for one campaign.\n\nCurrent: ${targets.length}\nMaximum: ${config.maxRecipients}\n\nRemove some recipients before sending.`,
      dmAudienceKeyboard([])
    );
    return;
  }

  campaign.targetIds = targets;
  if (campaign.status !== 'paused') {
    campaign.stats = { total: targets.length, sent: 0, failed: 0, skipped: 0 };
    campaign.status = 'draft';
  }
  await campaign.save();

  await safeEdit(ctx, progressText(campaign, processedCount(campaign), targets.length), dmRunningKeyboard(campaign._id));

  runCampaign(campaign._id, {
    delayMs: config.sendDelayMs,
    requireConsent: config.requireConsent,
    requireGroupPermission: config.requireGroupPermission,
    onProgress: async (updated, processed, total) => {
      try {
        const keyboard = updated.status === 'paused'
          ? dmPausedKeyboard(updated._id)
          : updated.status === 'running'
            ? dmRunningKeyboard(updated._id)
            : backKeyboard();

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery?.message?.message_id,
          undefined,
          progressText(updated, processed, total),
          keyboard
        );
      } catch {
        // UI updates must never interrupt the campaign.
      }
    }
  }).catch(async error => {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery?.message?.message_id,
        undefined,
        `❌ DM Campaign Failed\n\n${error.message}`,
        backKeyboard()
      );
    } catch {}
  });
}

export function registerCampaignHandlers(bot, config) {
  bot.action('campaign_dm', async ctx => {
    await ctx.answerCbQuery();
    const count = await Consent.countDocuments({ ownerId: ctx.from.id, active: true });
    await ctx.editMessageText(
      `📩 DM Campaign\n\nAuthorized recipients: ${count}\n\nOnly authorized/opt-in recipients are eligible.\n\nChoose an action below.`,
      dmMenuKeyboard()
    );
  });

  bot.action('dm_new', async ctx => {
    await ctx.answerCbQuery();
    pendingDm.set(ctx.from.id, { messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(
      '✉️ New DM Campaign\n\nSend the message you want to save.\n\nAfter saving, review it and press ▶️ Send DM.',
      backKeyboard()
    );
  });

  bot.action('dm_audience', async ctx => {
    await ctx.answerCbQuery();
    await showAudience(ctx);
  });

  bot.action('dm_scan', async ctx => {
    await ctx.answerCbQuery('Scanning authorized audience...');
    const audience = await audienceText(ctx.from.id);
    await safeEdit(
      ctx,
      `🔎 Authorized Audience Scan Complete\n\n${audience.text.replace(/^👥 Authorized DM Recipients\n\n/, '')}`,
      dmAudienceKeyboard(audience.rows)
    );
  });

  bot.action(/^dm_recipient_remove:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Removing...');
    const target = String(ctx.match[1]);

    await Consent.updateOne(
      {
        ownerId: ctx.from.id,
        recipientId: target,
        active: true
      },
      {
        $set: { active: false, revokedAt: new Date() }
      }
    );

    const audience = await audienceText(ctx.from.id);
    await safeEdit(ctx, audience.text, dmAudienceKeyboard(audience.rows));
  });

  bot.action('dm_edit', async ctx => {
    await ctx.answerCbQuery();
    pendingDm.set(ctx.from.id, {
      messageId: ctx.callbackQuery.message.message_id
    });
    await ctx.editMessageText('✏️ Edit DM Message\n\nSend the new message text.', backKeyboard());
  });

  bot.action(/^dm_send:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const campaign = await Campaign.findOne({
      _id: ctx.match[1],
      ownerId: ctx.from.id,
      type: 'dm'
    });

    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    await startDmCampaign(ctx, campaign, config);
  });

  bot.action(/^dm_pause:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Pausing...');
    const campaign = await pauseCampaign(ctx.match[1], ctx.from.id);
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());

    await safeEdit(
      ctx,
      progressText(campaign, processedCount(campaign), campaign.stats.total || 0),
      dmPausedKeyboard(campaign._id)
    );
  });

  bot.action(/^dm_resume:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Resuming...');
    const campaign = await Campaign.findOne({
      _id: ctx.match[1],
      ownerId: ctx.from.id,
      type: 'dm'
    });

    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    if (campaign.status !== 'paused') return safeEdit(ctx, 'ℹ️ Campaign is not paused.', backKeyboard());

    await startDmCampaign(ctx, campaign, config);
  });

  bot.action(/^dm_stop:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Stopping...');
    const campaign = await cancelCampaign(ctx.match[1], ctx.from.id);
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());

    await safeEdit(
      ctx,
      progressText(campaign, processedCount(campaign), campaign.stats.total || 0),
      backKeyboard()
    );
  });

  for (const type of ['group', 'channel']) {
    bot.action(`campaign_${type}`, async ctx => {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        `📢 ${type.toUpperCase()} campaign\n\nUse the admin-approved/authorized target and message flow.\n\n/campaign ${type} TARGET_ID MESSAGE`,
        backKeyboard()
      );
    });
  }

  bot.command('campaign', async ctx => {
    const parts = ctx.message.text.split(/\s+/);
    const type = parts[1];
    const target = parts[2];
    const message = parts.slice(3).join(' ').trim();

    if (!['dm', 'group', 'channel'].includes(type) || !target || !message) {
      return ctx.reply('Usage: /campaign dm|group|channel TARGET_ID MESSAGE');
    }

    const account = await Account.findOne({
      ownerId: ctx.from.id,
      status: 'connected'
    });

    if (!account) return ctx.reply('❌ Connect your Telegram account first.');
    if (message.length > config.maxMessageLength) return ctx.reply('❌ Message is too long.');

    if (type === 'dm' && config.requireConsent) {
      const consent = await Consent.findOne({
        ownerId: ctx.from.id,
        recipientId: target,
        active: true
      });

      if (!consent) return ctx.reply('❌ This DM target is not authorized.');
    }

    const campaign = await Campaign.create({
      ownerId: ctx.from.id,
      accountId: account._id,
      type,
      targetIds: [target],
      message
    });

    await ctx.reply(`📝 Campaign created: ${campaign._id}\nUse /campaign_start ${campaign._id}`);
  });

  bot.command('campaign_start', async ctx => {
    const id = ctx.message.text.replace(/^\/campaign_start\s*/i, '').trim();
    if (!id) return ctx.reply('Usage: /campaign_start CAMPAIGN_ID');

    const campaign = await Campaign.findOne({
      _id: id,
      ownerId: ctx.from.id
    });

    if (!campaign) return ctx.reply('❌ Campaign not found.');

    await ctx.reply('▶️ Campaign started.');

    try {
      await runCampaign(campaign._id, {
        delayMs: config.sendDelayMs,
        requireConsent: config.requireConsent,
        requireGroupPermission: config.requireGroupPermission
      });
      await ctx.reply('✅ Campaign finished.');
    } catch (error) {
      await ctx.reply(`❌ Campaign failed: ${error.message}`);
    }
  });

  bot.on('text', async (ctx, next) => {
    const state = pendingDm.get(ctx.from.id);
    if (!state) return next();

    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) {
      await ctx.reply('❌ Send the DM text as a normal message.');
      return;
    }

    pendingDm.delete(ctx.from.id);

    const account = await Account.findOne({
      ownerId: ctx.from.id,
      status: 'connected'
    });

    if (!account) return ctx.reply('❌ Connect your Telegram account first.');
    if (text.length > config.maxMessageLength) return ctx.reply('❌ Message is too long.');

    const campaign = await Campaign.create({
      ownerId: ctx.from.id,
      accountId: account._id,
      type: 'dm',
      targetIds: [],
      message: text
    });

    await ctx.deleteMessage().catch(() => {});

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      state.messageId,
      undefined,
      `📝 DM Message Saved

${text}

Press ▶️ Send DM to send it one-by-one to your authorized recipients.`,
      dmDraftKeyboard(campaign._id)
    );
  });
}
