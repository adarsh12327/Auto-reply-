import { User } from '../db.js';
import { mainKeyboard, joinRequiredKeyboard } from '../bot/keyboards.js';
import { checkRequiredJoin } from '../services/accessService.js';
import { ensureReferralProfile, rewardReferralIfEligible } from '../services/referralService.js';
import { getBusinessSettings } from '../services/businessSettings.js';

export async function startHandler(ctx) {
  const telegramId = ctx.from.id;
  const payload = ctx.startPayload || '';

  await User.findOneAndUpdate(
    { telegramId },
    {
      $set: {
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastSeenAt: new Date()
      },
      $setOnInsert: {
        telegramId,
        subscribed: false,
        blocked: false,
        referrals: 0,
        referralEarned: 0
      }
    },
    { upsert: true }
  );

  if (payload.startsWith('ref_')) {
    const referrerId = Number(payload.slice(4));
    if (Number.isSafeInteger(referrerId) && referrerId !== telegramId) {
      await User.updateOne(
        { telegramId, $or: [{ referrerId: null }, { referrerId: { $exists: false } }] },
        { $set: { referrerId } }
      );
    }
  }

  // Keep the normal /start path lean: referral bookkeeping is only needed
  // when this start message actually contains a referral payload.
  if (payload.startsWith('ref_')) {
    await ensureReferralProfile(telegramId);
    await rewardReferralIfEligible(telegramId, 'start').catch(() => {});
  }

  // These independent checks can run concurrently instead of serially.
  const settingsPromise = getBusinessSettings();
  const accessPromise = checkRequiredJoin(ctx);
  const [settings, access] = await Promise.all([settingsPromise, accessPromise]);
  if (!access.allowed) {
    await ctx.reply(
      '🔐 <b>Join verification required</b>\n\nPlease join the required channel and then tap <b>I Joined — Verify</b>.',
      { parse_mode: 'HTML', ...joinRequiredKeyboard(access.url) }
    );
    return;
  }

  await ctx.reply(
    '🏠 <b>BUSINESS COMMAND CENTER</b>\n\nPromote products, manage Telegram accounts, run authorized campaigns and handle customer automation from one place.\n\n<i>Plan:</i> ' + (settings.maintenanceMode ? 'Maintenance' : 'Active'),
    { parse_mode: 'HTML', ...mainKeyboard() }
  );
}
