import { Telegraf, Markup } from 'telegraf';
import { Account, User, getSetting, incrementReferral, setSetting } from './db.js';
import {
  beginLogin,
  cancelLogin,
  getPending,
  removeAccount,
  setAutoReply,
  submitCode,
  submitPassword
} from './userClient.js';
import { logger, safeError } from './logger.js';

const bot = new Telegraf(process.env.BOT_TOKEN);
const state = new Map();
const supportUrl = process.env.SUPPORT_URL?.trim() || '';
const adminIds = new Set(
  (process.env.ADMIN_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)
);

function idOf(ctx) { return String(ctx.from?.id || ''); }
function isAdmin(ctx) { return adminIds.has(idOf(ctx)); }

function setState(userId, value) {
  state.set(String(userId), {
    ...value,
    expiresAt: Date.now() + 10 * 60_000
  });
}

function getState(userId) {
  const value = state.get(String(userId));
  if (!value) return null;

  if (value.expiresAt < Date.now()) {
    state.delete(String(userId));
    return null;
  }

  return value;
}

function clearState(userId) {
  state.delete(String(userId));
}

function mainMenu(ctx) {
  const rows = [
    [
      Markup.button.callback('💬 Auto Reply', 'autoreply'),
      Markup.button.callback('👤 Accounts', 'account')
    ],
    [
      Markup.button.callback('📈 My Stats', 'stats'),
      Markup.button.callback('🔗 Refer & Earn', 'refer')
    ],
    [
      Markup.button.callback('📢 Channel Promo', 'promo'),
      Markup.button.callback('⭐ VIP Premium', 'vip')
    ],
    [
      Markup.button.callback('🎟 Redeem Code', 'redeem'),
      Markup.button.callback('➕ Add Account', 'add')
    ],
    [
      Markup.button.callback('➖ Remove Account', 'remove'),
      Markup.button.callback('📖 How to Use', 'help')
    ]
  ];

  if (isAdmin(ctx)) {
    rows.push([
      Markup.button.callback('📣 Opt-in Broadcast', 'broadcast'),
      Markup.button.callback('⚙️ Admin', 'admin')
    ]);
  }

  if (supportUrl) rows.push([Markup.button.url('🆘 Support', supportUrl)]);
  rows.push([Markup.button.url('↗ BotFather', 'https://t.me/BotFather')]);

  return Markup.inlineKeyboard(rows);
}

async function ensureUser(ctx, referrerId = '') {
  const telegramId = idOf(ctx);
  if (!telegramId) throw new Error('Telegram user ID is missing.');

  let user = await User.findOne({ telegramId });

  if (!user) {
    const cleanReferrer =
      referrerId && referrerId !== telegramId ? String(referrerId) : '';

    try {
      user = await User.create({
        telegramId,
        username: ctx.from.username || '',
        firstName: ctx.from.first_name || '',
        referrerId: cleanReferrer
      });

      if (cleanReferrer) await incrementReferral(cleanReferrer);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      user = await User.findOne({ telegramId });
    }
  }

  await User.updateOne(
    { telegramId },
    {
      $set: {
        username: ctx.from.username || '',
        firstName: ctx.from.first_name || '',
        lastSeenAt: new Date(),
        blocked: false
      }
    }
  );

  return user;
}

async function home(ctx) {
  await ensureUser(ctx);
  return ctx.reply(
    '🏠 Main Menu\n\nManage your connected Telegram accounts, one-time private-DM auto replies, opt-in notifications and referrals.',
    mainMenu(ctx)
  );
}

async function answer(ctx) {
  try { await ctx.answerCbQuery(); } catch {}
}

async function showAutoReply(ctx) {
  const account = await Account.findOne({
    ownerId: idOf(ctx)
  }).sort({ connectedAt: -1 }).lean();

  if (!account) return ctx.reply('❌ Add a Telegram account first.');

  return ctx.reply(
    `💬 Auto Reply\n\nAccount: ${account.phone}\nStatus: ${account.autoReply ? 'ON' : 'OFF'}\n\nReply: ${account.replyText || '(not configured)'}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✏️ Set Text', 'replytext'),
        Markup.button.callback(
          account.autoReply ? '⏹ Disable' : '▶️ Enable',
          'toggleReply'
        )
      ],
      [
        Markup.button.callback('🗑 Delete Reply', 'delreply'),
        Markup.button.callback('⬅️ Main Menu', 'back')
      ]
    ])
  );
}

async function runBroadcast(message) {
  const delay = Math.max(35, Number(process.env.BROADCAST_DELAY_MS || 40));
  const users = User.find({
    subscribed: true,
    blocked: false
  }).select('telegramId').lean().cursor();

  let sent = 0;
  let failed = 0;

  for await (const user of users) {
    try {
      await bot.telegram.sendMessage(user.telegramId, message);
      sent += 1;
    } catch (error) {
      failed += 1;

      const code = error?.response?.error_code;
      const blocked = code === 403 || /blocked|chat not found/i.test(error?.message || '');

      if (blocked) {
        await User.updateOne(
          { telegramId: user.telegramId },
          { $set: { blocked: true, subscribed: false } }
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  return { sent, failed };
}

bot.catch((error, ctx) => {
  logger.error('Unhandled bot error', {
    updateId: ctx?.update?.update_id,
    error: safeError(error)
  });
});

bot.start(async (ctx) => {
  const payload = ctx.startPayload || '';
  const referrer = payload.startsWith('ref_') ? payload.slice(4) : '';
  await ensureUser(ctx, referrer);
  await home(ctx);
});

bot.command('menu', home);

bot.command('subscribe', async (ctx) => {
  await ensureUser(ctx);
  await User.updateOne(
    { telegramId: idOf(ctx) },
    { $set: { subscribed: true, blocked: false } }
  );
  await ctx.reply('✅ Opt-in notifications enabled. Use /unsubscribe any time to stop them.');
});

bot.command('unsubscribe', async (ctx) => {
  await User.updateOne(
    { telegramId: idOf(ctx) },
    { $set: { subscribed: false } }
  );
  await ctx.reply('✅ Opt-in notifications disabled.');
});

bot.command('cancel', async (ctx) => {
  await cancelLogin(idOf(ctx));
  clearState(idOf(ctx));
  await ctx.reply('❌ Current operation cancelled.');
});

bot.action('back', async (ctx) => {
  await answer(ctx);
  await home(ctx);
});

bot.action('help', async (ctx) => {
  await answer(ctx);
  await ctx.reply(
    '📖 How to Use\n\n' +
    '1. Add your own Telegram account.\n' +
    '2. Complete OTP and optional 2-step verification.\n' +
    '3. Configure Auto Reply.\n' +
    '4. Each private sender receives the configured reply at most once per connected account.\n' +
    '5. Use /subscribe only if you want opt-in broadcasts.\n' +
    '6. Use /unsubscribe to stop them.'
  );
});

bot.action('add', async (ctx) => {
  await answer(ctx);
  setState(ctx.from.id, { action: 'phone' });
  await ctx.reply(
    '📱 Send your own Telegram phone number in international format.\n\n' +
    'Example: +919876543210\n\n/cancel to stop.'
  );
});

bot.action('autoreply', async (ctx) => {
  await answer(ctx);
  await showAutoReply(ctx);
});

bot.action('replytext', async (ctx) => {
  await answer(ctx);
  setState(ctx.from.id, { action: 'replytext' });
  await ctx.reply(
    '✉️ Send the exact auto-reply text. Maximum 4096 characters.\n\n' +
    'It will be sent only once per private sender.'
  );
});

bot.action('toggleReply', async (ctx) => {
  await answer(ctx);

  const account = await Account.findOne({
    ownerId: idOf(ctx)
  }).sort({ connectedAt: -1 });

  if (!account) return ctx.reply('❌ No connected account.');
  if (!account.replyText) return ctx.reply('❌ Set the reply text first.');

  const enabled = !account.autoReply;
  await setAutoReply(account._id, enabled);
  await ctx.reply(`✅ Auto Reply ${enabled ? 'enabled' : 'disabled'}.`);
});

bot.action('delreply', async (ctx) => {
  await answer(ctx);

  const account = await Account.findOne({
    ownerId: idOf(ctx)
  }).sort({ connectedAt: -1 });

  if (!account) return ctx.reply('❌ No connected account.');

  await setAutoReply(account._id, false, '');
  await ctx.reply('🗑 Auto Reply deleted and disabled.');
});

bot.action('account', async (ctx) => {
  await answer(ctx);

  const accounts = await Account.find({
    ownerId: idOf(ctx)
  }).sort({ connectedAt: -1 }).lean();

  if (!accounts.length) return ctx.reply('👤 No connected accounts yet.');

  const text = accounts.map((account, index) =>
    `${index + 1}. ${account.phone}\n   Status: ${account.status} | Auto Reply: ${account.autoReply ? 'ON' : 'OFF'}`
  ).join('\n\n');

  await ctx.reply(`👤 Connected Accounts\n\n${text}`, mainMenu(ctx));
});

bot.action('remove', async (ctx) => {
  await answer(ctx);

  const accounts = await Account.find({
    ownerId: idOf(ctx)
  }).sort({ connectedAt: -1 }).lean();

  if (!accounts.length) return ctx.reply('No connected accounts to remove.');

  const buttons = accounts.map((account) => [
    Markup.button.callback(`🗑 ${account.phone}`, `remove:${account._id}`)
  ]);

  buttons.push([Markup.button.callback('⬅️ Back', 'back')]);
  await ctx.reply('Select the account to remove:', Markup.inlineKeyboard(buttons));
});

bot.action(/^remove:(.+)$/, async (ctx) => {
  await answer(ctx);

  const account = await Account.findOne({
    _id: ctx.match[1],
    ownerId: idOf(ctx)
  });

  if (!account) return ctx.reply('❌ Account not found.');

  await removeAccount(account._id);
  await ctx.reply('✅ Account removed. Stored session and reply history were removed.');
});

bot.action('stats', async (ctx) => {
  await answer(ctx);

  const user = await User.findOne({
    telegramId: idOf(ctx)
  }).lean();

  const accounts = await Account.countDocuments({
    ownerId: idOf(ctx)
  });

  await ctx.reply(
    `📈 My Stats\n\n👥 Referrals: ${user?.referrals || 0}\n📱 Connected accounts: ${accounts}\n🔔 Opt-in status: ${user?.subscribed ? 'ON' : 'OFF'}`,
    mainMenu(ctx)
  );
});

bot.action('refer', async (ctx) => {
  await answer(ctx);

  const user = await User.findOne({
    telegramId: idOf(ctx)
  });

  if (!user) return ctx.reply('❌ User profile not found. Use /start first.');

  const percent = await getSetting('referral_percent', 10);
  const username =
    process.env.BOT_USERNAME?.replace(/^@/, '') ||
    ctx.botInfo?.username ||
    '';

  if (!username) return ctx.reply('❌ BOT_USERNAME is not configured.');

  await ctx.reply(
    `🔗 Refer & Earn\n\nYour referral link:\nhttps://t.me/${username}?start=ref_${user.telegramId}\n\nReferral rate: ${percent}%\nReferrals: ${user.referrals}\n\nThe rate is a configuration value; monetary credit is recorded only when a real qualifying event is implemented.`,
    mainMenu(ctx)
  );
});

bot.action('promo', async (ctx) => {
  await answer(ctx);
  setState(ctx.from.id, { action: 'promo' });
  await ctx.reply(
    '📢 Send the channel username or invite link you want to format. ' +
    'This tool does not perform unsolicited bulk promotion.'
  );
});

bot.action('vip', async (ctx) => {
  await answer(ctx);
  await ctx.reply(
    '⭐ VIP Premium\n\nPremium entitlement is reserved for a real billing integration. ' +
    'This build does not create fake payment or premium state.'
  );
});

bot.action('redeem', async (ctx) => {
  await answer(ctx);
  setState(ctx.from.id, { action: 'redeem' });
  await ctx.reply(
    '🎟 Send a redeem code. No credit is applied until an admin-backed redeem system is configured.'
  );
});

bot.action('broadcast', async (ctx) => {
  await answer(ctx);
  if (!isAdmin(ctx)) return ctx.reply('❌ Admin access required.');

  setState(ctx.from.id, { action: 'broadcast' });
  await ctx.reply(
    '📣 Send the broadcast text. It will be sent only to users who explicitly enabled /subscribe. /cancel to stop.'
  );
});

bot.action('admin', async (ctx) => {
  await answer(ctx);
  if (!isAdmin(ctx)) return ctx.reply('❌ Admin access required.');

  const users = await User.countDocuments();
  const optedIn = await User.countDocuments({ subscribed: true, blocked: false });
  const accounts = await Account.countDocuments();

  await ctx.reply(
    `⚙️ Admin\n\nUsers: ${users}\nOpt-in recipients: ${optedIn}\nAccount records: ${accounts}\nReferral rate: ${await getSetting('referral_percent', 10)}%\n\n/setref 10 — change referral display rate`
  );
});

bot.command('setref', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('❌ Admin access required.');

  const value = Number(String(ctx.message.text).split(/\s+/)[1]);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return ctx.reply('Usage: /setref 10  (0-100)');
  }

  await setSetting('referral_percent', Math.round(value * 100) / 100);
  await ctx.reply(`✅ Referral rate set to ${value}%.`);
});

bot.on('text', async (ctx) => {
  const userId = idOf(ctx);
  const current = getState(userId);
  if (!current) return;

  try {
    const text = String(ctx.message.text || '').trim();

    if (current.action === 'phone') {
      const login = await beginLogin(userId, text);
      setState(userId, { action: 'login_wait' });

      login.promise.then(async () => {
        clearState(userId);
        await ctx.reply('✅ Telegram account connected successfully.');
      }).catch(async (error) => {
        clearState(userId);
        await ctx.reply(`❌ Telegram login failed: ${error.message}`);
      });

      await ctx.reply('📨 OTP request sent. Send the Telegram login code here.');
      return;
    }

    if (current.action === 'login_wait') {
      const login = getPending(userId);

      if (!login) {
        return ctx.reply('⏳ Login is finishing or has expired. Check your account list.');
      }

      if (login.code) {
        await submitCode(userId, text);

        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const updated = getPending(userId);
          if (!updated) break;
          if (updated.password) {
            return ctx.reply('🔐 Telegram requires your 2-step verification password. Send it now.');
          }
        }

        return ctx.reply('✅ OTP submitted. Please wait for Telegram to finish the login.');
      }

      if (login.password) {
        await submitPassword(userId, text);
        return ctx.reply('🔐 2-step password submitted. Please wait for Telegram to finish the login.');
      }

      return ctx.reply('⏳ Telegram is processing the login. Please wait.');
    }

    if (current.action === 'replytext') {
      const account = await Account.findOne({
        ownerId: userId
      }).sort({ connectedAt: -1 });

      if (!account) throw new Error('No connected account.');

      await setAutoReply(account._id, account.autoReply, text);
      clearState(userId);
      await ctx.reply('✅ Auto Reply text saved.');
      return;
    }

    if (current.action === 'promo') {
      clearState(userId);
      await ctx.reply(
        `📢 Channel Promo\n\n${text}\n\nUse this as a formatted reference. No unsolicited bulk messages are sent.`
      );
      return;
    }

    if (current.action === 'redeem') {
      clearState(userId);
      await ctx.reply(
        '🎟 Code received. No redemption was applied because a real admin-backed code table is not enabled.'
      );
      return;
    }

    if (current.action === 'broadcast') {
      clearState(userId);

      if (!isAdmin(ctx)) throw new Error('Admin access required.');
      if (!text) throw new Error('Broadcast text cannot be empty.');
      if (text.length > 4096) throw new Error('Broadcast text cannot exceed 4096 characters.');

      await ctx.reply('⏳ Sending only to opted-in recipients. This may take a while.');
      const result = await runBroadcast(text);

      await ctx.reply(
        `✅ Broadcast finished.\n\nSent: ${result.sent}\nFailed: ${result.failed}`
      );
    }
  } catch (error) {
    clearState(userId);
    logger.error('Text handler failed', {
      userId,
      error: safeError(error)
    });
    await ctx.reply(`❌ ${error.message || 'Something went wrong.'}`);
  }
});

export async function launchBot() {
  await bot.launch();
  logger.info('Telegram bot started', {
    username: bot.botInfo?.username || null
  });
}

export async function stopBot(reason = 'shutdown') {
  try { bot.stop(reason); } catch {}
}

export { bot };
