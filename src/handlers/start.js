import { User } from '../db.js';
import { mainKeyboard, joinRequiredKeyboard } from '../bot/keyboards.js';
import { checkRequiredJoin } from '../services/accessService.js';
import { ensureReferralProfile, rewardReferralIfEligible } from '../services/referralService.js';
import { getBusinessSettings } from '../services/businessSettings.js';

export async function startHandler(ctx) {
  const telegramId = ctx.from.id;
  const payload = ctx.startPayload || '';

  // User persistence, settings and access verification are independent on the
  // normal start path, so run them concurrently instead of serially.
  const userUpdatePromise = User.findOneAndUpdate(
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

  const settingsPromise = getBusinessSettings();
  const accessPromise = checkRequiredJoin(ctx);
  const [settings, access] = await Promise.all([
    settingsPromise,
    accessPromise,
    userUpdatePromise
  ]);

  if (payload.startsWith('ref_')) {
    const referrerId = Number(payload.slice(4));
    if (Number.isSafeInteger(referrerId) && referrerId !== telegramId) {
      await User.updateOne(
        { telegramId, $or: [{ referrerId: null }, { referrerId: { $exists: false } }] },
        { $set: { referrerId } }
      );
    }

    // Referral bookkeeping is only needed for an actual referral start.
    await ensureReferralProfile(telegramId);
    await rewardReferralIfEligible(telegramId, 'start').catch(() => {});
  }

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
