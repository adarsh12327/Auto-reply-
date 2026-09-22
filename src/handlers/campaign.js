import { Campaign, Account, Consent, ScannedPeer } from '../db.js';
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
import { listWritableGroups, listAllGroups, listPersonalDialogs, syncIncomingDmConsents, ensureAccountClient } from '../services/telegramClient.js';
import { scanMenuKeyboard, scanListKeyboard, scannedSelectionKeyboard } from '../bot/keyboards.js';

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


async function saveScannedPeers(ownerId, accountId, peers) {
  if (!peers.length) return;
  const now = new Date();
  await ScannedPeer.bulkWrite(
    peers.map(peer => ({
      updateOne: {
        filter: { ownerId, accountId, peerId: peer.id },
        update: {
          $set: {
            type: peer.type,
            name: peer.name || '',
            username: peer.username || '',
            lastSeenAt: now
          },
          $setOnInsert: { ownerId, accountId, peerId: peer.id }
        },
        upsert: true
      }
    })),
    { ordered: false }
  );
}

function scannedListText(title, peers) {
  if (!peers.length) return `🔎 ${title}\n\nNo matching chats found.`;
  const lines = peers.slice(0, 50).map((peer, index) => {
    const handle = peer.username ? ` @${peer.username}` : '';
    return `${index + 1}. ${peer.name || 'Unknown'}${handle}\n   ID: ${peer.id}`;
  });
  const extra = peers.length > 50 ? `\n\n…and ${peers.length - 50} more saved.` : '';
  return `🔎 ${title}\n\nFound: ${peers.length}\n\n${lines.join('\n')}\n${extra}\n\nSaved in your customer directory. Open DM Campaigns → Select from Scanner to choose campaign contacts.`;
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
  const selectedTargets = Array.isArray(campaign.targetIds)
    ? campaign.targetIds.map(String).filter(Boolean)
    : [];
  const targets = isResume
    ? selectedTargets
    : selectedTargets.length
      ? selectedTargets
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
  // Vercel Hobby Functions have a 300s maximum. Keep a DM campaign within that
  // window while retaining the saved delay when it is already safe.
  const requestedDelay = Math.max(1000, Number(campaign.delayMs) || config.sendDelayMs || 3000);
  const safeDelay = Math.min(requestedDelay, 3000);
  campaign.delayMs = safeDelay;
  await campaign.save();

  await safeEdit(
    ctx,
    progressText(campaign, processedCount(campaign), targets.length),
    dmRunningKeyboard(campaign._id)
  );

  await runCampaign(campaign._id, {
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

async function getConnectedAccount(ownerId, config) {
  // Do not trust the persisted status alone. Vercel/serverless instances do not
  // share the in-memory GramJS client, so every scan must be able to restore
  // the account from its encrypted session stored in MongoDB.
  const accounts = await Account.find({ ownerId })
    .sort({ status: 1, updatedAt: -1 });

  if (!accounts.length) return null;

  let lastError = null;

  for (const account of accounts) {
    try {
      await ensureAccountClient(account._id, config.encryptionKey);
      return account;
    } catch (error) {
      lastError = error;
      console.warn('Telegram account restore failed', {
        accountId: String(account._id),
        status: account.status,
        error: error?.message
      });
    }
  }

  if (lastError) {
    throw new Error(
      'Telegram account could not be restored. ' +
      (lastError.message || 'Reconnect the account from Accounts.')
    );
  }

  return null;
}

async function scanGroups(ownerId, config) {
  const account = await getConnectedAccount(ownerId, config);
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
  const account = await getConnectedAccount(ctx.from.id, config);
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

  bot.action('scan_menu', async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '🔎 Telegram Scanner\n\nChoose what you want to scan.',
      scanMenuKeyboard()
    );
  });

  bot.action('scan_personal', async ctx => {
    await ctx.answerCbQuery('Scanning personal chats...');
    try {
      const account = await getConnectedAccount(ctx.from.id, config);
      if (!account) return safeEdit(ctx, '❌ Connect your Telegram account first.', backKeyboard());

      const peers = await listPersonalDialogs(account._id);
      await saveScannedPeers(ctx.from.id, account._id, peers);
      await safeEdit(
        ctx,
        scannedListText('Personal Account', peers),
        scanListKeyboard('personal')
      );
    } catch (error) {
      await safeEdit(ctx, `❌ Personal scan failed

${error.message}`, backKeyboard());
    }
  });

  bot.action('scan_groups', async ctx => {
    await ctx.answerCbQuery('Scanning groups...');
    try {
      const account = await getConnectedAccount(ctx.from.id, config);
      if (!account) return safeEdit(ctx, '❌ Connect your Telegram account first.', backKeyboard());

      const peers = await listAllGroups(account._id);
      await saveScannedPeers(ctx.from.id, account._id, peers);
      await safeEdit(
        ctx,
        scannedListText('Groups', peers),
        scanListKeyboard('groups')
      );
    } catch (error) {
      await safeEdit(ctx, `❌ Group scan failed

${error.message}`, backKeyboard());
    }
  });

  bot.action('campaign_dm', async ctx => {
    await ctx.answerCbQuery();
    const [scanned, authorized] = await Promise.all([
      ScannedPeer.countDocuments({ ownerId: ctx.from.id, type: 'personal' }),
      Consent.countDocuments({ ownerId: ctx.from.id, active: true })
    ]);
    await ctx.editMessageText(
      `📩 DM CAMPAIGN CENTER\n\n👥 Customer contacts: ${scanned}\n✅ Authorized contacts: ${authorized}\n\nCreate a message, choose your customer list, review, then send.`,
      dmMenuKeyboard()
    );
  });

  bot.action('dm_new', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    try {
      const account = await getConnectedAccount(ctx.from.id, config);
      if (!account) {
        return safeEdit(ctx, '❌ Connect your Telegram account first.', dmMenuKeyboard());
      }

      const campaign = await Campaign.create({
        ownerId: ctx.from.id,
        accountId: account._id,
        type: 'dm',
        targetIds: [],
        message: '',
        delayMs: config.sendDelayMs || 3000
      });

      pendingDm.set(ctx.from.id, {
        messageId: ctx.callbackQuery.message.message_id,
        campaignId: campaign._id
      });

      await ctx.editMessageText(
        '✉️ New DM Campaign\\n\\nSend the message you want to save.\\n\\nAfter saving, choose the delay and press ▶️ Send DM.',
        backKeyboard()
      );
    } catch (error) {
      console.error('Create DM campaign failed:', error);
      await safeEdit(
        ctx,
        '❌ Could not create the campaign.\\n\\n' +
          (error?.message || 'Please try again.'),
        dmMenuKeyboard()
      ).catch(() => {});
    }
  });

  async function renderScannedRecipients(ctx, campaignId, page = 0) {
    const campaign = await Campaign.findOne({ _id: campaignId, ownerId: ctx.from.id, type: 'dm', status: 'draft' });
    if (!campaign) return safeEdit(ctx, '❌ Campaign not found.', dmMenuKeyboard());
    const [scanned, authorized] = await Promise.all([
      ScannedPeer.find({ ownerId: ctx.from.id, accountId: campaign.accountId, type: 'personal' }).sort({ lastSeenAt: -1 }).lean(),
      Consent.find({ ownerId: ctx.from.id, active: true }).sort({ createdAt: 1 }).lean()
    ]);
    const byId = new Map();
    for (const peer of scanned) {
      byId.set(String(peer.peerId), {
        peerId: String(peer.peerId),
        name: peer.name || peer.username || 'Customer',
        username: peer.username || ''
      });
    }
    for (const row of authorized) {
      const id = String(row.recipientId);
      if (!byId.has(id)) {
        byId.set(id, { peerId: id, name: 'Authorized Customer', username: '' });
      }
    }
    const peers = [...byId.values()];
    const selected = Array.isArray(campaign.targetIds) ? campaign.targetIds.map(String) : [];
    if (!peers.length) {
      return safeEdit(
        ctx,
        '🔎 CUSTOMER CONTACTS\n\nNo contacts are available yet.\n\nUse Contact Scanner → Personal Contacts, or wait for a customer to contact the connected account.',
        dmMenuKeyboard()
      );
    }
    await safeEdit(
      ctx,
      '👥 CUSTOMER CONTACTS\n\nAvailable: ' + peers.length + '\nSelected: ' + selected.length + '\n\n☑️ Tap customers to select.\n\nOnly authorized DM recipients can pass the final send check.',
      scannedSelectionKeyboard(campaignId, peers, selected, page)
    );
  }

  bot.action('dm_scanned', async ctx => {
    await ctx.answerCbQuery();
    const account = await getConnectedAccount(ctx.from.id, config);
    if (!account) return safeEdit(ctx, '❌ Connect your Telegram account first.', dmMenuKeyboard());
    let campaign = await Campaign.findOne({ ownerId: ctx.from.id, accountId: account._id, type: 'dm', status: 'draft' }).sort({ updatedAt: -1 });
    if (!campaign) campaign = await Campaign.create({ ownerId: ctx.from.id, accountId: account._id, type: 'dm', targetIds: [], message: '', delayMs: config.sendDelayMs || 20000 });
    await renderScannedRecipients(ctx, campaign._id, 0);
  });

  bot.action(/^dm_pick_open:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    await renderScannedRecipients(ctx, ctx.match[1], 0);
  });

  bot.action(/^dm_pick_page:(.+):(\\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    await renderScannedRecipients(ctx, ctx.match[1], Number(ctx.match[2]));
  });

  bot.action(/^dm_pick:(.+):(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'dm', status: 'draft' });
    if (!campaign) return;
    const id = String(ctx.match[2]);
    const selected = new Set((campaign.targetIds || []).map(String));
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    campaign.targetIds = [...selected];
    await campaign.save();
    await renderScannedRecipients(ctx, campaign._id, 0);
  });

  bot.action(/^dm_pick_all:(.+)$/, async ctx => {
    await ctx.answerCbQuery('All contacts selected');
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'dm', status: 'draft' });
    if (!campaign) return;
    const [scanned, authorized] = await Promise.all([
      ScannedPeer.find({ ownerId: ctx.from.id, accountId: campaign.accountId, type: 'personal' }).select('peerId').lean(),
      Consent.find({ ownerId: ctx.from.id, active: true }).select('recipientId').lean()
    ]);
    const ids = new Set([
      ...scanned.map(p => String(p.peerId)),
      ...authorized.map(p => String(p.recipientId))
    ]);
    campaign.targetIds = [...ids];
    await campaign.save();
    await renderScannedRecipients(ctx, campaign._id, 0);
  });

  bot.action(/^dm_pick_clear:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Selection cleared');
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'dm', status: 'draft' });
    if (!campaign) return;
    campaign.targetIds = [];
    await campaign.save();
    await renderScannedRecipients(ctx, campaign._id, 0);
  });

  bot.action(/^dm_pick_done:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const campaign = await Campaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, type: 'dm', status: 'draft' });
    if (!campaign) return;
    if (!campaign.message) return safeEdit(ctx, '✉️ Add your campaign message first.', dmMenuKeyboard());
    await safeEdit(ctx, '📝 CAMPAIGN REVIEW\n\nMessage:\n' + campaign.message + '\n\n👥 Selected contacts: ' + campaign.targetIds.length + '\n\nChoose delay, then review and send.', dmDraftKeyboard(campaign._id, campaign.delayMs));
  });
  bot.action('dm_audience', async ctx => {
    await ctx.answerCbQuery();
    await showAudience(ctx);
  });

  bot.action('dm_scan', async ctx => {
    await ctx.answerCbQuery('Checking recent incoming DMs...');
    try {
      const account = await getConnectedAccount(ctx.from.id, config);
      if (!account) {
        return safeEdit(ctx, '❌ Connect your Telegram account first.', backKeyboard());
      }

      const synced = await syncIncomingDmConsents(account._id, ctx.from.id);
      const audience = await audienceText(ctx.from.id);
      const prefix = synced
        ? `🔄 Audience Refresh Complete\\n\\nFound ${synced} recent incoming DM${synced === 1 ? '' : 's'}.\\n\\n`
        : '🔄 Audience Refresh Complete\\n\\nNo new incoming DMs found.\\n\\n';

      await safeEdit(
        ctx,
        prefix + audience.text.replace(/^👥 Authorized DM Recipients\\n\\n/, ''),
        dmAudienceKeyboard(audience.rows)
      );
    } catch (error) {
      await safeEdit(ctx, `❌ Audience refresh failed\\n\\n${error.message}`, backKeyboard());
    }
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

  bot.action(/^dm_edit:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    pendingDm.set(ctx.from.id, { messageId: ctx.callbackQuery.message.message_id, campaignId: ctx.match[1] });
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
      const { groups } = await scanGroups(ctx.from.id, config);
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

    const account = await getConnectedAccount(ctx.from.id, config);
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

    const account = await getConnectedAccount(ctx.from.id, config);
    if (!account) return ctx.reply('❌ Connect your Telegram account first.');
    if (text.length > config.maxMessageLength) return ctx.reply('❌ Message is too long.');

    const campaign = state.campaignId
      ? await Campaign.findOneAndUpdate(
          { _id: state.campaignId, ownerId: ctx.from.id, type: mode, status: 'draft' },
          { $set: { message: text, accountId: account._id } },
          { new: true }
        )
      : await Campaign.create({
          ownerId: ctx.from.id,
          accountId: account._id,
          type: mode,
          targetIds: [],
          message: text,
          delayMs: config.sendDelayMs || 20000
        });

    if (!campaign) {
      await ctx.reply('❌ Campaign draft expired. Please create the campaign again.');
      return;
    }

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
