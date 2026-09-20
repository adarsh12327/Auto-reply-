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

export const dmAudienceKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('➕ Add Recipient', 'dm_recipient_add')],
  [Markup.button.callback('➖ Remove Recipient', 'dm_recipient_remove')],
  [Markup.button.callback('🔄 Refresh', 'dm_audience')],
  [Markup.button.callback('⬅️ Back to Home', 'main_menu')]
]);

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
