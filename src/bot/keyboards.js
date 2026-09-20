import { Markup } from 'telegraf';

export const mainKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('🤖 Auto Reply', 'auto_reply'), Markup.button.callback('👤 Accounts', 'accounts')],
  [Markup.button.callback('📩 DM Campaign', 'campaign_dm'), Markup.button.callback('👥 Group Promo', 'campaign_group')],
  [Markup.button.callback('📢 Channel Promo', 'campaign_channel')],
  [Markup.button.callback('👥 Refer & Earn', 'referrals'), Markup.button.callback('⭐ Premium', 'premium')],
  [Markup.button.callback('🎁 Redeem Code', 'redeem'), Markup.button.callback('📊 Statistics', 'stats')],
  [Markup.button.callback('➕ Add Account', 'add_account')],
  [Markup.button.callback('🆘 Support', 'support')]
]);

export const backKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
]);

export const autoReplyKeyboard = enabled => Markup.inlineKeyboard([
  [
    Markup.button.callback('✏️ Set Reply', 'auto_reply_set'),
    Markup.button.callback(
      enabled ? '⏸️ Turn OFF' : '▶️ Turn ON',
      enabled ? 'auto_reply_off' : 'auto_reply_on'
    )
  ],
  [Markup.button.callback('🗑️ Clear Reply', 'auto_reply_clear')],
  [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
]);

export const dmMenuKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('✉️ New Message', 'dm_new')],
  [Markup.button.callback('👥 Recipients', 'dm_audience')],
  [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
]);

export const dmAudienceKeyboard = recipients => {
  const rows = [
    [Markup.button.callback('🔎 Auto Scan Authorized', 'dm_scan')],
    [Markup.button.callback('🔄 Refresh', 'dm_audience')]
  ];

  if (Array.isArray(recipients)) {
    for (const recipient of recipients.slice(0, 20)) {
      const id = String(recipient.recipientId);
      rows.push([
        Markup.button.callback(
          '🗑️ Remove ' + id,
          'dm_recipient_remove:' + id
        )
      ]);
    }
  }

  rows.push([Markup.button.callback('⬅️ Back to Home', 'main_menu')]);
  return Markup.inlineKeyboard(rows);
};

export const dmDraftKeyboard = campaignId => Markup.inlineKeyboard([
  [Markup.button.callback('▶️ Send DM', 'dm_send:' + campaignId)],
  [Markup.button.callback('✏️ Edit Message', 'dm_edit')],
  [Markup.button.callback('👥 Recipients', 'dm_audience')],
  [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
]);

export const dmRunningKeyboard = campaignId => Markup.inlineKeyboard([
  [
    Markup.button.callback('⏸️ Pause', 'dm_pause:' + campaignId),
    Markup.button.callback('🛑 Stop', 'dm_stop:' + campaignId)
  ],
  [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
]);

export const dmPausedKeyboard = campaignId => Markup.inlineKeyboard([
  [
    Markup.button.callback('▶️ Resume', 'dm_resume:' + campaignId),
    Markup.button.callback('🛑 Stop', 'dm_stop:' + campaignId)
  ],
  [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
]);


export const delayKeyboard = (campaignId, currentMs, backAction = 'main_menu') => {
  const values = [10000, 15000, 20000, 25000, 30000, 60000];
  const label = ms => `${Math.round(ms / 1000)}s`;
  return Markup.inlineKeyboard([
    values.slice(0, 3).map(ms => Markup.button.callback(
      (ms === currentMs ? '✅ ' : '') + label(ms),
      `campaign_delay:${campaignId}:${ms}`
    )),
    values.slice(3).map(ms => Markup.button.callback(
      (ms === currentMs ? '✅ ' : '') + label(ms),
      `campaign_delay:${campaignId}:${ms}`
    )),
    [Markup.button.callback('⬅️ Back to Home', backAction)]
  ]);
};

export const groupMenuKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('🔎 Scan My Groups', 'group_scan')],
  [Markup.button.callback('✉️ New Group Message', 'group_new')],
  [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
]);

export const groupDraftKeyboard = (campaignId, delayMs) => Markup.inlineKeyboard([
  [Markup.button.callback('⏱️ Delay: ' + Math.round(delayMs / 1000) + 's', `group_delay_menu:${campaignId}`)],
  [Markup.button.callback('▶️ Send to Groups', 'group_send:' + campaignId)],
  [Markup.button.callback('✏️ Edit Message', 'group_edit:' + campaignId)],
  [Markup.button.callback('🔎 Scan Groups', 'group_scan')],
  [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
]);

export const groupRunningKeyboard = campaignId => Markup.inlineKeyboard([
  [
    Markup.button.callback('⏸️ Pause', 'group_pause:' + campaignId),
    Markup.button.callback('🛑 Stop', 'group_stop:' + campaignId)
  ],
  [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
]);

export const groupPausedKeyboard = campaignId => Markup.inlineKeyboard([
  [
    Markup.button.callback('▶️ Resume', 'group_resume:' + campaignId),
    Markup.button.callback('🛑 Stop', 'group_stop:' + campaignId)
  ],
  [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
]);
