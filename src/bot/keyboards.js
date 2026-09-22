import { Markup } from 'telegraf';

export const mainKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('📊 Dashboard', 'stats')],
  [Markup.button.callback('👤 Accounts', 'accounts'), Markup.button.callback('🤖 Auto Reply', 'auto_reply')],
  [Markup.button.callback('📩 DM Campaigns', 'campaign_dm'), Markup.button.callback('👥 Group Promo', 'campaign_group')],
  [Markup.button.callback('🔎 Contact Scanner', 'scan_menu')],
  [Markup.button.callback('📢 Channel Promo', 'campaign_channel')],
  [Markup.button.callback('👥 Refer & Earn', 'referrals'), Markup.button.callback('⭐ Premium', 'premium')],
  [Markup.button.callback('🎁 Redeem Code', 'redeem'), Markup.button.callback('🆘 Support', 'support')]
]);

export const backKeyboard = (action = 'main_menu', label = '⬅️ Back') => Markup.inlineKeyboard([
  [Markup.button.callback(label, action)]
]);

export const autoReplyKeyboard = enabled => Markup.inlineKeyboard([
  [Markup.button.callback('✏️ Edit Reply', 'auto_reply_set'), Markup.button.callback(enabled ? '⏸️ Disable' : '▶️ Enable', enabled ? 'auto_reply_off' : 'auto_reply_on')],
  [Markup.button.callback('🗑️ Clear Reply', 'auto_reply_clear')],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

export const dmMenuKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('✉️ Create Campaign', 'dm_new')],
  [Markup.button.callback('👥 Recipients', 'dm_audience')],
  [Markup.button.callback('🔎 Select from Scanner', 'dm_scanned')],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

export const dmAudienceKeyboard = recipients => {
  const rows = [
    [Markup.button.callback('🔎 Select Scanned Contacts', 'dm_scanned')],
    [Markup.button.callback('🔄 Refresh Authorized', 'dm_audience')]
  ];
  if (Array.isArray(recipients)) {
    for (const recipient of recipients.slice(0, 20)) {
      const id = String(recipient.recipientId);
      rows.push([Markup.button.callback('🗑️ Remove ' + id, 'dm_recipient_remove:' + id)]);
    }
  }
  rows.push([Markup.button.callback('⬅️ DM Campaigns', 'campaign_dm')]);
  return Markup.inlineKeyboard(rows);
};

export const scannedSelectionKeyboard = (campaignId, peers, selectedIds = [], page = 0) => {
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(peers.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const selected = new Set(selectedIds.map(String));
  const pagePeers = peers.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const rows = pagePeers.map(peer => {
    const id = String(peer.peerId);
    const mark = selected.has(id) ? '☑️' : '☐';
    const label = (peer.name || peer.username || 'Customer').slice(0, 24);
    return [Markup.button.callback(mark + ' ' + label, 'dm_pick:' + campaignId + ':' + id)];
  });
  rows.push([
    Markup.button.callback('☑️ Select All', 'dm_pick_all:' + campaignId),
    Markup.button.callback('🧹 Clear', 'dm_pick_clear:' + campaignId)
  ]);
  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback('◀️', 'dm_pick_page:' + campaignId + ':' + (safePage - 1)));
  nav.push(Markup.button.callback((safePage + 1) + '/' + totalPages, 'dm_pick_page:' + campaignId + ':' + safePage));
  if (safePage < totalPages - 1) nav.push(Markup.button.callback('▶️', 'dm_pick_page:' + campaignId + ':' + (safePage + 1)));
  rows.push(nav);
  rows.push([Markup.button.callback('✉️ Continue', 'dm_pick_done:' + campaignId)]);
  rows.push([Markup.button.callback('⬅️ DM Campaigns', 'campaign_dm')]);
  return Markup.inlineKeyboard(rows);
};

export const dmDraftKeyboard = (campaignId, delayMs = 20000) => Markup.inlineKeyboard([
  [Markup.button.callback('👥 Recipients', 'dm_pick_open:' + campaignId)],
  [Markup.button.callback('⏱️ Delay: ' + Math.round(delayMs / 1000) + 's', 'dm_delay_menu:' + campaignId)],
  [Markup.button.callback('✏️ Edit Message', 'dm_edit')],
  [Markup.button.callback('▶️ Review & Send', 'dm_send:' + campaignId)],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

export const dmRunningKeyboard = campaignId => Markup.inlineKeyboard([
  [Markup.button.callback('⏸️ Pause', 'dm_pause:' + campaignId), Markup.button.callback('🛑 Stop', 'dm_stop:' + campaignId)],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

export const dmPausedKeyboard = campaignId => Markup.inlineKeyboard([
  [Markup.button.callback('▶️ Resume', 'dm_resume:' + campaignId), Markup.button.callback('🛑 Stop', 'dm_stop:' + campaignId)],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

export const delayKeyboard = (campaignId, currentMs, backAction = 'main_menu') => {
  const values = [10000, 15000, 20000, 30000, 60000];
  const label = ms => Math.round(ms / 1000) + 's';
  return Markup.inlineKeyboard([
    values.slice(0, 3).map(ms => Markup.button.callback((ms === currentMs ? '✅ ' : '') + label(ms), 'campaign_delay:' + campaignId + ':' + ms)),
    values.slice(3).map(ms => Markup.button.callback((ms === currentMs ? '✅ ' : '') + label(ms), 'campaign_delay:' + campaignId + ':' + ms)),
    [Markup.button.callback('⬅️ Back', backAction)]
  ]);
};

export const groupMenuKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('✉️ New Group Campaign', 'group_new')],
  [Markup.button.callback('🔎 Scan Groups', 'group_scan')],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

export const groupDraftKeyboard = (campaignId, delayMs) => Markup.inlineKeyboard([
  [Markup.button.callback('⏱️ Delay: ' + Math.round(delayMs / 1000) + 's', 'group_delay_menu:' + campaignId)],
  [Markup.button.callback('▶️ Send to Groups', 'group_send:' + campaignId)],
  [Markup.button.callback('✏️ Edit Message', 'group_edit:' + campaignId)],
  [Markup.button.callback('🔎 Scan Groups', 'group_scan')],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

export const groupRunningKeyboard = campaignId => Markup.inlineKeyboard([
  [Markup.button.callback('⏸️ Pause', 'group_pause:' + campaignId), Markup.button.callback('🛑 Stop', 'group_stop:' + campaignId)],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

export const groupPausedKeyboard = campaignId => Markup.inlineKeyboard([
  [Markup.button.callback('▶️ Resume', 'group_resume:' + campaignId), Markup.button.callback('🛑 Stop', 'group_stop:' + campaignId)],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

export const scanMenuKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('👤 Personal Contacts', 'scan_personal')],
  [Markup.button.callback('👥 Groups', 'scan_groups')],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);

export const scanListKeyboard = type => Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Scan Again', type === 'personal' ? 'scan_personal' : 'scan_groups')],
  [Markup.button.callback('📩 Use in DM Campaign', 'dm_scanned')],
  [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
]);
