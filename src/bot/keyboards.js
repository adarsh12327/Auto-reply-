import { Markup } from 'telegraf';

export const safeTelegramText = value => String(value ?? '').replace(/[\uD800-\uDFFF]/g, '�').slice(0, 64);
const cb = (text, data) => Markup.button.callback(safeTelegramText(text), safeTelegramText(data));

export const mainKeyboard = () => Markup.inlineKeyboard([
  [cb('📨 Start Mass DM', 'feature_dm'), cb('👥 Group Message', 'feature_group')],
  [cb('🤖 Set Auto Reply', 'feature_autoreply'), cb('📢 Set Ads', 'feature_ads')],
  [cb('📋 Ads Logs', 'feature_ads_logs'), cb('💬 Set Message', 'feature_messages')],
  [cb('👁️ Preview Message', 'feature_preview'), cb('📊 My Stats', 'feature_stats')],
  [cb('👤 My Account', 'feature_account'), cb('⭐ Go VIP Premium', 'feature_premium')],
  [cb('🎁 Redeem Code', 'feature_redeem'), cb('➕ Add Account', 'add_account')],
  [cb('➖ Remove Account', 'feature_remove_account'), cb('⏳ Accept Pending', 'feature_pending')],
  [cb('📩 Join Request DM', 'feature_join_request'), cb('👥 Refer & Earn', 'feature_referral')],
  [cb('📖 How to Use', 'feature_howto'), cb('🆘 Support', 'feature_support')],
  [cb('🤖 Create Your Own Bot', 'feature_create_bot')]
]);

export const joinRequiredKeyboard = url => Markup.inlineKeyboard([
  ...(url ? [[Markup.button.url('📢 Join Required Channel', url)]] : []),
  [cb('✅ I Joined — Verify', 'verify_join')]
]);

export const accountPickerKeyboard = (accounts, selected = [], doneAction = 'account_picker_done', prefix = 'account_pick') => {
  const set = new Set(selected.map(String));
  const rows = accounts.map(a => {
    const id = String(a._id);
    const mark = set.has(id) ? '☑️' : '☐';
    const name = a.phoneMasked || a.username || 'Telegram Account';
    return [cb(mark + ' ' + name, prefix + ':' + id)];
  });
  rows.push([
    cb('☑️ Select All', prefix + '_all'),
    cb('🧹 Clear', prefix + '_clear')
  ]);
  rows.push([cb('▶️ Continue', doneAction)]);
  rows.push([cb('⬅️ Back', 'main_menu')]);
  return Markup.inlineKeyboard(rows);
};

export const accountManageKeyboard = accounts => {
  const rows = accounts.map(a => [
    cb((a.status === 'connected' ? '🟢 ' : '⚪ ') + (a.phoneMasked || 'Account'), 'account_manage:' + a._id)
  ]);
  rows.push([cb('➕ Add Account', 'add_account')]);
  rows.push([cb('⬅️ Dashboard', 'main_menu')]);
  return Markup.inlineKeyboard(rows);
};

export const accountConfirmRemoveKeyboard = id => Markup.inlineKeyboard([
  [cb('⚠️ Yes, Remove', 'account_remove_confirm:' + id)],
  [cb('❌ Cancel', 'feature_account')]
]);

export const simpleBackKeyboard = (action = 'main_menu') => Markup.inlineKeyboard([
  [cb('⬅️ Back', action)]
]);

export const confirmKeyboard = (yes, no = 'main_menu') => Markup.inlineKeyboard([
  [cb('✅ Confirm', yes)],
  [cb('❌ Cancel', no)]
]);

export const featureHomeKeyboard = (feature) => Markup.inlineKeyboard([
  [cb('➕ Create', feature + '_create')],
  [cb('📜 History', feature + '_history')],
  [cb('⬅️ Dashboard', 'main_menu')]
]);

export const templateKeyboard = templates => {
  const rows = templates.map(t => [
    cb((t.active ? '🟢 ' : '⚪ ') + t.name, 'template_open:' + t._id)
  ]);
  rows.push([cb('➕ New Message', 'template_new')]);
  rows.push([cb('⬅️ Dashboard', 'main_menu')]);
  return Markup.inlineKeyboard(rows);
};

export const templateManageKeyboard = id => Markup.inlineKeyboard([
  [cb('✏️ Edit', 'template_edit:' + id), cb('👁️ Preview', 'template_preview:' + id)],
  [cb('🟢 Set Active', 'template_active:' + id)],
  [cb('🗑️ Delete', 'template_delete:' + id)],
  [cb('⬅️ My Messages', 'feature_messages')]
]);

export const groupKeyboard = () => Markup.inlineKeyboard([
  [cb('🔄 Refresh Groups', 'group_refresh')],
  [cb('☑️ Select Groups', 'group_select')],
  [cb('📨 New Group Campaign', 'group_new')],
  [cb('⏰ Auto Start', 'group_autostart')],
  [cb('📜 Campaign History', 'group_history')],
  [cb('⬅️ Dashboard', 'main_menu')]
]);

export const campaignControlKeyboard = id => Markup.inlineKeyboard([
  [cb('⏸️ Pause', 'campaign_pause:' + id), cb('🛑 Stop', 'campaign_stop:' + id)],
  [cb('▶️ Resume', 'campaign_resume:' + id)],
  [cb('⬅️ Dashboard', 'main_menu')]
]);

export const messageInputKeyboard = back => Markup.inlineKeyboard([
  [cb('❌ Cancel', back)]
]);

export const adKeyboard = () => Markup.inlineKeyboard([
  [cb('➕ Create Ad', 'ad_create')],
  [cb('📋 My Ads', 'feature_ads_logs')],
  [cb('⬅️ Dashboard', 'main_menu')]
]);

export const adminKeyboard = () => Markup.inlineKeyboard([
  [cb('📊 Dashboard', 'admin_dashboard')],
  [cb('👥 Users', 'admin_users'), cb('👤 Accounts', 'admin_accounts')],
  [cb('📨 Campaigns', 'admin_campaigns'), cb('📢 Ads', 'admin_ads')],
  [cb('💳 Payments', 'admin_payments'), cb('💰 Wallet', 'admin_wallet')],
  [cb('🎁 Redeem', 'admin_redeem'), cb('👥 Referral', 'admin_referral')],
  [cb('⚙️ Settings', 'admin_settings'), cb('🛠️ Maintenance', 'admin_maintenance')],
  [cb('🚫 Ban/Unban', 'admin_ban'), cb('📝 Logs', 'admin_logs')],
  [cb('🆘 Support', 'admin_support'), cb('📖 How To Use', 'admin_howto')],
  [cb('🤖 Create Bot', 'admin_create_bot')],
  [cb('⬅️ Dashboard', 'main_menu')]
]);

export const paginationKeyboard = (prefix, page, totalPages, back = 'main_menu') => {
  const row = [];
  if (page > 0) row.push(cb('◀️', prefix + ':' + (page - 1)));
  row.push(cb((page + 1) + '/' + totalPages, prefix + ':' + page));
  if (page < totalPages - 1) row.push(cb('▶️', prefix + ':' + (page + 1)));
  return Markup.inlineKeyboard([row, [cb('⬅️ Back', back)]]);
};

// QR login controls used by the protected Telegram account login handler.
// Keep the callback names stable because account.js relies on them.
export const qrLoginKeyboard = accountId => Markup.inlineKeyboard([
  [cb('🔄 Check QR Login', 'account_qr_check:' + accountId)],
  [cb('❌ Cancel Login', 'account_qr_cancel:' + accountId)]
]);
