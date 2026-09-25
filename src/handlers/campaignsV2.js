import { Markup } from 'telegraf';
import { Account } from '../db.js';
import { MessageTemplate } from '../models/messages.js';
import { BusinessRecipient } from '../models/recipients.js';
import { ManagedGroup } from '../models/groups.js';
import { BusinessCampaign, CampaignRecipient } from '../models/campaigns.js';
import { setUiState, getUiState, clearUiState } from '../services/uiState.js';
import { getBusinessSettings } from '../services/businessSettings.js';
import { syncAuthorizedRecipients } from '../services/recipientService.js';
import { syncAccountGroups } from '../services/accountService.js';
import { createCampaign, processCampaignBatch, pauseBusinessCampaign, resumeBusinessCampaign, stopBusinessCampaign } from '../services/businessCampaignService.js';
import { accountPickerKeyboard, simpleBackKeyboard, campaignControlKeyboard, messageInputKeyboard } from '../bot/keyboards.js';

function picker(accounts, selected, done) {
  return accountPickerKeyboard(accounts, selected, done);
}

async function edit(ctx, text, keyboard = simpleBackKeyboard()) {
  try { await ctx.editMessageText(text, keyboard); }
  catch (e) {
    if (!String(e?.description || e?.message || '').includes('message is not modified')) throw e;
  }
}

async function showAccountPicker(ctx, type) {
  const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).sort({ createdAt: -1 }).lean();
  if (!accounts.length) return edit(ctx, '❌ <b>No connected Telegram accounts.</b>\n\nUse Add Account first.', simpleBackKeyboard());
  const key = type === 'dm' ? 'dm_flow' : 'group_flow';
  await setUiState(ctx.from.id, key, { step: 'accounts', accountIds: [], type });
  await edit(ctx, '👤 <b>Select Account</b>\n\nChoose one, multiple, or all connected accounts.', picker(accounts, [], type === 'dm' ? 'dm_accounts_done' : 'group_accounts_done'));
}

async function selectedAccounts(ownerId, key) {
  const state = await getUiState(ownerId, key);
  return (state?.data?.accountIds || []).map(String);
}

async function showDmTargets(ctx) {
  const ids = await selectedAccounts(ctx.from.id, 'dm_flow');
  if (!ids.length) return edit(ctx, '❌ Select at least one account.', simpleBackKeyboard('feature_dm'));
  const rows = await BusinessRecipient.find({ ownerId: ctx.from.id, accountId: { $in: ids }, authorized: true }).sort({ lastIncomingAt: -1 }).limit(200).lean();
  if (!rows.length) return edit(ctx, '🔎 <b>No eligible DM recipients found.</b>\n\nThe selected accounts need real incoming/private contact history before a recipient can be used for Mass DM.', simpleBackKeyboard('feature_dm'));
  await setUiState(ctx.from.id, 'dm_flow', { step: 'targets', accountIds: ids, targetKeys: [], type: 'dm' });
  const buttons = rows.slice(0, 30).map(r => [
    Markup.button.callback('☐ ' + (r.name || r.username || r.telegramUserId).slice(0, 25), 'dm_target:' + r.accountId + ':' + r.telegramUserId)
  ]);
  buttons.push([Markup.button.callback('☑️ Use All Eligible', 'dm_targets_all')]);
  buttons.push([Markup.button.callback('✉️ Continue', 'dm_targets_done')]);
  buttons.push([Markup.button.callback('⬅️ Back', 'feature_dm')]);
  await edit(ctx, '👥 <b>ELIGIBLE RECIPIENTS</b>\n\nFound: ' + rows.length + '\n\nSelect specific recipients or use all eligible recipients.', Markup.inlineKeyboard(buttons));
}

async function showGroupTargets(ctx) {
  const ids = await selectedAccounts(ctx.from.id, 'group_flow');
  if (!ids.length) return edit(ctx, '❌ Select at least one account.', simpleBackKeyboard('feature_group'));
  for (const id of ids) await syncAccountGroups(ctx.from.id, id, process.env.SESSION_ENCRYPTION_KEY ? Buffer.from(process.env.SESSION_ENCRYPTION_KEY, 'hex') : null).catch(() => {});
  const rows = await ManagedGroup.find({ ownerId: ctx.from.id, accountId: { $in: ids }, canPost: true }).sort({ name: 1 }).limit(200).lean();
  if (!rows.length) return edit(ctx, '🔎 <b>No writable groups found.</b>\n\nRefresh the selected accounts and make sure the Telegram accounts are members with permission to post.', simpleBackKeyboard('feature_group'));
  await setUiState(ctx.from.id, 'group_flow', { step: 'targets', accountIds: ids, targetKeys: [], type: 'group' });
  const buttons = rows.slice(0, 30).map(r => [
    Markup.button.callback('☐ ' + (r.name || r.telegramGroupId).slice(0, 25), 'group_target:' + r.accountId + ':' + r.telegramGroupId)
  ]);
  buttons.push([Markup.button.callback('☑️ Use All Writable Groups', 'group_targets_all')]);
  buttons.push([Markup.button.callback('✉️ Continue', 'group_targets_done')]);
  buttons.push([Markup.button.callback('⬅️ Back', 'feature_group')]);
  await edit(ctx, '👥 <b>WRITABLE GROUPS</b>\n\nFound: ' + rows.length + '\n\nSelect groups or use all writable groups.', Markup.inlineKeyboard(buttons));
}

async function showMessageChoice(ctx, type) {
  const key = type === 'dm' ? 'dm_flow' : 'group_flow';
  const state = await getUiState(ctx.from.id, key);
  if (!state?.data?.targetKeys?.length) return edit(ctx, '❌ Select at least one target.', simpleBackKeyboard(type === 'dm' ? 'feature_dm' : 'feature_group'));
  const templates = await MessageTemplate.find({ ownerId: ctx.from.id }).sort({ active: -1, createdAt: -1 }).limit(10).lean();
  const rows = templates.map(t => [Markup.button.callback((t.active ? '🟢 ' : '⚪ ') + t.name, 'campaign_template:' + type + ':' + t._id)]);
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
  await edit(ctx,
    '📝 <b>CAMPAIGN REVIEW</b>\n\n' +
    'Type: ' + type.toUpperCase() + '\n' +
    'Accounts: ' + accounts.length + '\n' +
    'Targets: ' + targets.length + '\n' +
    'Delay: ' + Math.round((settings.defaultCampaignDelayMs || 20000) / 1000) + 's\n\n' +
    '<b>Message</b>\n' + message,
    Markup.inlineKeyboard([
      [Markup.button.callback('▶️ Confirm & Start', 'campaign_confirm:' + type)],
      [Markup.button.callback('✏️ Edit Message', 'campaign_write:' + type)],
      [Markup.button.callback('❌ Cancel', type === 'dm' ? 'feature_dm' : 'feature_group')]
    ])
  );
}

export function registerCampaignV2Handlers(bot, config) {
  bot.action('feature_dm', async ctx => { await ctx.answerCbQuery(); await showAccountPicker(ctx, 'dm'); });
  bot.action('feature_group', async ctx => { await ctx.answerCbQuery(); await showAccountPicker(ctx, 'group'); });

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
    await showGroupTargets(ctx);
  });

  bot.action(/^dm_target:(.+):(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const state = await getUiState(ctx.from.id, 'dm_flow');
    if (!state) return;
    const key = String(ctx.match[1]) + ':' + String(ctx.match[2]);
    const set = new Set(state.data.targetKeys || []);
    set.has(key) ? set.delete(key) : set.add(key);
    await setUiState(ctx.from.id, 'dm_flow', { ...state.data, targetKeys: [...set] });
    await edit(ctx, '👥 <b>ELIGIBLE RECIPIENTS</b>\n\nSelected: ' + set.size, Markup.inlineKeyboard([
      [Markup.button.callback('☑️ Use All Eligible', 'dm_targets_all')],
      [Markup.button.callback('✉️ Continue', 'dm_targets_done')],
      [Markup.button.callback('⬅️ Back', 'feature_dm')]
    ]));
  });

  bot.action('dm_targets_all', async ctx => {
    await ctx.answerCbQuery('All eligible selected');
    const state = await getUiState(ctx.from.id, 'dm_flow');
    const rows = await BusinessRecipient.find({ ownerId: ctx.from.id, accountId: { $in: state.data.accountIds }, authorized: true }).lean();
    await setUiState(ctx.from.id, 'dm_flow', { ...state.data, targetKeys: rows.map(r => String(r.accountId)+':'+String(r.telegramUserId)) });
    await showMessageChoice(ctx, 'dm');
  });

  bot.action('dm_targets_done', async ctx => { await ctx.answerCbQuery(); await showMessageChoice(ctx, 'dm'); });

  bot.action(/^group_target:(.+):(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const state = await getUiState(ctx.from.id, 'group_flow');
    if (!state) return;
    const key = String(ctx.match[1]) + ':' + String(ctx.match[2]);
    const set = new Set(state.data.targetKeys || []);
    set.has(key) ? set.delete(key) : set.add(key);
    await setUiState(ctx.from.id, 'group_flow', { ...state.data, targetKeys: [...set] });
    await edit(ctx, '👥 <b>WRITABLE GROUPS</b>\n\nSelected: ' + set.size, Markup.inlineKeyboard([
      [Markup.button.callback('☑️ Use All Writable Groups', 'group_targets_all')],
      [Markup.button.callback('✉️ Continue', 'group_targets_done')],
      [Markup.button.callback('⬅️ Back', 'feature_group')]
    ]));
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
    await setUiState(ctx.from.id, ctx.match[1] === 'dm' ? 'dm_flow' : 'group_flow', {
      ...(await getUiState(ctx.from.id, ctx.match[1] === 'dm' ? 'dm_flow' : 'group_flow')).data,
      step: 'message'
    });
    await edit(ctx, '✏️ <b>Campaign Message</b>\n\nSend the message you want to use.\n\n/cancel to stop.', messageInputKeyboard(ctx.match[1] === 'dm' ? 'feature_dm' : 'feature_group'));
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
    if (targetIds.length > limit) return edit(ctx, '❌ Campaign exceeds the configured limit: ' + limit);

    const campaign = await createCampaign({
      ownerId: ctx.from.id,
      accountIds,
      type,
      message: state.data.message,
      targetIds,
      delayMs: settings.defaultCampaignDelayMs
    });

    await clearUiState(ctx.from.id, key);
    await edit(ctx, '🚀 <b>Campaign Started</b>\n\nCampaign ID: ' + campaign._id + '\n\nPreparing the first delivery batch...', campaignControlKeyboard(campaign._id));
    const result = await processCampaignBatch(campaign._id, config.encryptionKey, 8);
    const c = result.campaign || await BusinessCampaign.findById(campaign._id).lean();
    await edit(ctx, formatCampaign(c, result.remaining), campaignControlKeyboard(campaign._id));
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
    const result = await processCampaignBatch(c._id, config.encryptionKey, 8);
    await edit(ctx, formatCampaign(result.campaign || c, result.remaining), campaignControlKeyboard(c._id));
  });

  bot.action(/^campaign_stop:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Stopping...');
    const c = await stopBusinessCampaign(ctx.from.id, ctx.match[1]);
    if (c) await edit(ctx, formatCampaign(c), simpleBackKeyboard());
  });

  bot.action('group_refresh', async ctx => {
    await ctx.answerCbQuery('Refreshing groups...');
    const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).lean();
    let total = 0;
    for (const account of accounts) {
      try {
        const groups = await syncAccountGroups(ctx.from.id, account._id, config.encryptionKey);
        total += groups.length;
      } catch {}
    }
    await edit(ctx, '🔄 <b>GROUP REFRESH COMPLETE</b>\n\nSynchronized groups: ' + total, simpleBackKeyboard('feature_group'));
  });

  bot.action('group_select', async ctx => { await ctx.answerCbQuery(); await showAccountPicker(ctx, 'group'); });
  bot.action('group_new', async ctx => { await ctx.answerCbQuery(); await showAccountPicker(ctx, 'group'); });
  bot.action('group_autostart', async ctx => { await ctx.answerCbQuery(); await edit(ctx, '⏰ <b>GROUP AUTO START</b>\n\nPersistent scheduler support is being connected to the Vercel Cron worker.'); });
  bot.action('group_history', async ctx => {
    await ctx.answerCbQuery();
    const rows = await BusinessCampaign.find({ ownerId: ctx.from.id, type: 'group' }).sort({ createdAt: -1 }).limit(15).lean();
    await edit(ctx, rows.length ? '📜 <b>GROUP CAMPAIGN HISTORY</b>\n\n' + rows.map(c => c._id+' · '+c.status+' · '+(c.stats?.sent||0)+' sent').join('\n') : '📜 <b>No group campaigns yet.</b>');
  });

  bot.on('text', async (ctx, next) => {
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
