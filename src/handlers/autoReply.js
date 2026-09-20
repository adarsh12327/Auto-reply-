import { Account } from '../db.js';
import { mainKeyboard } from '../bot/keyboards.js';

export function registerAutoReplyHandlers(bot) {
  bot.action('auto_reply', async ctx => {
    await ctx.answerCbQuery();
    const account = await Account.findOne({ ownerId: ctx.from.id, status: 'connected' }).sort({ updatedAt: -1 });
    if (!account) return ctx.reply('❌ Connect a Telegram account first.', mainKeyboard());

    await ctx.reply(
      `🤖 Auto Reply\n\nStatus: ${account.autoReplyEnabled ? 'ON' : 'OFF'}\nReply: ${account.autoReplyText || 'Not set'}\n\nUse /autoreply_on, /autoreply_off or /setreply <message>.`,
      mainKeyboard()
    );
  });

  bot.command('autoreply_on', async ctx => {
    const account = await Account.findOneAndUpdate(
      { ownerId: ctx.from.id, status: 'connected' },
      { autoReplyEnabled: true },
      { sort: { updatedAt: -1 }, new: true }
    );
    await ctx.reply(account ? '✅ Auto Reply enabled.' : '❌ Connect an account first.');
  });

  bot.command('autoreply_off', async ctx => {
    await Account.updateMany({ ownerId: ctx.from.id }, { autoReplyEnabled: false });
    await ctx.reply('⏸️ Auto Reply disabled.');
  });

  bot.command('setreply', async ctx => {
    const text = ctx.message.text.replace(/^\/setreply\s*/i, '').trim();
    if (!text) return ctx.reply('Usage: /setreply Your message');
    const account = await Account.findOneAndUpdate(
      { ownerId: ctx.from.id, status: 'connected' },
      { autoReplyText: text.slice(0, 4096) },
      { sort: { updatedAt: -1 }, new: true }
    );
    await ctx.reply(account ? '✅ Reply message saved.' : '❌ Connect an account first.');
  });
}
