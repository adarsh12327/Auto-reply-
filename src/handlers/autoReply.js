import { Account } from '../db.js';
import { autoReplyKeyboard } from '../bot/keyboards.js';

const pendingReply = new Map();

async function getConnectedAccount(ownerId) {
  return Account.findOne({ ownerId, status: 'connected' }).sort({ updatedAt: -1 });
}

function statusText(account) {
  return account
    ? `🤖 Auto Reply

Status: ${account.autoReplyEnabled ? '🟢 ON' : '🔴 OFF'}
Reply: ${account.autoReplyText || 'Not set'}`
    : '❌ Connect a Telegram account first.';
}

async function editAutoReply(ctx, account) {
  const text = statusText(account);
  try {
    await ctx.editMessageText(text, autoReplyKeyboard(Boolean(account?.autoReplyEnabled)));
  } catch (error) {
    const message = String(error?.description || error?.message || '');
    if (!message.includes('message is not modified')) throw error;
  }
}

export function registerAutoReplyHandlers(bot) {
  bot.action('auto_reply', async ctx => {
    await ctx.answerCbQuery();
    const account = await getConnectedAccount(ctx.from.id);
    await editAutoReply(ctx, account);
  });

  bot.action('auto_reply_set', async ctx => {
    await ctx.answerCbQuery();
    const account = await getConnectedAccount(ctx.from.id);
    if (!account) {
      return editAutoReply(ctx, null);
    }

    pendingReply.set(ctx.from.id, { messageId: ctx.callbackQuery.message.message_id });
    await ctx.editMessageText(
      '✏️ Set Auto Reply\n\nSend the message you want your Telegram account to automatically send as its first reply.\n\n/cancel to stop.',
      { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to Home', callback_data: 'auto_reply_cancel' }]] } }
    );
  });

  bot.action('auto_reply_cancel', async ctx => {
    await ctx.answerCbQuery();
    pendingReply.delete(ctx.from.id);
    const { mainKeyboard } = await import('../bot/keyboards.js');
    await ctx.editMessageText('🏠 Main Menu', mainKeyboard());
  });

  bot.action('auto_reply_on', async ctx => {
    await ctx.answerCbQuery();
    const account = await getConnectedAccount(ctx.from.id);
    if (!account) return editAutoReply(ctx, null);

    account.autoReplyEnabled = true;
    await account.save();
    await editAutoReply(ctx, account);
  });

  bot.action('auto_reply_off', async ctx => {
    await ctx.answerCbQuery();
    const account = await getConnectedAccount(ctx.from.id);
    if (!account) return editAutoReply(ctx, null);

    account.autoReplyEnabled = false;
    await account.save();
    await editAutoReply(ctx, account);
  });

  bot.action('auto_reply_clear', async ctx => {
    await ctx.answerCbQuery();
    const account = await getConnectedAccount(ctx.from.id);
    if (!account) return editAutoReply(ctx, null);

    account.autoReplyText = '';
    await account.save();
    await editAutoReply(ctx, account);
  });

  bot.on('text', async (ctx, next) => {
    const state = pendingReply.get(ctx.from.id);
    if (!state) return next();

    const text = ctx.message.text.trim();

    if (text === '/cancel') {
      pendingReply.delete(ctx.from.id);
      const account = await getConnectedAccount(ctx.from.id);
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          state.messageId,
          undefined,
          account ? statusText(account) : '❌ Connect a Telegram account first.',
          autoReplyKeyboard(Boolean(account?.autoReplyEnabled))
        );
      } catch (error) {
        const message = String(error?.description || error?.message || '');
        if (!message.includes('message is not modified')) throw error;
      }
      return;
    }

    if (!text || text.startsWith('/')) {
      await ctx.reply('❌ Send the reply text as a normal message, or /cancel.');
      return;
    }

    const account = await getConnectedAccount(ctx.from.id);
    pendingReply.delete(ctx.from.id);

    if (!account) {
      await ctx.reply('❌ No connected Telegram account found.');
      return;
    }

    account.autoReplyText = text.slice(0, 4096);
    await account.save();

    try {
      await ctx.deleteMessage();
    } catch {
      // Best effort only.
    }

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        state.messageId,
        undefined,
        statusText(account),
        autoReplyKeyboard(Boolean(account.autoReplyEnabled))
      );
    } catch (error) {
      const message = String(error?.description || error?.message || '');
      if (!message.includes('message is not modified')) throw error;
    }
  });
}
