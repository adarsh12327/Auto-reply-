import { Telegraf } from 'telegraf';
import { User } from '../db.js';
import { mainKeyboard } from './keyboards.js';
import { startHandler } from '../handlers/start.js';
import { registerAccountHandlers } from '../handlers/account.js';
import { registerDashboardHandlers } from '../handlers/dashboard.js';
import { registerCampaignV2Handlers } from '../handlers/campaignsV2.js';
import { registerAutoReplyV2Handlers } from '../handlers/autoReplyV2.js';
import { registerJoinRequestHandlers } from '../handlers/joinRequest.js';
import { registerAdminV2Handlers } from '../handlers/adminV2.js';

export function createBot(config) {
  const bot = new Telegraf(config.botToken);

  bot.start(startHandler);

  bot.command('menu', async ctx => {
    await ctx.reply(
      '🏠 <b>BUSINESS COMMAND CENTER</b>\n\nManage your Telegram business automation from one place.',
      { parse_mode: 'HTML', ...mainKeyboard() }
    );
  });

  bot.command('subscribe', async ctx => {
    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      { $set: { subscribed: true, username: ctx.from.username, firstName: ctx.from.first_name, lastSeenAt: new Date() }, $setOnInsert: { telegramId: ctx.from.id } },
      { upsert: true }
    );
    await ctx.reply('✅ Promotional updates enabled.');
  });

  bot.command('unsubscribe', async ctx => {
    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      { $set: { subscribed: false, lastSeenAt: new Date() }, $setOnInsert: { telegramId: ctx.from.id } },
      { upsert: true }
    );
    await ctx.reply('✅ Promotional updates disabled.');
  });

  registerDashboardHandlers(bot, config);
  registerCampaignV2Handlers(bot, config);
  registerAutoReplyV2Handlers(bot, config);
  registerJoinRequestHandlers(bot, config);
  registerAccountHandlers(bot, config);
  registerAdminV2Handlers(bot, config);

  bot.catch((error, ctx) => {
    console.error('Bot error:', {
      message: error?.message,
      description: error?.description,
      code: error?.code,
      updateType: ctx?.updateType,
      callbackData: ctx?.callbackQuery?.data,
      command: ctx?.message?.text
    });
    return ctx.reply('❌ Something went wrong. Please try again.').catch(() => {});
  });

  return bot;
}
