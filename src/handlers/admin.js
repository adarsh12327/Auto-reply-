import { User, Account, Campaign, Setting } from '../db.js';

export function registerAdminHandlers(bot, config) {
  bot.command('admin', async ctx => {
    if (!config.adminIds.includes(ctx.from.id)) return ctx.reply('⛔ Admin only.');

    const [users, accounts, campaigns] = await Promise.all([
      User.countDocuments(),
      Account.countDocuments({ status: 'connected' }),
      Campaign.countDocuments()
    ]);

    await ctx.reply(
      `👑 Admin Dashboard\n\n👥 Users: ${users}\n🤖 Connected accounts: ${accounts}\n📢 Campaigns: ${campaigns}\n\nUse /setref PERCENT to change the referral rate.`
    );
  });

  bot.command('setref', async ctx => {
    if (!config.adminIds.includes(ctx.from.id)) return ctx.reply('⛔ Admin only.');
    const value = Number(ctx.message.text.replace(/^\/setref\s*/i, ''));
    if (!Number.isFinite(value) || value < 0 || value > 100) return ctx.reply('Use a percentage from 0 to 100.');
    await Setting.findOneAndUpdate({ key: 'referral_percent' }, { value }, { upsert: true });
    await ctx.reply(`✅ Referral rate set to ${value}%.`);
  });
}
