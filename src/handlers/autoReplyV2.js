import { Markup } from 'telegraf';
import { Account } from '../db.js';
import { AutoReplySetting } from '../models/autoReply.js';
import { MessageTemplate } from '../models/messages.js';
import { UiState } from '../models/uiState.js';
import { getBusinessSettings } from '../services/businessSettings.js';
import { accountPickerKeyboard, simpleBackKeyboard, safeTelegramText } from '../bot/keyboards.js';

const key = 'autoreply_flow';

async function edit(ctx, text, keyboard = simpleBackKeyboard()) {
  try { await ctx.editMessageText(text, keyboard); }
  catch (e) {
    if (!String(e?.description || e?.message || '').includes('message is not modified')) throw e;
  }
}

async function show(ctx, accountId) {
  const setting = await AutoReplySetting.findOne({ ownerId: ctx.from.id, accountId }).lean();
  const templates = await MessageTemplate.find({ ownerId: ctx.from.id }).sort({ active: -1, createdAt: -1 }).limit(10).lean();
  const rows = templates.map(t => [Markup.button.callback(safeTelegramText((t.active ? '🟢 ' : '⚪ ') + t.name), 'autoreply_template:' + accountId + ':' + t._id)]);
  rows.push([Markup.button.callback('✏️ Write Reply', 'autoreply_write:' + accountId)]);
  rows.push([Markup.button.callback(setting?.enabled ? '⏸️ Disable' : '▶️ Enable', setting?.enabled ? 'autoreply_disable:' + accountId : 'autoreply_enable:' + accountId)]);
  rows.push([Markup.button.callback('⏱️ Cooldown', 'autoreply_cooldown:' + accountId)]);
  rows.push([Markup.button.callback('⬅️ Dashboard', 'main_menu')]);

  await edit(ctx,
    '🤖 <b>AUTO REPLY</b>\n\n' +
    'Status: ' + (setting?.enabled ? '🟢 ON' : '🔴 OFF') + '\n' +
    'Cooldown: ' + Math.round((setting?.cooldownMs || 3600000) / 60000) + ' minutes\n' +
    'Reply: ' + (setting?.fallbackText || (setting?.templateId ? 'Saved template' : 'Not configured')) + '\n\n' +
    '<i>Vercel deployment uses persistent polling for this feature; it is not a permanent MTProto listener.</i>',
    Markup.inlineKeyboard(rows)
  );
}

export function registerAutoReplyV2Handlers(bot, config) {
  bot.action('feature_autoreply', async ctx => {
    await ctx.answerCbQuery();
    const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).sort({ createdAt: -1 }).lean();
    if (!accounts.length) return edit(ctx, '❌ Connect a Telegram account first.', simpleBackKeyboard());
    await UiState.findOneAndUpdate(
      { ownerId: ctx.from.id, key },
      { $set: { data: { step: 'account' }, expiresAt: new Date(Date.now()+15*60*1000) } },
      { upsert: true }
    );
    await edit(ctx, '👤 <b>Select Account for Auto Reply</b>', accountPickerKeyboard(accounts, [], 'autoreply_account_done', 'autoreply_pick'));
  });

  bot.action(/^autoreply_pick:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const state = await UiState.findOne({ ownerId: ctx.from.id, key });
    if (!state) return;
    const id = String(ctx.match[1]);
    const selected = new Set((state.data.accountIds || []).map(String));
    selected.has(id) ? selected.delete(id) : selected.add(id);
    await UiState.findOneAndUpdate(
      { ownerId: ctx.from.id, key },
      { $set: { data: { ...state.data, accountIds: [...selected] } } }
    );
    const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).sort({ createdAt: -1 }).lean();
    await edit(ctx, '👤 <b>Select Account for Auto Reply</b>\n\nSelected: ' + selected.size, accountPickerKeyboard(accounts, [...selected], 'autoreply_account_done', 'autoreply_pick'));
  });

  bot.action('autoreply_pick_all', async ctx => {
    await ctx.answerCbQuery('All accounts selected');
    const state = await UiState.findOne({ ownerId: ctx.from.id, key });
    const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).select('_id').lean();
    await UiState.findOneAndUpdate({ ownerId: ctx.from.id, key }, { $set: { data: { ...(state?.data || {}), accountIds: accounts.map(a => String(a._id)) } } });
    return edit(ctx, '👤 <b>Select Account for Auto Reply</b>\\n\\nSelected: ' + accounts.length, accountPickerKeyboard(accounts, accounts.map(a => String(a._id)), 'autoreply_account_done', 'autoreply_pick'));
  });

  bot.action('autoreply_pick_clear', async ctx => {
    await ctx.answerCbQuery('Selection cleared');
    const state = await UiState.findOne({ ownerId: ctx.from.id, key });
    const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).sort({ createdAt: -1 }).lean();
    await UiState.findOneAndUpdate({ ownerId: ctx.from.id, key }, { $set: { data: { ...(state?.data || {}), accountIds: [] } } });
    return edit(ctx, '👤 <b>Select Account for Auto Reply</b>\\n\\nSelected: 0', accountPickerKeyboard(accounts, [], 'autoreply_account_done', 'autoreply_pick'));
  });

  bot.action('autoreply_account_done', async ctx => {
    await ctx.answerCbQuery();
    const state = await UiState.findOne({ ownerId: ctx.from.id, key });
    const ids = state?.data?.accountIds || [];
    if (ids.length !== 1) return edit(ctx, '❌ Auto Reply currently requires one selected account.', simpleBackKeyboard('feature_autoreply'));
    await UiState.findOneAndUpdate({ ownerId: ctx.from.id, key }, { $set: { data: { step: 'manage', accountId: ids[0] } } });
    await show(ctx, ids[0]);
  });

  bot.action(/^autoreply_template:(.+):(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const accountId = ctx.match[1];
    const templateId = ctx.match[2];
    const template = await MessageTemplate.findOne({ _id: templateId, ownerId: ctx.from.id }).lean();
    if (!template) return edit(ctx, '❌ Message template not found.');
    await AutoReplySetting.findOneAndUpdate(
      { ownerId: ctx.from.id, accountId },
      { $set: { templateId, fallbackText: '' }, $setOnInsert: { cooldownMs: 3600000 } },
      { upsert: true }
    );
    await show(ctx, accountId);
  });

  bot.action(/^autoreply_write:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const accountId = ctx.match[1];
    await UiState.findOneAndUpdate(
      { ownerId: ctx.from.id, key },
      { $set: { data: { step: 'message', accountId }, expiresAt: new Date(Date.now()+15*60*1000) } },
      { upsert: true }
    );
    await edit(ctx, '✏️ <b>Auto Reply Message</b>\n\nSend the reply text.\n\n/cancel to stop.', simpleBackKeyboard('feature_autoreply'));
  });

  bot.action(/^autoreply_enable:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Enabled');
    const accountId = ctx.match[1];
    await AutoReplySetting.findOneAndUpdate(
      { ownerId: ctx.from.id, accountId },
      { $set: { enabled: true }, $setOnInsert: { cooldownMs: 3600000 } },
      { upsert: true }
    );
    await show(ctx, accountId);
  });

  bot.action(/^autoreply_disable:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Disabled');
    await AutoReplySetting.updateOne({ ownerId: ctx.from.id, accountId: ctx.match[1] }, { $set: { enabled: false } });
    await show(ctx, ctx.match[1]);
  });

  bot.action(/^autoreply_cooldown:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const accountId = ctx.match[1];
    await edit(ctx, '⏱️ <b>SELECT COOLDOWN</b>\n\nCooldown is per individual sender.', Markup.inlineKeyboard([
      [Markup.button.callback('15 min', 'autoreply_setcool:' + accountId + ':900000'), Markup.button.callback('30 min', 'autoreply_setcool:' + accountId + ':1800000')],
      [Markup.button.callback('1 hour', 'autoreply_setcool:' + accountId + ':3600000'), Markup.button.callback('6 hours', 'autoreply_setcool:' + accountId + ':21600000')],
      [Markup.button.callback('24 hours', 'autoreply_setcool:' + accountId + ':86400000')],
      [Markup.button.callback('⬅️ Back', 'feature_autoreply')]
    ]));
  });

  bot.action(/^autoreply_setcool:(.+):([0-9]+)$/, async ctx => {
    await ctx.answerCbQuery('Cooldown saved');
    const accountId = ctx.match[1];
    const ms = Number(ctx.match[2]);
    const settings = await getBusinessSettings();
    await AutoReplySetting.findOneAndUpdate(
      { ownerId: ctx.from.id, accountId },
      { $set: { cooldownMs: Math.min(ms, Number(settings.maxAutoReplyCooldownMs) || 86400000) }, $setOnInsert: { enabled: false } },
      { upsert: true }
    );
    await show(ctx, accountId);
  });

  bot.on('text', async (ctx, next) => {
    const state = await UiState.findOne({ ownerId: ctx.from.id, key, expiresAt: { $gt: new Date() } });
    if (!state || state.data?.step !== 'message') return next();
    const text = String(ctx.message.text || '').trim();
    if (text === '/cancel') {
      await UiState.deleteOne({ _id: state._id });
      await ctx.reply('❌ Cancelled.');
      return;
    }
    if (!text) return ctx.reply('❌ Reply cannot be empty.');
    await AutoReplySetting.findOneAndUpdate(
      { ownerId: ctx.from.id, accountId: state.data.accountId },
      { $set: { fallbackText: text.slice(0,4096), templateId: null }, $setOnInsert: { enabled: false, cooldownMs: 3600000 } },
      { upsert: true }
    );
    await UiState.deleteOne({ _id: state._id });
    await ctx.reply('✅ Auto Reply message saved.', mainKeyboardFallback());
    return;
  });
}

function mainKeyboardFallback() {
  return { reply_markup: { inline_keyboard: [[{ text: '🤖 Auto Reply', callback_data: 'feature_autoreply' }], [{ text: '🏠 Dashboard', callback_data: 'main_menu' }]] } };
}
