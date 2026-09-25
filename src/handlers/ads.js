import { Markup } from 'telegraf';
import { AdCampaign } from '../models/ads.js';
import { AdParticipant } from '../models/adParticipants.js';
import { UiState } from '../models/uiState.js';
import { getBusinessSettings } from '../services/businessSettings.js';
import { accountPickerKeyboard, simpleBackKeyboard } from '../bot/keyboards.js';
import { Account } from '../db.js';

const key = 'ads_flow';

async function edit(ctx, text, keyboard = simpleBackKeyboard()) {
  try { await ctx.editMessageText(text, keyboard); } catch {}
}

function priceFor(settings, target) {
  const tiers = Array.isArray(settings.adPricing) ? settings.adPricing : [];
  const tier = tiers.find(x => Number(x.target) === Number(target));
  return tier ? Number(tier.price) : null;
}

export function registerAdsHandlers(bot, config) {
  bot.action('feature_ads', async ctx => {
    await ctx.answerCbQuery();
    await edit(ctx,
      '📢 <b>SET ADS</b>\n\nCreate an advertisement, submit payment proof, and wait for manual admin approval.\n\nDelivery is restricted to opt-in eligible participants and authorized recipients.',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Create Ad', 'ad_create')],
        [Markup.button.callback('🤝 Delivery Participation', 'ad_participate')],
        [Markup.button.callback('📋 Ads Logs', 'feature_ads_logs')],
        [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
      ])
    );
  });

  bot.action('ad_create', async ctx => {
    await ctx.answerCbQuery();
    await UiState.findOneAndUpdate(
      { ownerId: ctx.from.id, key },
      { $set: { data: { step: 'title' }, expiresAt: new Date(Date.now()+20*60*1000) } },
      { upsert: true }
    );
    await edit(ctx, '📝 <b>NEW AD</b>\n\nSend the ad title.\n\n/cancel to stop.');
  });

  bot.action('ad_participate', async ctx => {
    await ctx.answerCbQuery();
    const accounts = await Account.find({ ownerId: ctx.from.id, status: 'connected' }).lean();
    if (!accounts.length) return edit(ctx, '❌ Connect a Telegram account first.');
    const rows = accounts.map(a => [Markup.button.callback((a.phoneMasked || 'Account'), 'ad_participate_toggle:' + a._id)]);
    rows.push([Markup.button.callback('⬅️ Back', 'feature_ads')]);
    await edit(ctx, '🤝 <b>AD DELIVERY PARTICIPATION</b>\n\nOpt in only if you agree to deliver eligible ads to authorized recipients from this account.', Markup.inlineKeyboard(rows));
  });

  bot.action(/^ad_participate_toggle:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const account = await Account.findOne({ _id: ctx.match[1], ownerId: ctx.from.id, status: 'connected' }).lean();
    if (!account) return edit(ctx, '❌ Account not found.');
    const current = await AdParticipant.findOne({ ownerId: ctx.from.id, accountId: account._id }).lean();
    await AdParticipant.findOneAndUpdate(
      { ownerId: ctx.from.id, accountId: account._id },
      { $set: { enabled: !current?.enabled, approved: false }, $setOnInsert: { totalSuccessful: 0, totalEarned: 0 } },
      { upsert: true }
    );
    await edit(ctx, '✅ Participation preference saved.\n\nAn admin must approve a delivery participant before paid ad delivery can use the account.', simpleBackKeyboard('feature_ads'));
  });

  bot.action('feature_ads_logs', async ctx => {
    await ctx.answerCbQuery();
    const rows = await AdCampaign.find({ ownerId: ctx.from.id }).sort({ createdAt: -1 }).limit(20).lean();
    const body = rows.length
      ? rows.map((a,i) => (i+1)+'. '+a.title+' · '+a.status+' · ₹'+a.price+' · '+a.successful+'/'+a.targetCount).join('\n')
      : 'No ad campaigns yet.';
    await edit(ctx, '📋 <b>ADS LOGS</b>\n\n' + body);
  });

  bot.on('text', async (ctx, next) => {
    const state = await UiState.findOne({ ownerId: ctx.from.id, key, expiresAt: { $gt: new Date() } });
    if (!state) return next();

    const text = String(ctx.message.text || '').trim();
    if (text === '/cancel') {
      await UiState.deleteOne({ _id: state._id });
      await ctx.reply('❌ Cancelled.');
      return;
    }

    const d = state.data || {};

    if (d.step === 'title') {
      await UiState.updateOne({ _id: state._id }, { $set: { data: { step: 'message', title: text.slice(0,120) } } });
      await ctx.reply('✏️ Send the ad message.');
      return;
    }

    if (d.step === 'message') {
      await UiState.updateOne({ _id: state._id }, { $set: { data: { step: 'target', title: d.title, message: text.slice(0,4096) } } });
      const settings = await getBusinessSettings();
      const buttons = (settings.adPricing || []).map(t => [Markup.button.callback(t.target + ' recipients — ₹' + t.price, 'ad_target:' + t.target)]);
      buttons.push([Markup.button.callback('❌ Cancel', 'feature_ads')]);
      await ctx.reply('🎯 Select the paid target count.', Markup.inlineKeyboard(buttons));
      return;
    }

    if (d.step === 'link') {
      const settings = await getBusinessSettings();
      const target = Number(d.target);
      const price = priceFor(settings, target);
      if (price == null) {
        await UiState.deleteOne({ _id: state._id });
        return ctx.reply('❌ Pricing tier is no longer available.');
      }
      const ad = await AdCampaign.create({
        ownerId: ctx.from.id,
        title: d.title,
        message: d.message,
        link: text === '-' ? '' : text,
        targetCount: target,
        price,
        earningPercent: Number(settings.adEarningPercent || 20),
        remaining: target,
        status: 'awaiting_payment',
        paymentStatus: 'unpaid'
      });
      await UiState.updateOne({ _id: state._id }, { $set: { data: { step: 'payment', adId: String(ad._id) } } });
      await showPayment(ctx, ad._id);
      return;
    }

    if (d.step === 'payment') {
      const ad = await AdCampaign.findOne({ _id: d.adId, ownerId: ctx.from.id });
      if (!ad) return ctx.reply('❌ Ad not found.');
      ad.paymentStatus = 'submitted';
      ad.paymentReference = text.slice(0,200);
      ad.status = 'pending_review';
      await ad.save();
      await UiState.deleteOne({ _id: state._id });
      await ctx.reply('✅ Payment reference submitted.\n\nYour ad is waiting for manual admin verification.', simpleBackKeyboard('feature_ads'));
      return;
    }

    return next();
  });

  bot.action(/^ad_target:([0-9]+)$/, async ctx => {
    await ctx.answerCbQuery();
    const state = await UiState.findOne({ ownerId: ctx.from.id, key });
    if (!state || state.data?.step !== 'target') return edit(ctx, '❌ Ad setup expired.');
    await UiState.updateOne({ _id: state._id }, { $set: { data: { ...state.data, step: 'link', target: Number(ctx.match[1]) } } });
    await edit(ctx, '🔗 <b>AD LINK</b>\n\nSend a URL for the ad, or send <code>-</code> if there is no link.', Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'feature_ads')]]));
  });

  bot.action(/^admin_ad_approve:(.+)$/, async ctx => {
    if (!ctx.state?.isAdmin) return;
    const ad = await AdCampaign.findById(ctx.match[1]);
    if (!ad) return ctx.reply('❌ Ad not found.');
    ad.paymentStatus = 'approved';
    ad.status = 'approved';
    ad.approvedAt = new Date();
    await ad.save();
    await ctx.reply('✅ Ad approved: ' + ad._id);
  });

  bot.on('photo', async (ctx, next) => {
    const state = await UiState.findOne({ ownerId: ctx.from.id, key, expiresAt: { $gt: new Date() } });
    if (!state || state.data?.step !== 'payment') return next();
    const ad = await AdCampaign.findOne({ _id: state.data.adId, ownerId: ctx.from.id });
    if (!ad) return ctx.reply('❌ Ad not found.');
    ad.paymentProofFileId = ctx.message.photo.at(-1).file_id;
    ad.paymentStatus = 'submitted';
    ad.status = 'pending_review';
    await ad.save();
    await UiState.deleteOne({ _id: state._id });
    await ctx.reply('✅ Payment screenshot submitted.\n\nAdmin verification is required before the ad can run.');
  });
}

async function showPayment(ctx, adId) {
  const settings = await getBusinessSettings();
  const ad = await AdCampaign.findById(adId).lean();
  const text =
    '💳 <b>AD PAYMENT</b>\n\n' +
    'Campaign: ' + ad.title + '\n' +
    'Target: ' + ad.targetCount + '\n' +
    'Amount: ₹' + ad.price + '\n\n' +
    'UPI: <code>' + String(settings.upiId || 'Not configured') + '</code>\n' +
    String(settings.paymentInstructions || '') + '\n\n' +
    'Send the transaction ID/reference as text, or send a payment screenshot.';
  await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'feature_ads')]]) });
}
