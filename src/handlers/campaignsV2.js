import { waitUntil } from '@vercel/functions';
import { Markup } from 'telegraf';
import { Api } from 'telegram';
import { Account } from '../db.js';
import { MessageTemplate } from '../models/messages.js';
import { BusinessRecipient } from '../models/recipients.js';
import { ManagedGroup } from '../models/groups.js';
import { BusinessCampaign, CampaignRecipient } from '../models/campaigns.js';
import { setUiState, getUiState, clearUiState } from '../services/uiState.js';
import { getBusinessSettings } from '../services/businessSettings.js';
import { syncAuthorizedRecipients } from '../services/recipientService.js';
import { listPersonalDialogs } from '../services/telegramClient.js';
import { syncAccountGroups, restoreAccount } from '../services/accountService.js';
import { createCampaign, processCampaignBatch, pauseBusinessCampaign, resumeBusinessCampaign, stopBusinessCampaign } from '../services/businessCampaignService.js';
import { accountPickerKeyboard, simpleBackKeyboard, campaignControlKeyboard, messageInputKeyboard } from '../bot/keyboards.js';

function safeTelegramText(value) { const text = String(value ?? ''); return text.split('').filter(ch => { const code = ch.charCodeAt(0); return code < 55296 || code > 57343; }).join(''); }

function picker(accounts, selected, done) {
  return accountPickerKeyboard(accounts, selected, done);
}

function normalizeUiText(value) {
  return String(value ?? '').replace(/\\n/g, '\n');
}

function htmlUiOptions(keyboard, text) {
  const options = { ...(keyboard || {}) };
  if (!options.parse_mode && /<\/?(?:b|strong|i|u|s|code|pre)(?:\s[^>]*)?>/i.test(text)) {
    options.parse_mode = 'HTML';
  }
  return options;
}

async function edit(ctx, text, keyboard = simpleBackKeyboard()) {
  try {
    const normalized = normalizeUiText(text);
    const options = htmlUiOptions(keyboard, normalized);
    if (ctx.callbackQuery) {
      await ctx.editMessageText(normalized, options);
    } else {
      await ctx.reply(normalized, options);
    }
  } catch (e) {
    if (!String(e?.description || e?.message || '').includes('message is not modified')) throw e;
  }
}

async function showAccountPicker(ctx, type, config) {
  const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).sort({ createdAt: -1 }).lean();
  if (!accounts.length) return edit(ctx, '❌ <b>No connected Telegram accounts.</b>\n\nUse Add Account first.', simpleBackKeyboard());
  const key = type === 'dm' ? 'dm_flow' : 'group_flow';
  const flowType = type === 'group_schedule' ? 'group' : type;

  // If only one connected account exists, select it automatically.
  if (accounts.length === 1) {
    const accountId = String(accounts[0]._id);
    await setUiState(ctx.from.id, key, {
      step: 'accounts',
      accountIds: [accountId],
      type: flowType,
      scheduled: type === 'group_schedule'
    });
    if (flowType === 'dm') return showDmTargets(ctx);
    if (flowType === 'group_add') return showGroupAddTargets(ctx, config);
    return showGroupTargets(ctx);
  }

  await setUiState(ctx.from.id, key, {
    step: 'accounts',
    accountIds: [],
    type: flowType,
    scheduled: type === 'group_schedule'
  });

  const doneAction =
    type === 'dm' ? 'dm_accounts_done' :
    type === 'group_add' ? 'group_add_accounts_done' :
    'group_accounts_done';

  await edit(ctx, '👤 <b>Select Telegram Account</b>\n\nChoose one, multiple, or all connected accounts.', picker(accounts, [], doneAction));
}

async function selectedAccounts(ownerId, key) {
  const state = await getUiState(ownerId, key);
  return (state?.data?.accountIds || []).map(String);
}

async function showGroupAddTargets(ctx, config) {
  const ids = await selectedAccounts(ctx.from.id, 'group_flow');
  if (!ids.length) return edit(ctx, '❌ Select at least one account.', simpleBackKeyboard('feature_group'));

  await edit(ctx, '🔄 <b>Loading Telegram groups & channels...</b>\n\nTelegram dialog list is being read from the selected account(s).');

  let synced = 0;
  for (const id of ids) {
    try {
      const rows = await syncAccountGroups(ctx.from.id, id, config.encryptionKey);
      synced += rows.length;
    } catch (error) {
      console.warn('Group/channel dialog sync failed:', { accountId: id, error: error?.message });
    }
  }

  const rows = await ManagedGroup.find({
    ownerId: ctx.from.id,
    accountId: { $in: ids }
  }).sort({ name: 1 }).limit(200).lean();

  if (!rows.length) {
    return edit(ctx,
      '❌ <b>No Telegram groups/channels found.</b>\n\nMake sure the selected account is a member/admin of the required chats.',
      simpleBackKeyboard('feature_group')
    );
  }

  const state = await getUiState(ctx.from.id, 'group_flow');
  const selected = new Set((state?.data?.addTargetKeys || []).map(String));
  await setUiState(ctx.from.id, 'group_flow', {
    ...(state?.data || {}),
    step: 'add_targets',
    accountIds: ids,
    type: 'group_add',
    addTargetKeys: [...selected]
  });

  const buttons = rows.slice(0, 80).map(r => {
    const key = String(r.accountId) + ':' + String(r.telegramGroupId);
    const selectedNow = selected.has(key);
    const kind = r.type === 'channel' ? '📢' : r.type === 'supergroup' ? '👥' : '👥';
    const locked = !r.canPost;
    const label = locked
      ? '🔒 ' + kind + ' ' + safeTelegramText(r.name || r.telegramGroupId).slice(0, 25)
      : (selectedNow ? '☑️ ' : '☐ ') + kind + ' ' + safeTelegramText(r.name || r.telegramGroupId).slice(0, 25);
    return [Markup.button.callback(label, 'group_add_target:' + r.accountId + ':' + r.telegramGroupId)];
  });

  buttons.push([Markup.button.callback('☑️ Select All Writable', 'group_add_all')]);
  buttons.push([Markup.button.callback('➕ Add Selected (' + selected.size + ')', 'group_add_done')]);
  buttons.push([Markup.button.callback('🔄 Refresh Telegram Dialogs', 'group_add_refresh')]);
  buttons.push([Markup.button.callback('⬅️ Back', 'feature_group')]);

  await edit(
    ctx,
    '➕ <b>ADD GROUP / CHANNEL</b>\n\n' +
      'Telegram dialogs found: ' + rows.length + '\n' +
      'Selected: ' + selected.size + '\n\n' +
      '☑️ = selected\n🔒 = no posting permission\n\n' +
      'Select the chats you want to make available for Group Message.',
    Markup.inlineKeyboard(buttons)
  );
}

async function showDmTargets(ctx) {
  const ids = await selectedAccounts(ctx.from.id, 'dm_flow');
  if (!ids.length) return edit(ctx, '❌ Select at least one account.', simpleBackKeyboard('feature_dm'));

  await edit(ctx, '🔄 <b>Loading Telegram private chats...</b>\n\nReading the selected account(s)\' Telegram dialogs.');
  const dialogs = [];
  for (const id of ids) {
    try {
      // Refresh the consent/eligibility cache from the real Telegram dialog
      // list, then use the same live dialog list for the picker UI.
      await syncAuthorizedRecipients(ctx.from.id, id, config.encryptionKey).catch(() => {});
      const rows = await listPersonalDialogs(id);
      for (const row of rows) dialogs.push({ ...row, accountId: String(id) });
    } catch (error) {
      console.warn('DM dialog sync failed:', { accountId: id, error: error?.message });
    }
  }

  const authorizedRows = await BusinessRecipient.find({
    ownerId: ctx.from.id,
    accountId: { $in: ids },
    authorized: true
  }).select('accountId telegramUserId').lean();
  const authorized = new Set(
    authorizedRows.map(r => String(r.accountId) + ':' + String(r.telegramUserId))
  );

  if (!dialogs.length) {
    return edit(ctx,
      '🔎 <b>No private chats found.</b>\n\nOpen a private chat with the connected Telegram account first.',
      simpleBackKeyboard('feature_dm')
    );
  }

  await setUiState(ctx.from.id, 'dm_flow', {
    step: 'targets',
    accountIds: ids,
    targetKeys: [],
    type: 'dm'
  });

  const state = await getUiState(ctx.from.id, 'dm_flow');
  const selected = new Set((state?.data?.targetKeys || []).map(String));

  const buttons = dialogs.slice(0, 80).map(r => {
    const key = String(r.accountId) + ':' + String(r.id);
    const eligible = authorized.has(key);
    const isSelected = selected.has(key);
    const name = safeTelegramText(r.name || r.username || r.id).slice(0, 24);
    const label = !eligible
      ? '🔒 ' + name
      : (isSelected ? '☑️ ' : '☐ ') + name;
    return [Markup.button.callback(label, 'dm_target:' + r.accountId + ':' + r.id)];
  });

  buttons.push([Markup.button.callback('☑️ Select All Eligible', 'dm_targets_all')]);
  buttons.push([Markup.button.callback('✉️ Continue (' + selected.size + ' selected)', 'dm_targets_done')]);
  buttons.push([Markup.button.callback('🔄 Refresh Telegram DMs', 'dm_targets_refresh')]);
  buttons.push([Markup.button.callback('⬅️ Back', 'feature_dm')]);

  await edit(
    ctx,
    '👤 <b>TELEGRAM PRIVATE CHATS</b>\n\n' +
      'Chats found: ' + dialogs.length + '\n' +
      'Eligible: ' + authorized.size + '\n' +
      'Selected: ' + selected.size + '\n\n' +
      '☑️ = selected\n🔒 = not eligible for Mass DM',
    Markup.inlineKeyboard(buttons)
  );
}


async function showGroupTargets(ctx) {
  const ids = await selectedAccounts(ctx.from.id, 'group_flow');
  if (!ids.length) return edit(ctx, '❌ Select at least one account.', simpleBackKeyboard('feature_group'));
  // Continue must stay fast: use the already-synced group cache here.
  const rows = await ManagedGroup.find({ ownerId: ctx.from.id, accountId: { $in: ids }, canPost: true, saved: true }).sort({ name: 1 }).limit(200).lean();
  const state = await getUiState(ctx.from.id, 'group_flow');
  const availableKeys = new Set(rows.map(r => String(r.accountId) + ':' + String(r.telegramGroupId)));
  const selected = new Set(
    (state?.data?.targetKeys || []).map(String).filter(key => availableKeys.has(key))
  );

  // Drop stale selections when a group was removed or is no longer writable.
  // This prevents a hidden/deleted group from being sent to during Continue.
  if (!rows.length) {
    await setUiState(ctx.from.id, 'group_flow', {
      ...(state?.data || {}),
      step: 'targets',
      accountIds: ids,
      targetKeys: [],
      type: 'group'
    });
    return edit(ctx, '🔎 <b>No writable groups found.</b>\n\nTap <b>🔄 Refresh Groups</b> to scan the selected account again.', Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh Groups', 'group_refresh')],[Markup.button.callback('⬅️ Back', 'feature_group')]]), { parse_mode: 'HTML' });
  }
  await setUiState(ctx.from.id, 'group_flow', {
    ...(state?.data || {}),
    step: 'targets',
    accountIds: ids,
    targetKeys: [...selected],
    type: 'group'
  });

  const buttons = rows.slice(0, 30).map(r => {
    const key = String(r.accountId) + ':' + String(r.telegramGroupId);
    const isSelected = selected.has(key);
    const label = (isSelected ? '☑️ ' : '☐ ') +
      safeTelegramText(r.name || r.telegramGroupId).slice(0, 25) +
      (isSelected ? ' [SELECTED]' : '');
    return [Markup.button.callback(label, 'group_target:' + r.accountId + ':' + r.telegramGroupId)];
  });

  buttons.push([Markup.button.callback('☑️ Use All Writable Groups', 'group_targets_all')]);
  buttons.push([Markup.button.callback('🔄 Refresh Groups', 'group_refresh_targets')]);
  buttons.push([Markup.button.callback('✉️ Continue (' + selected.size + ' selected)', 'group_targets_done')]);
  buttons.push([Markup.button.callback('⬅️ Back', 'feature_group')]);

  await edit(
    ctx,
    '👥 <b>WRITABLE GROUPS</b>\n\nFound: ' + rows.length +
      '\nSelected: ' + selected.size +
      '\n\n☑️ = already selected\nTap a selected group again to unselect.',
    Markup.inlineKeyboard(buttons)
  );
}
async function showMessageChoice(ctx, type) {
  const key = type === 'dm' ? 'dm_flow' : 'group_flow';
  const state = await getUiState(ctx.from.id, key);
  if (!state?.data?.targetKeys?.length) return edit(ctx, '❌ Select at least one target.', simpleBackKeyboard(type === 'dm' ? 'feature_dm' : 'feature_group'));
  const templates = await MessageTemplate.find({ ownerId: ctx.from.id }).sort({ active: -1, createdAt: -1 }).limit(10).lean();
  const rows = templates.map(t => [Markup.button.callback(safeTelegramText((t.active ? '🟢 ' : '⚪ ') + t.name), 'campaign_template:' + type + ':' + t._id)]);
  rows.push([Markup.button.callback('✏️ Write New Message', 'campaign_write:' + type)]);
  rows.push([Markup.button.callback('⬅️ Back', type === 'dm' ? 'feature_dm' : 'feature_group')]);
  await edit(ctx, '💬 <b>SELECT MESSAGE</b>\n\nUse a saved template or write a new campaign message.', Markup.inlineKeyboard(rows));
}

async function buildPreview(ctx, type, message) {
  const key = type === 'dm' ? 'dm_flow' : 'group_flow';
  const state = await getUiState(ctx.from.id, key);
  const targets = state.data.targetKeys || [];
  const accounts = state.data.accountIds || [];
  const settings = await getBusinessSettings();
  const limit = type === 'dm' ? (settings.freeDmLimit || 20) : (settings.maxGroupsPerCampaign || 100);
  if (targets.length > limit) {
    return edit(ctx, '❌ <b>Limit exceeded</b>\n\nSelected: ' + targets.length + '\nAllowed: ' + limit + '\n\nAdmin can change this limit.');
  }
  await setUiState(ctx.from.id, key, { ...state.data, step: 'preview', message });
  const scheduleMode = type === 'group' && state.data?.scheduled;
  await edit(ctx,
    '📝 <b>CAMPAIGN REVIEW</b>\n\n' +
    'Type: ' + type.toUpperCase() + '\n' +
    'Accounts: ' + accounts.length + '\n' +
    'Targets: ' + targets.length + '\n' +
    'Delay: ' + Math.round((settings.defaultCampaignDelayMs || 20000) / 1000) + 's\n\n' +
    '<b>Message</b>\n' + message,
    Markup.inlineKeyboard([
      [Markup.button.callback(scheduleMode ? '⏰ Configure Auto Start' : '▶️ Confirm & Start', scheduleMode ? 'campaign_schedule_config' : 'campaign_confirm:' + type)],
      [Markup.button.callback('✏️ Edit Message', 'campaign_write:' + type)],
      [Markup.button.callback('❌ Cancel', type === 'dm' ? 'feature_dm' : 'feature_group')]
    ])
  );
}

export function registerCampaignV2Handlers(bot, config) {
  bot.action('feature_dm', async ctx => { await ctx.answerCbQuery(); await showAccountPicker(ctx, 'dm', config); });
  bot.action('feature_group', async ctx => { await ctx.answerCbQuery(); await showAccountPicker(ctx, 'group', config); });

  bot.action(/^account_pick:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    for (const key of ['dm_flow','group_flow']) {
      const state = await getUiState(ctx.from.id, key);
      if (!state || state.data.step !== 'accounts') continue;
      const id = String(ctx.match[1]);
      const set = new Set((state.data.accountIds || []).map(String));
      set.has(id) ? set.delete(id) : set.add(id);
      await setUiState(ctx.from.id, key, { ...state.data, accountIds: [...set] });
      const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).sort({ createdAt: -1 }).lean();
      return edit(ctx, '👤 <b>Select Account</b>\n\nSelected: ' + set.size, picker(accounts, [...set], state.data.type === 'dm' ? 'dm_accounts_done' : 'group_accounts_done'));
    }
  });

  bot.action('account_pick_all', async ctx => {
    await ctx.answerCbQuery('All selected');
    for (const key of ['dm_flow','group_flow']) {
      const state = await getUiState(ctx.from.id, key);
      if (!state || state.data.step !== 'accounts') continue;
      const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).select('_id').lean();
      await setUiState(ctx.from.id, key, { ...state.data, accountIds: accounts.map(a => String(a._id)) });
      return edit(ctx, '👤 <b>Select Account</b>\n\nSelected: ' + accounts.length, picker(accounts, accounts.map(a => String(a._id)), state.data.type === 'dm' ? 'dm_accounts_done' : 'group_accounts_done'));
    }
  });

  bot.action('account_pick_clear', async ctx => {
    await ctx.answerCbQuery('Selection cleared');
    for (const key of ['dm_flow','group_flow']) {
      const state = await getUiState(ctx.from.id, key);
      if (!state || state.data.step !== 'accounts') continue;
      await setUiState(ctx.from.id, key, { ...state.data, accountIds: [] });
      const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).sort({ createdAt: -1 }).lean();
      return edit(ctx, '👤 <b>Select Account</b>\n\nSelected: 0', picker(accounts, [], state.data.type === 'dm' ? 'dm_accounts_done' : 'group_accounts_done'));
    }
  });

  bot.action('dm_accounts_done', async ctx => {
    await ctx.answerCbQuery();
    const ids = await selectedAccounts(ctx.from.id, 'dm_flow');
    if (!ids.length) return edit(ctx, '❌ Select at least one account.', simpleBackKeyboard('feature_dm'));
    for (const id of ids) await syncAuthorizedRecipients(ctx.from.id, id, config.encryptionKey).catch(() => {});
    await showDmTargets(ctx);
  });

  bot.action('group_accounts_done', async ctx => {
    await ctx.answerCbQuery();
    const ids = await selectedAccounts(ctx.from.id, 'group_flow');
    if (!ids.length) return edit(ctx, '❌ Select at least one account.', simpleBackKeyboard('feature_group'));
    for (const id of ids) {
      await syncAccountGroups(ctx.from.id, id, config.encryptionKey).catch(error => {
        console.warn('Group/channel sync failed:', { accountId: id, error: error?.message });
      });
    }
    await showGroupTargets(ctx);
  });

  bot.action(/^dm_target:(.+):(.+)$/, async ctx => {
    const accountId = String(ctx.match[1]);
    const userId = String(ctx.match[2]);
    const recipient = await BusinessRecipient.findOne({
      ownerId: ctx.from.id,
      accountId,
      telegramUserId: userId,
      authorized: true
    }).lean();
    if (!recipient) return ctx.answerCbQuery('This private chat is not eligible for Mass DM.');
    await ctx.answerCbQuery();
    const state = await getUiState(ctx.from.id, 'dm_flow');
    if (!state) return;
    const key = accountId + ':' + userId;
    const set = new Set((state.data.targetKeys || []).map(String));
    set.has(key) ? set.delete(key) : set.add(key);
    await setUiState(ctx.from.id, 'dm_flow', { ...state.data, targetKeys: [...set] });
    await showDmTargets(ctx);
  });

  bot.action('dm_targets_refresh', async ctx => {
    await ctx.answerCbQuery('Refreshing Telegram DMs...');
    await showDmTargets(ctx);
  });

  bot.action('dm_targets_all', async ctx => {
    await ctx.answerCbQuery('All eligible selected');
    const state = await getUiState(ctx.from.id, 'dm_flow');
    const rows = await BusinessRecipient.find({
      ownerId: ctx.from.id,
      accountId: { $in: state.data.accountIds },
      authorized: true
    }).lean();
    await setUiState(ctx.from.id, 'dm_flow', {
      ...state.data,
      targetKeys: rows.map(r => String(r.accountId) + ':' + String(r.telegramUserId))
    });
    await showDmTargets(ctx);
  });

  bot.action('dm_targets_done', async ctx => { await ctx.answerCbQuery(); await showMessageChoice(ctx, 'dm'); });

  bot.action(/^group_target:(.+):(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const state = await getUiState(ctx.from.id, 'group_flow');
    if (!state) return;
    const key = String(ctx.match[1]) + ':' + String(ctx.match[2]);
    const set = new Set((state.data.targetKeys || []).map(String));
    set.has(key) ? set.delete(key) : set.add(key);
    await setUiState(ctx.from.id, 'group_flow', { ...state.data, targetKeys: [...set] });
    await showGroupTargets(ctx);
  });

  bot.action('group_refresh_targets', async ctx => {
    await ctx.answerCbQuery('Refreshing groups...');
    const state = await getUiState(ctx.from.id, 'group_flow');
    const ids = (state?.data?.accountIds || []).map(String);
    if (!ids.length) return edit(ctx, '❌ Select at least one account.', simpleBackKeyboard('feature_group'));

    await edit(ctx, '🔄 <b>Refreshing Groups...</b>\\n\\nPlease wait...');
    let total = 0;
    for (const id of ids) {
      try {
        const groups = await syncAccountGroups(ctx.from.id, id, config.encryptionKey);
        total += groups.length;
      } catch (error) {
        console.warn('Group refresh failed:', { accountId: id, error: error?.message });
      }
    }

    // Re-render through the single group-picker renderer so existing
    // selections stay checked after a refresh.
    const latest = await getUiState(ctx.from.id, 'group_flow');
    await setUiState(ctx.from.id, 'group_flow', {
      ...(latest?.data || state.data),
      step: 'targets',
      accountIds: ids,
      type: 'group'
    });
    await showGroupTargets(ctx);
  });

  bot.action('group_targets_all', async ctx => {
    await ctx.answerCbQuery('All groups selected');
    const state = await getUiState(ctx.from.id, 'group_flow');
    const rows = await ManagedGroup.find({ ownerId: ctx.from.id, accountId: { $in: state.data.accountIds }, canPost: true }).lean();
    await setUiState(ctx.from.id, 'group_flow', { ...state.data, targetKeys: rows.map(r => String(r.accountId)+':'+String(r.telegramGroupId)) });
    await showMessageChoice(ctx, 'group');
  });

  bot.action('group_targets_done', async ctx => { await ctx.answerCbQuery(); await showMessageChoice(ctx, 'group'); });

  bot.action(/^campaign_template:(dm|group):(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const t = await MessageTemplate.findOne({ _id: ctx.match[2], ownerId: ctx.from.id }).lean();
    if (!t) return edit(ctx, '❌ Message template not found.');
    await buildPreview(ctx, ctx.match[1], t.text || '');
  });

  bot.action(/^campaign_write:(dm|group)$/, async ctx => {
    await ctx.answerCbQuery();
    // Prevent an old Auto Reply text-entry state from consuming campaign text.
    await clearUiState(ctx.from.id, 'autoreply_flow');
    const key = ctx.match[1] === 'dm' ? 'dm_flow' : 'group_flow';
    const state = await getUiState(ctx.from.id, key);
    if (!state?.data) {
      return edit(ctx, '❌ Campaign setup expired. Please start the campaign again.', simpleBackKeyboard(ctx.match[1] === 'dm' ? 'feature_dm' : 'feature_group'));
    }
    await setUiState(ctx.from.id, key, {
      ...state.data,
      step: 'message'
    });
    await edit(ctx, '✏️ <b>Campaign Message</b>\n\nSend the message you want to use.\n\n/cancel to stop.', messageInputKeyboard(ctx.match[1] === 'dm' ? 'feature_dm' : 'feature_group'));
  });

  bot.action('campaign_schedule_config', async ctx => {
    await ctx.answerCbQuery();
    const state = await getUiState(ctx.from.id, 'group_flow');
    if (!state?.data?.scheduled) return edit(ctx, '❌ Schedule setup expired.');
    await setUiState(ctx.from.id, 'group_flow', { ...state.data, step: 'schedule_interval' });
    await edit(ctx, '⏰ <b>AUTO START INTERVAL</b>\\n\\nSend the repeat interval in minutes.\\nExample: <code>60</code> = every 1 hour.\\nMinimum: 1 minute.');
  });

  bot.action(/^campaign_confirm:(dm|group)$/, async ctx => {
    await ctx.answerCbQuery('Starting campaign...');
    const type = ctx.match[1];
    const key = type === 'dm' ? 'dm_flow' : 'group_flow';
    const state = await getUiState(ctx.from.id, key);
    if (!state?.data?.message) return edit(ctx, '❌ Campaign message is missing.', simpleBackKeyboard(type === 'dm' ? 'feature_dm' : 'feature_group'));

    const targetPairs = state.data.targetKeys || [];
    const targetIds = [...new Set(targetPairs.map(x => String(x).split(':').slice(1).join(':')))];
    const accountIds = state.data.accountIds || [];
    const settings = await getBusinessSettings();
    const limit = type === 'dm' ? settings.freeDmLimit : settings.maxGroupsPerCampaign;
    if (targetPairs.length > limit) return edit(ctx, '❌ Campaign exceeds the configured limit: ' + limit);

    const campaign = await createCampaign({
      ownerId: ctx.from.id,
      accountIds,
      type,
      message: state.data.message,
      targetIds,
      targetPairs: targetPairs.map(x => {
        const [accountId, ...rest] = String(x).split(':');
        return { accountId, targetId: rest.join(':') };
      }),
      delayMs: settings.defaultCampaignDelayMs,
      status: 'running'
    });

    await clearUiState(ctx.from.id, key);
    await edit(ctx, '🚀 <b>Campaign Started</b>\n\nCampaign ID: ' + campaign._id + '\n\n' + formatCampaign(campaign, targetPairs.length) + '\n\nDelivery is running in the background.', campaignControlKeyboard(campaign._id));

    // Never keep the Telegram callback request open while sending messages.
    // A campaign can have several targets with a configured delay, so doing
    // the first batch inline makes the Continue/Confirm button look frozen.
    waitUntil(
      processCampaignBatch(campaign._id, config.encryptionKey, 8)
        .catch(error => console.error('Initial campaign batch failed:', error))
    );
  });

  bot.action(/^campaign_start:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Starting campaign...');
    const campaign = await BusinessCampaign.findOneAndUpdate(
      { _id: ctx.match[1], ownerId: ctx.from.id, status: 'draft' },
      { $set: { status: 'running', lastError: '' } },
      { new: true }
    );
    if (!campaign) return edit(ctx, '❌ Campaign not found or it is no longer in draft state.');
    waitUntil(
      processCampaignBatch(campaign._id, config.encryptionKey, 8).catch(error => {
        console.error('Background campaign start failed', { campaignId: String(campaign._id), error: error?.message });
      })
    );
    const remaining = await CampaignRecipient.countDocuments({ campaignId: campaign._id, status: 'pending' });
    await edit(ctx, formatCampaign(campaign, remaining), campaignControlKeyboard(campaign._id, campaign.status));
  });

  bot.action(/^campaign_status:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Refreshing status...');
    const campaign = await BusinessCampaign.findOne({ _id: ctx.match[1], ownerId: ctx.from.id }).lean();
    if (!campaign) return edit(ctx, '❌ Campaign not found.', simpleBackKeyboard('feature_group'));
    const remaining = await CampaignRecipient.countDocuments({ campaignId: campaign._id, status: 'pending' });
    await edit(ctx, formatCampaign(campaign, remaining), campaignControlKeyboard(campaign._id, campaign.status));
  });

  bot.action(/^campaign_pause:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Pausing...');
    const c = await pauseBusinessCampaign(ctx.from.id, ctx.match[1]);
    if (c) await edit(ctx, formatCampaign(c), campaignControlKeyboard(c._id));
  });

  bot.action(/^campaign_resume:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Resuming...');
    const c = await resumeBusinessCampaign(ctx.from.id, ctx.match[1]);
    if (!c) return edit(ctx, '❌ Campaign not found or cannot be resumed.');
    waitUntil(
      processCampaignBatch(c._id, config.encryptionKey, 8).catch(error => {
        console.error('Background campaign resume failed', {
          campaignId: String(c._id),
          error: error?.message
        });
      })
    );
    await edit(ctx, '▶️ <b>Campaign resumed</b>\n\nDelivery is continuing in the background.', campaignControlKeyboard(c._id));
  });

  bot.action(/^campaign_stop:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Stopping...');
    const c = await stopBusinessCampaign(ctx.from.id, ctx.match[1]);
    if (c) await edit(ctx, formatCampaign(c), simpleBackKeyboard());
  });

  bot.action('group_add', async ctx => {
    await ctx.answerCbQuery();
    await clearUiState(ctx.from.id, 'dm_flow');
    await clearUiState(ctx.from.id, 'autoreply_flow');
    await setUiState(ctx.from.id, 'group_flow', {
      step: 'add_menu',
      accountIds: [],
      type: 'group_add',
      addTargetKeys: []
    });
    await edit(ctx, '➕ <b>GROUP LIST</b>\\n\\nChoose what you want to do:', Markup.inlineKeyboard([
      [Markup.button.callback('1. Select Group', 'group_add_select')],
      [Markup.button.callback('2. Save Group List', 'group_saved_list')],
      [Markup.button.callback('3. Back', 'feature_group')]
    ]));
  });

  bot.action('group_add_select', async ctx => {
    await ctx.answerCbQuery();
    const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).select('_id').lean();
    if (!accounts.length) return edit(ctx, '❌ No connected Telegram account. Add an account first.', simpleBackKeyboard('feature_group'));
    const ids = accounts.map(a => String(a._id));
    await setUiState(ctx.from.id, 'group_flow', {
      step: 'add_targets',
      accountIds: ids,
      type: 'group_add',
      addTargetKeys: []
    });
    await showGroupAddTargets(ctx, config);
  });

  bot.action('group_saved_list', async ctx => {
    await ctx.answerCbQuery();
    await showSavedGroupList(ctx);
  });

  bot.action('group_add_accounts_done', async ctx => {
    await ctx.answerCbQuery();
    const ids = await selectedAccounts(ctx.from.id, 'group_flow');
    if (!ids.length) return edit(ctx, '❌ Select at least one account.', simpleBackKeyboard('feature_group'));
    await showGroupAddTargets(ctx, config);
  });

  bot.action(/^group_add_target:(.+):(.+)$/, async ctx => {
    const accountId = String(ctx.match[1]);
    const targetId = String(ctx.match[2]);
    const state = await getUiState(ctx.from.id, 'group_flow');
    const ids = (state?.data?.accountIds || []).map(String);
    if (!ids.includes(accountId)) return ctx.answerCbQuery('Account is not selected.');
    const group = await ManagedGroup.findOne({
      ownerId: ctx.from.id,
      accountId,
      telegramGroupId: targetId
    }).lean();
    if (!group) return ctx.answerCbQuery('Telegram chat was not found. Refresh.');
    if (!group.canPost) return ctx.answerCbQuery('No posting permission in this chat.');
    await ctx.answerCbQuery();
    const key = accountId + ':' + targetId;
    const set = new Set((state?.data?.addTargetKeys || []).map(String));
    set.has(key) ? set.delete(key) : set.add(key);
    await setUiState(ctx.from.id, 'group_flow', {
      ...(state?.data || {}),
      step: 'add_targets',
      type: 'group_add',
      addTargetKeys: [...set]
    });
    await showGroupAddTargets(ctx, config);
  });

  bot.action('group_add_all', async ctx => {
    await ctx.answerCbQuery('All writable chats selected');
    const state = await getUiState(ctx.from.id, 'group_flow');
    const rows = await ManagedGroup.find({
      ownerId: ctx.from.id,
      accountId: { $in: state?.data?.accountIds || [] },
      canPost: true
    }).lean();
    await setUiState(ctx.from.id, 'group_flow', {
      ...(state?.data || {}),
      step: 'add_targets',
      type: 'group_add',
      addTargetKeys: rows.map(r => String(r.accountId) + ':' + String(r.telegramGroupId))
    });
    await showGroupAddTargets(ctx, config);
  });

  bot.action('group_add_done', async ctx => {
    await ctx.answerCbQuery('Saving...');
    const state = await getUiState(ctx.from.id, 'group_flow');
    const selected = [...new Set((state?.data?.addTargetKeys || []).map(String))];
    if (!selected.length) return edit(ctx, '❌ Select at least one writable group/channel first.');
    let saved = 0;
    for (const key of selected) {
      const [accountId, ...rest] = key.split(':');
      const telegramGroupId = rest.join(':');
      const result = await ManagedGroup.updateOne(
        { ownerId: ctx.from.id, accountId, telegramGroupId, canPost: true },
        { $set: { saved: true } }
      );
      saved += result.modifiedCount || 0;
    }
    await clearUiState(ctx.from.id, 'group_flow');
    await edit(ctx, '✅ <b>Group list saved</b>\\n\\nSaved: ' + saved + ' group(s).', Markup.inlineKeyboard([
      [Markup.button.callback('📋 Open Saved Group List', 'group_saved_list')],
      [Markup.button.callback('⬅️ Back', 'feature_group')]
    ]));
  });

  async function showSavedGroupList(ctx) {
    const rows = await ManagedGroup.find({ ownerId: ctx.from.id, saved: true, canPost: true }).sort({ name: 1 }).limit(200).lean();
    if (!rows.length) return edit(ctx, '📋 <b>SAVED GROUP LIST</b>\\n\\nNo saved groups yet.', Markup.inlineKeyboard([
      [Markup.button.callback('➕ Select Group', 'group_add_select')],
      [Markup.button.callback('⬅️ Back', 'group_add')]
    ]));
    const buttons = rows.slice(0, 80).map(r => {
      const kind = r.type === 'channel' ? '📢' : '👥';
      return [Markup.button.callback('🗑️ ' + kind + ' ' + safeTelegramText(r.name || r.telegramGroupId).slice(0, 28), 'group_saved_delete:' + r._id)];
    });
    buttons.push([Markup.button.callback('➕ Add More Groups', 'group_add_select')]);
    buttons.push([Markup.button.callback('⬅️ Back', 'group_add')]);
    await edit(ctx, '📋 <b>SAVED GROUP LIST</b>\\n\\nSaved: ' + rows.length + '\\n\\nTap 🗑️ on a group to remove it from the saved list.', Markup.inlineKeyboard(buttons));
  }

  bot.action(/^group_saved_delete:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Removed from saved list');
    await ManagedGroup.updateOne({ _id: ctx.match[1], ownerId: ctx.from.id }, { $set: { saved: false } });
    await showSavedGroupList(ctx);
  });

  bot.action('group_add_refresh', async ctx => {
    await ctx.answerCbQuery('Refreshing Telegram dialogs...');
    await showGroupAddTargets(ctx, config);
  });

  bot.action('group_refresh', async ctx => {
    await ctx.answerCbQuery('Refreshing groups...');
    const state = await getUiState(ctx.from.id, 'group_flow');
    const selectedIds = (state?.data?.accountIds || []).map(String);
    const accounts = selectedIds.length
      ? await Account.find({ ownerId: ctx.from.id, status: 'connected', _id: { $in: selectedIds } }).lean()
      : await Account.find({ ownerId: ctx.from.id, status: 'connected' }).lean();

    if (!accounts.length) {
      return edit(ctx, '❌ Connect a Telegram account first.', simpleBackKeyboard('feature_group'));
    }

    await edit(ctx, '🔄 <b>Refreshing Groups...</b>\\n\\nPlease wait...');
    let total = 0;
    for (const account of accounts) {
      try {
        const groups = await syncAccountGroups(ctx.from.id, account._id, config.encryptionKey);
        total += groups.length;
      } catch (error) {
        console.warn('Group refresh failed:', { accountId: String(account._id), error: error?.message });
      }
    }

    if (selectedIds.length) {
      await setUiState(ctx.from.id, 'group_flow', {
        ...(state?.data || {}),
        step: 'targets',
        accountIds: selectedIds,
        type: 'group'
      });
      return showGroupTargets(ctx);
    }

    await edit(ctx, '🔄 <b>GROUP REFRESH COMPLETE</b>\\n\\nSynchronized groups: ' + total, simpleBackKeyboard('feature_group'));
  });

  bot.action('group_select', async ctx => { await ctx.answerCbQuery(); await showAccountPicker(ctx, 'group', config); });
  bot.action('group_new', async ctx => { await ctx.answerCbQuery(); await showAccountPicker(ctx, 'group', config); });
  bot.action('group_autostart', async ctx => { await ctx.answerCbQuery(); await showAccountPicker(ctx, 'group_schedule', config); });
  bot.action('group_history', async ctx => {
    await ctx.answerCbQuery();
    const rows = await BusinessCampaign.find({ ownerId: ctx.from.id, type: 'group' }).sort({ createdAt: -1 }).limit(15).lean();
    await edit(ctx, rows.length ? '📜 <b>GROUP CAMPAIGN HISTORY</b>\n\n' + rows.map(c => c._id+' · '+c.status+' · '+(c.stats?.sent||0)+' sent').join('\n') : '📜 <b>No group campaigns yet.</b>');
  });

  bot.on('text', async (ctx, next) => {
    const scheduleState = await getUiState(ctx.from.id, 'group_flow');
    if (scheduleState?.data?.step === 'schedule_interval') {
      const minutes = Number(String(ctx.message.text || '').trim());
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) return ctx.reply('❌ Enter whole minutes from 1 to 10080.');
      const end = new Date(Date.now() + minutes * 60000);
      await setUiState(ctx.from.id, 'group_flow', { ...scheduleState.data, step: 'schedule_end', repeatEveryMs: minutes * 60000 });
      await ctx.reply('⏰ Interval saved: every ' + minutes + ' minute(s).\\n\\nSend how many hours it should run, or <code>0</code> for no end.', { parse_mode: 'HTML' });
      return;
    }
    if (scheduleState?.data?.step === 'schedule_end') {
      const hours = Number(String(ctx.message.text || '').trim());
      if (!Number.isInteger(hours) || hours < 0 || hours > 8760) return ctx.reply('❌ Enter whole hours from 0 to 8760.');
      const endAt = hours === 0 ? null : new Date(Date.now() + hours * 3600000);
      const data = scheduleState.data;
      const campaign = await createCampaign({
        ownerId: ctx.from.id,
        accountIds: data.accountIds,
        type: 'group',
        message: data.message,
        targetIds: [...new Set((data.targetKeys || []).map(x => String(x).split(':').slice(1).join(':')))],
        targetPairs: (data.targetKeys || []).map(x => { const [accountId, ...rest] = String(x).split(':'); return { accountId, targetId: rest.join(':') }; }),
        delayMs: (await getBusinessSettings()).defaultCampaignDelayMs,
        status: 'scheduled',
        scheduledAt: new Date(),
        repeatEveryMs: data.repeatEveryMs,
        endAt
      });
      await clearUiState(ctx.from.id, 'group_flow');
      await ctx.reply('✅ <b>Auto Start scheduled</b>\\n\\nCampaign: ' + campaign._id + '\\nRepeat: every ' + Math.round(data.repeatEveryMs/60000) + ' minute(s)' + (endAt ? '\\nEnds: ' + endAt.toISOString() : '\\nEnds: Never'), { parse_mode: 'HTML', ...campaignControlKeyboard(campaign._id) });
      return;
    }

    for (const [key, type] of [['dm_flow','dm'],['group_flow','group']]) {
      const state = await getUiState(ctx.from.id, key);
      if (!state || state.data.step !== 'message') continue;
      const text = String(ctx.message.text || '').trim();
      if (!text) return ctx.reply('❌ Message cannot be empty.');
      if (text === '/cancel') {
        await clearUiState(ctx.from.id, key);
        await ctx.reply('❌ Campaign cancelled.');
        return;
      }
      await clearUiState(ctx.from.id, key);
      await setUiState(ctx.from.id, key, { ...state.data, step: 'preview', message: text.slice(0,4096) });
      await buildPreview(ctx, type, text.slice(0,4096));
      return;
    }
    return next();
  });
}

function formatCampaign(c, remaining = null) {
  const s = c?.stats || {};
  return '📨 <b>CAMPAIGN</b>\n\n' +
    'Status: ' + String(c?.status || 'unknown').toUpperCase() + '\n' +
    'Total: ' + (s.total || 0) + '\n' +
    'Sent: ' + (s.sent || 0) + '\n' +
    'Failed: ' + (s.failed || 0) + '\n' +
    'Skipped: ' + (s.skipped || 0) +
    (remaining == null ? '' : '\nRemaining: ' + remaining) +
    (c?.lastError ? '\n\n⚠️ ' + c.lastError : '');
}
