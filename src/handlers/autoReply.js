import { Account } from '../db.js';
import { mainKeyboard } from '../bot/keyboards.js';

async function getConnectedAccount(ownerId) {
  return Account.findOne({ ownerId, status: 'connected' }).sort({ updatedAt: -1 });
}

function statusText(account) {
  return account
    ? `🤖 Auto Reply\n\nStatus: ${account.autoReplyEnabled ? 'ON' : 'OFF'}\nReply: ${account.autoReplyText || 'Not set'}`
    : '❌ Connect a Telegram account first.';
}

export function registerAutoReplyHandlers(bot) {
  bot.action('auto_reply', async ctx => {
    await ctx.answerCbQuery();
    const account = await getConnectedAccount(ctx.from.id);
    const text = account
      ? statusText(account) + '\n\nUse /autoreply_on, /autoreply_off or /setreply <message>.'
      : statusText(account);
    try {
      await ctx.editMessageText(text, mainKeyboard());
    } catch (error) {
      if (!String(error?.description || error?.message).includes('message is not modified')) throw error;
    }
  });

  bot.command('autoreply_on', async ctx => {
    const account = await getConnectedAccount(ctx.from.id);
    if (!account) return ctx.reply('❌ No connected Telegram account found.');

    account.autoReplyEnabled = true;
    await account.save();

    await ctx.reply(
      `✅ Auto Reply enabled.\n\nReply: ${account.autoReplyText || 'Not set'}\n\nSend a DM to your connected Telegram account to test it.`,
      mainKeyboard()
    );
  });

  bot.command('autoreply_off', async ctx => {
    const result = await Account.updateMany(
      { ownerId: ctx.from.id },
      { autoReplyEnabled: false }
    );
    await ctx.reply(
      result.modifiedCount
        ? '⏸️ Auto Reply disabled.'
        : '❌ No Telegram account found.',
      mainKeyboard()
    );
  });

  bot.command('setreply', async ctx => {
    const text = ctx.message.text.replace(/^\/setreply(?:@\w+)?\s*/i, '').trim();
    if (!text) return ctx.reply('Usage: /setreply Your message');

    const account = await getConnectedAccount(ctx.from.id);
    if (!account) return ctx.reply('❌ No connected Telegram account found.');

    account.autoReplyText = text.slice(0, 4096);
    await account.save();

    await ctx.reply(
      `✅ Reply message saved.\n\nCurrent reply: ${account.autoReplyText}\n\nNow use /autoreply_on to enable it.`,
      mainKeyboard()
    );
  });
}
