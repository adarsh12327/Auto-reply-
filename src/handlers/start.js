import { User } from '../db.js';
import { mainKeyboard } from '../bot/keyboards.js';

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
      const updated = await User.findOneAndUpdate(
        {
          telegramId,
          $or: [
            { referrerId: null },
            { referrerId: { $exists: false } }
          ]
        },
        { $set: { referrerId } },
        { new: true }
      );

      if (updated) {
        const referrer = await User.findOne({ telegramId: referrerId }).select('_id').lean();

        if (referrer) {
          await User.updateOne(
            { telegramId: referrerId },
            { $inc: { referrals: 1 } }
          );
        } else {
          await User.updateOne(
            { telegramId },
            { $set: { referrerId: null } }
          );
        }
      }
    }
  }

  await ctx.reply(
    '🚀 TELEGRAM BUSINESS MANAGER\n\nManage your connected Telegram account, customer contacts, auto-replies and campaigns from one professional dashboard.\n\nChoose an option below to get started.',
    mainKeyboard()
  );
}
