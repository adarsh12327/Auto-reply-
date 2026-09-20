import { User } from '../db.js';
import { mainKeyboard } from '../bot/keyboards.js';

export async function startHandler(ctx) {
  const telegramId = ctx.from.id;
  const payload = ctx.startPayload || '';

  let user = await User.findOne({ telegramId });

  if (!user) {
    user = await User.create({
      telegramId,
      username: ctx.from.username,
      firstName: ctx.from.first_name
    });
  } else {
    user.username = ctx.from.username;
    user.firstName = ctx.from.first_name;
    user.lastSeenAt = new Date();
    await user.save();
  }

  if (payload.startsWith('ref_') && !user.referrerId) {
    const referrerId = Number(payload.slice(4));

    if (Number.isSafeInteger(referrerId) && referrerId !== telegramId) {
      const referrer = await User.findOne({ telegramId: referrerId });

      if (referrer) {
        user.referrerId = referrerId;
        await user.save();

        await User.updateOne(
          { telegramId: referrerId },
          { $inc: { referrals: 1 } }
        );
      }
    }
  }

  await ctx.reply(
    '👋 Welcome to Telegram Manager.\n\nConnect your own Telegram account and manage authorized automation from one place.',
    mainKeyboard()
  );
}
