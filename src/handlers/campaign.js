import { Campaign, Account, Consent } from '../db.js';
import {
  backKeyboard,
  dmMenuKeyboard,
  dmAudienceKeyboard,
  dmDraftKeyboard,
  dmRunningKeyboard,
  dmPausedKeyboard,
  delayKeyboard,
  groupMenuKeyboard,
  groupDraftKeyboard,
  groupRunningKeyboard,
  groupPausedKeyboard
} from '../bot/keyboards.js';
import {
  runCampaign,
  getAuthorizedDmTargets,
  pauseCampaign,
  cancelCampaign
} from '../services/campaignService.js';
import { listWritableGroups } from '../services/telegramClient.js';

const pendingDm = new Map();
const pendingGroup = new Map();

function processedCount(campaign) {
  return Number(campaign.stats?.sent || 0) +
    Number(campaign.stats?.failed || 0) +
    Number(campaign.stats?.skipped || 0);
}

function progressText(campaign, processed, total, label = 'DM') {
  const sent = campaign.stats?.sent || 0;
  const failed = campaign.stats?.failed || 0;
  const skipped = campaign.stats?.skipped || 0;

  if (campaign.status === 'completed') {
    return `📩 ${label} Campaign Complete

Sent: ${sent}
Failed: ${failed}
Skipped: ${skipped}
Total: ${total}`;
  }

  if (campaign.status === 'paused') {
    return `⏸️ ${label} Campaign Paused

Progress: ${processed}/${total}
Sent: ${sent}
Failed: ${failed}
Skipped: ${skipped}`;
  }

  if (campaign.status === 'cancelled') {
    return `🛑 ${label} Campaign Stopped

Progress: ${processed}/${total}
Sent: ${sent}
Failed: ${failed}
Skipped: ${skipped}`;
  }

  return `🚀 ${label} Campaign Running

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
      text: '👥 Authorized DM Recipients\n\nNo authorized recipients found yet.\n\nPeople are authorized when they have actually contacted the connected account or otherwise completed the supported authorization flow.',
      rows
    };
  }

  const lines = rows.slice(0, 50).map((row, index) =>
    `${index + 1}. ${row.recipientId} · ${row.source}`
  );

  const extra = rows.length > 50 ? `\n\n…and ${rows.length - 50} more.` : '';

  return {
    text: `👥 Authorized DM Recipients\n\nTotal: ${rows.length}\n\n${lines.join('\n')}${extra}\n\n🔄 Refreshes the current authorized audience.`,
    rows
  };
}

async function showAudience(ctx) {
  const audience = await audienceText(ctx.from.id);
  await safeEdit(ctx, audience.text, dmAudienceKeyboard(audience.rows));
}

async function startDmCampaign(ctx, campaign, config) {
  const isResume = campaign.status === 'paused';
  const targets = isResume
    ? (Array.isArray(campaign.targetIds) ? campaign.targetIds.map(String) : [])
    : await getAuthorizedDmTargets(ctx.from.id);

  if (!targets.length) {
    await safeEdit(
      ctx,
      '❌ No authorized DM recipients found.\n\nThe account must have authorized recipients first.',
      dmAudienceKeyboard([])
    );
    return;
  }

  if (targets.length > config.maxRecipients) {
    await safeEdit(
      ctx,
      `❌ Too many authorized recipients for one campaign.\n\nCurrent: ${targets.length}\nMaximum: ${config.maxRecipients}`,
      dmAudienceKeyboard([])
    );
    return;
  }

  campaign.targetIds = targets;
  if (campaign.status !== 'paused') {
    campaign.stats = { total: targets.length, sent: 0, failed: 0, skipped: 0 };
    campaign.status = 'draft';
  }
  campaign.delayMs = Math.max(1000, Number(campaign.delayMs) || config.sendDelayMs || 20000);
  await campaign.save();

  await safeEdit(
    ctx,
    progressText(campaign, processedCount(campaign), targets.length),
    dmRunningKeyboard(campaign._id)
  );

  runCampaign(campaign._id, {
    delayMs: campaign.delayMs,
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
      } catch {}
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

async function getConnectedAccount(ownerId) {
  return Account.findOne({
    ownerId,
    status: 'connected'
  });
}

async function scanGroups(ownerId) {
  const account = await getConnectedAccount(ownerId);
  if (!account) throw new Error('Connect your Telegram account first.');
  const groups = await listWritableGroups(account._id);
  return { account, groups };
}

function groupListText(groups) {
  if (!groups.length) {
    return '🔎 Group Scan Complete\n\nNo joined groups were found where this account can currently post.';
  }

  const lines = groups.slice(0, 50).map((group, i) =>
    `${i + 1}. ${group.title} · ${group.id}`
  );
  const extra = groups.length > 50 ? `\n\n…and ${groups.length - 50} more.` : '';

  return `🔎 Writable Groups\n\nTotal: ${groups.length}\n\n${lines.join('\n')}${extra}\n\nThe send step rechecks posting permission before each delivery.`;
}

async function startGroupCampaign(ctx, campaign, config) {
  const account = await getConnectedAccount(ctx.from.id);
  if (!account) {
    await safeEdit(ctx, '❌ Connect your Telegram account first.', backKeyboard());
    return;
  }

  const isResume = campaign.status === 'paused';
  let targets = isResume
    ? (Array.isArray(campaign.targetIds) ? campaign.targetIds.map(String) : [])
    : null;

  if (!isResume) {
    try {
      const groups = await listWritableGroups(account._id);
      targets = groups.map(group => group.id);
    } catch (error) {
    await safeEdit(ctx, `❌ Group scan failed\n\n${error.message}`, backKeyboard());
    return;
  }

  if (!targets.length) {
    await safeEdit(
      ctx,
      '❌ No writable groups found on the connected Telegram account.',
      groupMenuKeyboard()
    );
    return;
  }

  if (targets.length > config.maxRecipients) {
    await safeEdit(
      ctx,
      `❌ Too many writable groups for one campaign.\n\nCurrent: ${targets.length}\nMaximum: ${config.maxRecipients}`,
      groupMenuKeyboard()
    );
    return;
  }

  campaign.targetIds = targets;
  campaign.accountId = account._id;
  if (campaign.status !== 'paused') {
    campaign.stats = { total: targets.length, sent: 0, failed: 0, skipped: 0 };
    campaign.status = 'draft';
  }
  campaign.delayMs = Math.max(1000, Number(campaign.delayMs) || 20000);
  await campaign.save();

  await safeEdit(
    ctx,
    progressText(campaign, processedCount(campaign), targets.length, 'Group'),
    groupRunningKeyboard(campaign._id)
  );

  runCampaign(campaign._id, {
    delayMs: campaign.delayMs,
    requireConsent: config.requireConsent,
    requireGroupPermission: config.requireGroupPermission,
    onProgress: async (updated, processed, total) => {
      try {
        const keyboard = updated.status === 'paused'
          ? groupPausedKeyboard(updated._id)
          : updated.status === 'running'
            ? groupRunningKeyboard(updated._id)
            : backKeyboard();

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.callbackQuery?.message?.message_id,
          undefined,
          progressText(updated, processed, total, 'Group'),
          keyboard
        );
      } catch {}
    }
  }).catch(async error => {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery?.message?.message_id,
        undefined,
        `❌ Group Campaign Failed\n\n${error.message}`,
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
      `📩 DM Campaign\n\nAuthorized recipients: ${count}\n\nChoose an action below.`,
      dmMenuKeyboard()
    );
  });

  bot.action('dm_new', async ctx => {
    await ctx.answerCbQuery();
    pendingDm.set(ctx.from.id, { messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(
      '✉️ New DM Campaign\n\nSend the message you want to save.\n\nAfter saving, choose the delay and press ▶️ Send DM.',
      backKeyboard()
    );
  });

  bot.action('dm_audience', async ctx => {
    await ctx.answerCbQuery();
    await showAudience(ctx);
  });

  bot.action('dm_scan', async ctx => {
    await ctx.answerCbQuery('Refreshing...');
    const audience = await audienceText(ctx.from.id);
    await safeEdit(ctx, `🔎 Audience Refresh Complete\n\n${audience.text.replace(/^👥 Authorized DM Recipients\n\n/, '')}`, dmAudienceKeyboard(audience.rows));
  });

  bot.action(/^dm_recipient_remove:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Removing...');
    const target = String(ctx.match[1]);
    await Consent.updateOne(
      { ownerId: ctx.from.id, recipientId: target, active: true },
      { $set: { active: false, revokedAt: new Date() } }
    );
    await showAudience(ctx);
  });

  bot.action('dm_edit', async ctx => {
    await ctx.answerCbQuery();
    pendingDm.set(ctx.from.id, { messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText('✏️ Edit DM Message\n\nSend the new message text.', backKeyboard());
  });

  bot.action(/^dm_delay_menu:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'dm' });
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    await safeEdit(ctx, `⏱️ Select DM delay\n\nCurrent: ${Math.round((campaign.delayMs || 20000) / 1000)} seconds`, delayKeyboard(campaign._id, campaign.delayMs || 20000));
  });

  bot.action(/^campaign_delay:(.+):([0-9]+)$/, async ctx => {
    await ctx.answerCbQuery('Delay saved');
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id });
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());

    const delayMs = Math.max(1000, Number(ctx.match[2]));
    campaign.delayMs = delayMs;
    await campaign.save();

    if (campaign.type === 'dm') {
      return safeEdit(
        ctx,
        `📝 DM Message Saved\n\n${campaign.message}\n\n⏱️ Delay: ${Math.round(delayMs / 1000)} seconds`,
        dmDraftKeyboard(campaign._id, delayMs)
      );
    }

    return safeEdit(
      ctx,
      `📝 Group Message Saved\n\n${campaign.message}\n\n⏱️ Delay: ${Math.round(delayMs / 1000)} seconds`,
      groupDraftKeyboard(campaign._id, delayMs)
    );
  });

  bot.action(/^dm_send:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'dm' });
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    await startDmCampaign(ctx, campaign, config);
  });

  bot.action(/^dm_pause:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Pausing...');
    const campaign = await pauseCampaign(ctx.match[1], ctx.from.id);
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    await safeEdit(ctx, progressText(campaign, processedCount(campaign), campaign.stats.total || 0), dmPausedKeyboard(campaign._id));
  });

  bot.action(/^dm_resume:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Resuming...');
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'dm' });
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    if (campaign.status !== 'paused') return safeEdit(ctx, 'ℹ️ Campaign is not paused.', backKeyboard());
    await startDmCampaign(ctx, campaign, config);
  });

  bot.action(/^dm_stop:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Stopping...');
    const campaign = await cancelCampaign(ctx.match[1], ctx.from.id);
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    await safeEdit(ctx, progressText(campaign, processedCount(campaign), campaign.stats.total || 0), backKeyboard());
  });

  bot.action('campaign_group', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '👥 Group Campaign\n\nThe connected Telegram account will scan joined groups where it can post.\n\nChoose an action below.',
      groupMenuKeyboard()
    );
  });

  bot.action('group_scan', async ctx => {
    await ctx.answerCbQuery('Scanning groups...');
    try {
      const { groups } = await scanGroups(ctx.from.id);
      await safeEdit(ctx, groupListText(groups), groupMenuKeyboard());
    } catch (error) {
      await safeEdit(ctx, `❌ Group scan failed\n\n${error.message}`, groupMenuKeyboard());
    }
  });

  bot.action('group_new', async ctx => {
    await ctx.answerCbQuery();
    pendingGroup.set(ctx.from.id, { messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(
      '✉️ New Group Campaign\n\nSend the message you want to save.\n\nBefore sending, the bot will scan the connected account for writable groups.',
      backKeyboard()
    );
  });

  bot.action(/^group_delay_menu:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'group' });
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    await safeEdit(ctx, `⏱️ Select group delay\n\nCurrent: ${Math.round((campaign.delayMs || 20000) / 1000)} seconds`, delayKeyboard(campaign._id, campaign.delayMs || 20000));
  });

  bot.action(/^group_send:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Scanning writable groups...');
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'group' });
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    await startGroupCampaign(ctx, campaign, config);
  });

  bot.action(/^group_edit:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    pendingGroup.set(ctx.from.id, { messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText('✏️ Edit Group Message\n\nSend the new message text.', backKeyboard());
  });

  bot.action(/^group_pause:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Pausing...');
    const campaign = await pauseCampaign(ctx.match[1], ctx.from.id);
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    await safeEdit(ctx, progressText(campaign, processedCount(campaign), campaign.stats.total || 0, 'Group'), groupPausedKeyboard(campaign._id));
  });

  bot.action(/^group_resume:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Resuming...');
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'group' });
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    if (campaign.status !== 'paused') return safeEdit(ctx, 'ℹ️ Campaign is not paused.', backKeyboard());
    await startGroupCampaign(ctx, campaign, config);
  });

  bot.action(/^group_stop:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Stopping...');
    const campaign = await cancelCampaign(ctx.match[1], ctx.from.id);
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', backKeyboard());
    await safeEdit(ctx, progressText(campaign, processedCount(campaign), campaign.stats.total || 0, 'Group'), backKeyboard());
  });

  bot.action('campaign_channel', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '📢 CHANNEL campaign\n\nUse an authorized channel target with the existing admin-permission checks.\n\n/campaign channel TARGET_ID MESSAGE',
      backKeyboard()
    );
  });

  bot.command('campaign', async ctx => {
    const parts = ctx.message.text.split(/\s+/);
    const type = parts[1];
    const target = parts[2];
    const message = parts.slice(3).join(' ').trim();

    if (!['dm', 'group', 'channel'].includes(type) || !target || !message) {
      return ctx.reply('Usage: /campaign dm|group|channel TARGET_ID MESSAGE');
    }

    const account = await getConnectedAccount(ctx.from.id);
    if (!account) return ctx.reply('❌ Connect your Telegram account first.');
    if (message.length > config.maxMessageLength) return ctx.reply('❌ Message is too long.');

    if (type === 'dm' && config.requireConsent) {
      const consent = await Consent.findOne({ ownerId: ctx.from.id, recipientId: target, active: true });
      if (!consent) return ctx.reply('❌ This DM target is not authorized.');
    }

    const campaign = await Campaign.create({
      ownerId: ctx.from.id,
      accountId: account._id,
      type,
      targetIds: [target],
      message,
      delayMs: config.sendDelayMs || 20000
    });

    await ctx.reply(`📝 Campaign created: ${campaign._id}\nUse /campaign_start ${campaign._id}`);
  });

  bot.command('campaign_start', async ctx => {
    const id = ctx.message.text.replace(/^\/campaign_start\s*/i, '').trim();
    if (!id) return ctx.reply('Usage: /campaign_start CAMPAIGN_ID');

    const campaign = await Campaign.findOne({ _id: id, ownerId: ctx.from.id });
    if (!campaign) return ctx.reply('❌ Campaign not found.');

    await ctx.reply('▶️ Campaign started.');
    try {
      await runCampaign(campaign._id, {
        delayMs: campaign.delayMs || config.sendDelayMs || 20000,
        requireConsent: config.requireConsent,
        requireGroupPermission: config.requireGroupPermission
      });
      await ctx.reply('✅ Campaign finished.');
    } catch (error) {
      await ctx.reply(`❌ Campaign failed: ${error.message}`);
    }
  });

  bot.on('text', async (ctx, next) => {
    const dmState = pendingDm.get(ctx.from.id);
    const groupState = pendingGroup.get(ctx.from.id);

    if (!dmState && !groupState) return next();

    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) {
      await ctx.reply('❌ Send the message as normal text.');
      return;
    }

    const mode = dmState ? 'dm' : 'group';
    const state = dmState || groupState;
    pendingDm.delete(ctx.from.id);
    pendingGroup.delete(ctx.from.id);

    const account = await getConnectedAccount(ctx.from.id);
    if (!account) return ctx.reply('❌ Connect your Telegram account first.');
    if (text.length > config.maxMessageLength) return ctx.reply('❌ Message is too long.');

    const campaign = await Campaign.create({
      ownerId: ctx.from.id,
      accountId: account._id,
      type: mode,
      targetIds: [],
      message: text,
      delayMs: config.sendDelayMs || 20000
    });

    await ctx.deleteMessage().catch(() => {});

    if (mode === 'dm') {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        state.messageId,
        undefined,
        `📝 DM Message Saved\n\n${text}\n\n⏱️ Delay: ${Math.round(campaign.delayMs / 1000)} seconds`,
        dmDraftKeyboard(campaign._id, campaign.delayMs)
      );
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        state.messageId,
        undefined,
        `📝 Group Message Saved\n\n${text}\n\n⏱️ Delay: ${Math.round(campaign.delayMs / 1000)} seconds`,
        groupDraftKeyboard(campaign._id, campaign.delayMs)
      );
    }
  });
}
