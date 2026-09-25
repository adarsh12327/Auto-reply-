import { User, Account } from '../db.js';
import { BusinessCampaign } from '../models/campaigns.js';
import { AdCampaign } from '../models/ads.js';
import { Wallet, WalletTransaction } from '../models/wallet.js';
import { AdminUser } from '../models/admin.js';
import { RedeemCode } from '../models/redeem.js';
import { UiState } from '../models/uiState.js';
import { getBusinessSettings, setBusinessSetting } from '../services/businessSettings.js';
import { changeWallet } from '../services/walletService.js';
import { adminKeyboard, simpleBackKeyboard } from '../bot/keyboards.js';

const stateKey = 'admin_flow';

async function adminRecord(userId) {
  const envOwner = (process.env.ADMIN_IDS || '').split(',').map(x => Number(x)).filter(Boolean);
  if (envOwner.includes(Number(userId))) return { role: 'owner', permissions: ['*'] };
  return AdminUser.findOne({ telegramId: userId, active: true }).lean();
}

function can(role, permission) {
  if (!role) return false;
  if (role.role === 'owner' || role.role === 'super_admin') return true;
  return role.permissions?.includes('*') || role.permissions?.includes(permission);
}

async function adminOnly(ctx, permission = 'dashboard') {
  const record = await adminRecord(ctx.from.id);
  if (!record || !can(record, permission)) {
    await ctx.reply('⛔ Admin access required.');
    return null;
  }
  return record;
}

async function render(ctx, text, keyboard = adminKeyboard()) {
  try {
    await ctx.editMessageText(text, keyboard);
  } catch {
    await ctx.reply(text, keyboard).catch(() => {});
  }
}

export function registerAdminV2Handlers(bot, config) {
  bot.command('admin', async ctx => {
    if (!(await adminOnly(ctx))) return;
    const [users, accounts, campaigns, ads, walletTx] = await Promise.all([
      User.countDocuments(),
      Account.countDocuments({ status: 'connected' }),
      BusinessCampaign.countDocuments(),
      AdCampaign.countDocuments(),
      WalletTransaction.countDocuments()
    ]);
    await ctx.reply(
      '👑 <b>ADMIN COMMAND CENTER</b>\n\n' +
      'Users: ' + users + '\n' +
      'Connected accounts: ' + accounts + '\n' +
      'Campaigns: ' + campaigns + '\n' +
      'Ads: ' + ads + '\n' +
      'Transactions: ' + walletTx,
      { parse_mode: 'HTML', ...adminKeyboard() }
    );
  });

  bot.action('admin_dashboard', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx))) return;
    const [users, accounts, campaigns, ads] = await Promise.all([
      User.countDocuments(),
      Account.countDocuments({ status: 'connected' }),
      BusinessCampaign.countDocuments(),
      AdCampaign.countDocuments()
    ]);
    await render(ctx, '📊 <b>ADMIN DASHBOARD</b>\n\n👥 Users: ' + users + '\n👤 Connected accounts: ' + accounts + '\n📨 Campaigns: ' + campaigns + '\n📢 Ads: ' + ads);
  });

  bot.action('admin_users', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'users'))) return;
    const users = await User.find({}).sort({ lastSeenAt: -1 }).limit(15).lean();
    const body = users.length ? users.map((u,i) => (i+1)+'. '+u.telegramId+' '+(u.username ? '@'+u.username : '')+(u.blocked ? ' 🚫' : '')).join('\n') : 'No users.';
    await render(ctx, '👥 <b>USERS</b>\n\n' + body);
  });

  bot.action('admin_accounts', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'accounts'))) return;
    const accounts = await Account.find({}).sort({ updatedAt: -1 }).limit(15).lean();
    const body = accounts.length ? accounts.map((a,i) => (i+1)+'. owner '+a.ownerId+' · '+a.status+' · '+(a.phoneMasked||'Account')).join('\n') : 'No accounts.';
    await render(ctx, '👤 <b>ACCOUNTS</b>\n\n' + body);
  });

  bot.action('admin_campaigns', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'campaigns'))) return;
    const rows = await BusinessCampaign.find({}).sort({ createdAt: -1 }).limit(15).lean();
    const body = rows.length ? rows.map((c,i) => (i+1)+'. '+c.type+' · '+c.status+' · '+(c.stats?.sent||0)+' sent / '+(c.stats?.failed||0)+' failed').join('\n') : 'No campaigns.';
    await render(ctx, '📨 <b>CAMPAIGNS</b>\n\n' + body);
  });

  bot.action('admin_ads', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'ads'))) return;
    const rows = await AdCampaign.find({}).sort({ createdAt: -1 }).limit(15).lean();
    const body = rows.length ? rows.map((a,i) => (i+1)+'. '+a.title+' · '+a.status+' · ₹'+a.price).join('\\n') : 'No ads.';
    const pending = rows.filter(a => a.status === 'pending_review');
    const buttons = pending.map(a => [
      { text: '✅ Approve ' + a.title.slice(0,18), callback_data: 'admin_ad_approve:' + a._id },
      { text: '❌ Reject', callback_data: 'admin_ad_reject:' + a._id }
    ]);
    await render(ctx, '📢 <b>ADS</b>\\n\\n' + body, buttons.length ? { reply_markup: { inline_keyboard: buttons.concat([[{ text: '⬅️ Admin', callback_data: 'admin_dashboard' }]]) } } : adminKeyboard());
  });

  bot.action(/^admin_ad_approve:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Approving...');
    if (!(await adminOnly(ctx, 'ads'))) return;
    const ad = await AdCampaign.findById(ctx.match[1]);
    if (!ad) return render(ctx, '❌ Ad not found.');
    ad.paymentStatus = 'approved';
    ad.status = 'approved';
    ad.approvedAt = new Date();
    await ad.save();
    await render(ctx, '✅ <b>Ad approved</b>\\n\\n' + ad.title);
  });

  bot.action(/^admin_ad_reject:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Rejecting...');
    if (!(await adminOnly(ctx, 'ads'))) return;
    const ad = await AdCampaign.findById(ctx.match[1]);
    if (!ad) return render(ctx, '❌ Ad not found.');
    ad.paymentStatus = 'rejected';
    ad.status = 'rejected';
    await ad.save();
    await render(ctx, '❌ <b>Ad rejected</b>\\n\\n' + ad.title);
  });

  bot.action('admin_payments', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'payments'))) return;
    const rows = await WalletTransaction.find({ type: 'deposit' }).sort({ createdAt: -1 }).limit(15).lean();
    const body = rows.length ? rows.map((x,i) => (i+1)+'. '+x.ownerId+' · ₹'+x.amount+' · '+x.status+' · '+(x.reference||'no ref')).join('\\n') : 'No deposit transactions.';
    const pending = rows.filter(x => x.status === 'pending');
    const buttons = pending.map(x => [
      { text: '✅ Approve ₹'+x.amount, callback_data: 'admin_deposit_approve:'+x.transactionId },
      { text: '❌ Reject', callback_data: 'admin_deposit_reject:'+x.transactionId }
    ]);
    await render(ctx, '💳 <b>PAYMENTS</b>\\n\\n' + body, buttons.length ? { reply_markup: { inline_keyboard: buttons.concat([[{ text:'⬅️ Admin', callback_data:'admin_dashboard' }]]) } } : adminKeyboard());
  });

  bot.action(/^admin_deposit_approve:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Approving...');
    if (!(await adminOnly(ctx, 'payments'))) return;
    const tx = await WalletTransaction.findOne({ transactionId: ctx.match[1], type: 'deposit', status: 'pending' });
    if (!tx) return render(ctx, '❌ Deposit is not pending.');
    await changeWallet({
      ownerId: tx.ownerId,
      amount: tx.amount,
      type: 'deposit',
      reference: tx.reference,
      description: 'Admin-approved UPI deposit',
      transactionId: 'CREDIT_' + tx.transactionId
    });
    await WalletTransaction.updateOne({ _id: tx._id, status: 'pending' }, { $set: { status: 'approved' } });
    await render(ctx, '✅ <b>Deposit approved</b>\\n\\nUser: '+tx.ownerId+'\\nAmount: ₹'+tx.amount);
  });

  bot.action(/^admin_deposit_reject:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Rejecting...');
    if (!(await adminOnly(ctx, 'payments'))) return;
    const tx = await WalletTransaction.findOneAndUpdate({ transactionId: ctx.match[1], type: 'deposit', status: 'pending' }, { $set: { status: 'rejected' } }, { new: true });
    await render(ctx, tx ? '❌ <b>Deposit rejected</b>\\n\\nUser: '+tx.ownerId : '❌ Deposit is not pending.');
  });

  bot.action('admin_wallet', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'wallet'))) return;
    const rows = await WalletTransaction.find({}).sort({ createdAt: -1 }).limit(15).lean();
    const body = rows.length ? rows.map((x,i) => (i+1)+'. '+x.ownerId+' · '+x.type+' · '+x.amount+' · '+x.status).join('\n') : 'No transactions.';
    await render(ctx, '💰 <b>WALLET TRANSACTIONS</b>\n\n' + body);
  });

  bot.action('admin_settings', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'settings'))) return;
    const s = await getBusinessSettings();
    await render(ctx,
      '⚙️ <b>SETTINGS</b>\n\n' +
      'Free DM: ' + s.freeDmLimit + '\n' +
      'Premium DM: ' + s.premiumDmLimit + '\n' +
      'Max accounts free: ' + s.maxAccountsFree + '\n' +
      'Max accounts premium: ' + s.maxAccountsPremium + '\n' +
      'Campaign delay: ' + Math.round(s.defaultCampaignDelayMs/1000) + 's\\n' +
      'Auto Reply cooldown: ' + Math.round(s.autoReplyCooldownMs/60000) + ' min\\n' +
      'Ad earning: ' + s.adEarningPercent + '%\\n' +
      'Referral reward: ₹' + s.referralReward + '\\n\\n' +
      '<b>Configuration commands</b>\\n' +
      '<code>/setsetting freeDmLimit 20</code>\\n' +
      '<code>/setsetting premiumDmLimit 200</code>\\n' +
      '<code>/setsetting defaultCampaignDelayMs 20000</code>\\n' +
      '<code>/setsetting adEarningPercent 20</code>\\n' +
      '<code>/setsetting referralReward 10</code>\\n' +
      '<code>/setsetting referralCondition start|account_added|campaign|payment</code>\\n' +
      '<code>/setsetting upiId your@upi</code>\\n' +
      '<code>/setsetting howToUrl https://...</code>\\n' +
      '<code>/setsetting supportUrl https://t.me/...</code>\\n' +
      '<code>/setsetting createBotOwner username</code>\\n' +
      '<code>/setsetting createBotMessage your text</code>',
      adminKeyboard()
    );
  });

  bot.action('admin_maintenance', async ctx => {
    await ctx.answerCbQuery();
    const record = await adminOnly(ctx, 'settings');
    if (!record) return;
    const s = await getBusinessSettings();
    await setBusinessSetting('maintenanceMode', !s.maintenanceMode, ctx.from.id);
    await render(ctx, (!s.maintenanceMode ? '🛠️ Maintenance Mode ENABLED' : '✅ Maintenance Mode DISABLED') + '\n\nAdmins retain access.');
  });

  bot.action('admin_ban', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'users'))) return;
    await UiState.findOneAndUpdate(
      { ownerId: ctx.from.id, key: stateKey },
      { $set: { data: { action: 'ban_user' }, expiresAt: new Date(Date.now()+10*60*1000) } },
      { upsert: true }
    );
    await render(ctx, '🚫 <b>BAN USER</b>\n\nSend the Telegram user ID to ban.\n\nUse /cancel to stop.', simpleBackKeyboard('admin_dashboard'));
  });

  bot.action('admin_logs', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'logs'))) return;
    await render(ctx, '📝 <b>SYSTEM LOGS</b>\n\nDetailed runtime logs are stored in Vercel logs. Business audit records are stored in MongoDB.', adminKeyboard());
  });

  bot.action('admin_support', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'support'))) return;
    await render(ctx, '🆘 <b>SUPPORT</b>\n\nSupport ticket routing is reserved for the support-service phase.', adminKeyboard());
  });

  bot.action('admin_howto', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'settings'))) return;
    await render(ctx, '📖 <b>HOW TO USE</b>\n\nConfigure the guide URL through the settings service in the next admin configuration phase.', adminKeyboard());
  });

  bot.action('admin_create_bot', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'settings'))) return;
    await render(ctx, '🤖 <b>CREATE YOUR OWN BOT</b>\n\nThe owner destination and predefined message are admin-configurable through the business settings layer.', adminKeyboard());
  });

  bot.action('admin_redeem', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'redeem'))) return;
    await render(ctx, '🎁 <b>REDEEM MANAGEMENT</b>\n\nRedeem-code CRUD will be connected in the wallet phase.', adminKeyboard());
  });

  bot.action('admin_referral', async ctx => {
    await ctx.answerCbQuery();
    if (!(await adminOnly(ctx, 'referral'))) return;
    const s = await getBusinessSettings();
    await render(ctx, '👥 <b>REFERRAL SETTINGS</b>\n\nReward: ₹'+s.referralReward+'\nCondition: '+s.referralCondition, adminKeyboard());
  });

  bot.command('setsetting', async ctx => {
    const record = await adminOnly(ctx, 'settings');
    if (!record) return;
    const parts = ctx.message.text.trim().split(/\\s+/);
    const key = parts[1];
    const raw = parts.slice(2).join(' ').trim();
    const allowed = new Set([
      'freeDmLimit','premiumDmLimit','maxAccountsFree','maxAccountsPremium','maxGroupsPerCampaign',
      'defaultCampaignDelayMs','autoReplyCooldownMs','maxAutoReplyCooldownMs','adEarningPercent',
      'referralReward','referralCondition','requiredJoinChatId','requiredJoinUrl','howToUrl','supportUrl',
      'createBotOwner','createBotMessage','upiId','paymentInstructions','maintenanceMode',
      'joinRequestEnabled','joinRequestChatId','joinRequestMessage'
    ]);
    if (!allowed.has(key) || !raw) return ctx.reply('Usage: /setsetting KEY VALUE');
    let value = raw;
    if (/^(true|false)$/i.test(raw)) value = raw.toLowerCase() === 'true';
    else if (/^-?\\d+(\\.\\d+)?$/.test(raw)) value = Number(raw);
    await setBusinessSetting(key, value, ctx.from.id);
    await ctx.reply('✅ Setting updated: '+key);
  });

  bot.command('setadprice', async ctx => {
    const record = await adminOnly(ctx, 'settings');
    if (!record) return;
    const [, targetText, priceText] = ctx.message.text.trim().split(/\\s+/);
    const target = Number(targetText), price = Number(priceText);
    if (!Number.isInteger(target) || target < 1 || !Number.isFinite(price) || price < 0) return ctx.reply('Usage: /setadprice TARGET PRICE');
    const s = await getBusinessSettings();
    const tiers = Array.isArray(s.adPricing) ? [...s.adPricing] : [];
    const i = tiers.findIndex(x => Number(x.target) === target);
    if (i >= 0) tiers[i] = { target, price }; else tiers.push({ target, price });
    tiers.sort((a,b) => Number(a.target)-Number(b.target));
    await setBusinessSetting('adPricing', tiers, ctx.from.id);
    await ctx.reply('✅ Ad pricing updated.');
  });

  bot.command('adminadd', async ctx => {
    const record = await adminRecord(ctx.from.id);
    if (!record || !['owner','super_admin'].includes(record.role)) return ctx.reply('⛔ Owner/Super Admin only.');
    const [, idText, role='admin'] = ctx.message.text.trim().split(/\s+/);
    const telegramId = Number(idText);
    if (!Number.isSafeInteger(telegramId) || !['super_admin','admin','support'].includes(role)) {
      return ctx.reply('Usage: /adminadd TELEGRAM_ID super_admin|admin|support');
    }
    await AdminUser.findOneAndUpdate(
      { telegramId },
      { $set: { role, active: true, addedBy: ctx.from.id } },
      { upsert: true }
    );
    await ctx.reply('✅ Admin added: '+telegramId+' ('+role+')');
  });

  bot.command('redeemcreate', async ctx => {
    const record = await adminOnly(ctx, 'redeem');
    if (!record) return;
    const [, code, amountText, limitText='1'] = ctx.message.text.trim().split(/\\s+/);
    const amount = Number(amountText);
    const usageLimit = Number(limitText);
    if (!code || !Number.isFinite(amount) || amount <= 0 || !Number.isInteger(usageLimit) || usageLimit < 1) {
      return ctx.reply('Usage: /redeemcreate CODE AMOUNT [USAGE_LIMIT]');
    }
    await RedeemCode.create({ code: code.toUpperCase(), amount, usageLimit, usageCount: 0, active: true });
    await ctx.reply('✅ Redeem code created.');
  });

  bot.command('redeemdisable', async ctx => {
    const record = await adminOnly(ctx, 'redeem');
    if (!record) return;
    const code = ctx.message.text.replace(/^\/redeemdisable\s*/i,'').trim().toUpperCase();
    if (!code) return ctx.reply('Usage: /redeemdisable CODE');
    await RedeemCode.updateOne({ code }, { $set: { active: false } });
    await ctx.reply('✅ Redeem code disabled.');
  });

  bot.command('unadmin', async ctx => {
    const record = await adminRecord(ctx.from.id);
    if (!record || !['owner','super_admin'].includes(record.role)) return ctx.reply('⛔ Owner/Super Admin only.');
    const id = Number(ctx.message.text.replace(/^\/unadmin\s*/i,'').trim());
    if (!Number.isSafeInteger(id)) return ctx.reply('Usage: /unadmin TELEGRAM_ID');
    await AdminUser.updateOne({ telegramId: id }, { $set: { active: false } });
    await ctx.reply('✅ Admin disabled.');
  });

  bot.on('text', async (ctx, next) => {
    const state = await UiState.findOne({ ownerId: ctx.from.id, key: stateKey, expiresAt: { $gt: new Date() } });
    if (!state) return next();
    if (ctx.message.text.trim() === '/cancel') {
      await UiState.deleteOne({ _id: state._id });
      await ctx.reply('❌ Cancelled.');
      return;
    }
    if (state.data?.action === 'ban_user') {
      const id = Number(ctx.message.text.trim());
      if (!Number.isSafeInteger(id)) return ctx.reply('❌ Invalid Telegram user ID.');
      await User.updateOne({ telegramId: id }, { $set: { blocked: true } });
      await UiState.deleteOne({ _id: state._id });
      await ctx.reply('🚫 User banned: '+id);
      return;
    }
    return next();
  });
}
