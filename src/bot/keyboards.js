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
  [Markup.button.callback('⬅️ Main Menu', 'main_menu')]
]);
