import { Markup } from 'telegraf';
import { UiState } from '../models/uiState.js';
import { getBusinessSettings, setBusinessSetting } from '../services/businessSettings.js';

const key = 'join_request_flow';

async function edit(ctx, text, keyboard) {
  try { await ctx.editMessageText(text, keyboard); } catch {}
}

export function registerJoinRequestHandlers(bot) {
  bot.action('feature_join_request', async ctx => {
    await ctx.answerCbQuery();
    const s = await getBusinessSettings();
    await edit(ctx,
      '📩 <b>JOIN REQUEST DM</b>\n\n' +
      'Status: ' + (s.joinRequestEnabled ? '🟢 ON' : '🔴 OFF') + '\n' +
      'Chat: ' + (s.joinRequestChatId || 'Not configured') + '\n' +
      'Message: ' + (s.joinRequestMessage || 'Not configured') + '\n\n' +
      'This uses Telegram bot join-request updates. The bot must be an administrator with the required invite permission.',
      Markup.inlineKeyboard([
        [Markup.button.callback(s.joinRequestEnabled ? '⏸️ Disable' : '▶️ Enable', s.joinRequestEnabled ? 'joinreq_disable' : 'joinreq_enable')],
        [Markup.button.callback('⚙️ Set Chat ID', 'joinreq_chat')],
        [Markup.button.callback('✏️ Set DM Message', 'joinreq_message')],
        [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
      ])
    );
  });

  bot.action('joinreq_enable', async ctx => {
    await ctx.answerCbQuery('Enabled');
    await setBusinessSetting('joinRequestEnabled', true, ctx.from.id);
    await edit(ctx, '✅ Join Request DM enabled.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'feature_join_request')]]));
  });

  bot.action('joinreq_disable', async ctx => {
    await ctx.answerCbQuery();
    await setBusinessSetting('joinRequestEnabled', false, ctx.from.id);
    await edit(ctx, '⏸️ Join Request DM disabled.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'feature_join_request')]]));
  });

  bot.action('joinreq_chat', async ctx => {
    await ctx.answerCbQuery();
    await UiState.findOneAndUpdate(
      { ownerId: ctx.from.id, key },
      { $set: { data: { action: 'chat' }, expiresAt: new Date(Date.now()+10*60*1000) } },
      { upsert: true }
    );
    await edit(ctx, '⚙️ <b>JOIN REQUEST CHAT</b>\n\nSend the Telegram chat/channel ID where join requests should be monitored.\n\n/cancel to stop.');
  });

  bot.action('joinreq_message', async ctx => {
    await ctx.answerCbQuery();
    await UiState.findOneAndUpdate(
      { ownerId: ctx.from.id, key },
      { $set: { data: { action: 'message' }, expiresAt: new Date(Date.now()+10*60*1000) } },
      { upsert: true }
    );
    await edit(ctx, '✏️ <b>JOIN REQUEST DM</b>\n\nSend the message that will be sent to an eligible requester.\n\n/cancel to stop.');
  });

  bot.on('chat_join_request', async ctx => {
    try {
      const s = await getBusinessSettings();
      const request = ctx.update.chat_join_request;
      if (!s.joinRequestEnabled || !s.joinRequestChatId) return;
      if (String(request.chat.id) !== String(s.joinRequestChatId)) return;
      if (!request.user_chat_id) return;

      await ctx.telegram.sendMessage(request.user_chat_id, s.joinRequestMessage || 'Thanks for your join request. We will review it shortly.');
    } catch (error) {
      console.warn('Join request DM failed:', error?.message);
    }
  });

  bot.on('text', async (ctx, next) => {
    const state = await UiState.findOne({ ownerId: ctx.from.id, key, expiresAt: { $gt: new Date() } });
    if (!state) return next();

    const text = String(ctx.message.text || '').trim();
    if (text === '/cancel') {
      await UiState.deleteOne({ _id: state._id });
      await ctx.reply('❌ Cancelled.');
      return;
    }

    if (state.data?.action === 'chat') {
      if (!/^-?\d+$/.test(text)) return ctx.reply('❌ Send a valid Telegram chat ID.');
      await setBusinessSetting('joinRequestChatId', text, ctx.from.id);
      await UiState.deleteOne({ _id: state._id });
      await ctx.reply('✅ Join-request chat saved.');
      return;
    }

    if (state.data?.action === 'message') {
      await setBusinessSetting('joinRequestMessage', text.slice(0,4096), ctx.from.id);
      await UiState.deleteOne({ _id: state._id });
      await ctx.reply('✅ Join-request DM message saved.');
      return;
    }

    return next();
  });
}
