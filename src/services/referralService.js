import crypto from 'node:crypto';
import { User } from '../db.js';
import { ReferralProfile, ReferralReward } from '../models/referrals.js';
import { changeWallet } from './walletService.js';
import { getBusinessSettings } from './businessSettings.js';

export async function ensureReferralProfile(ownerId) {
  const code = 'REF_' + ownerId + '_' + crypto.createHash('sha1').update(String(ownerId)).digest('hex').slice(0, 8).toUpperCase();
  return ReferralProfile.findOneAndUpdate(
    { ownerId },
    { $setOnInsert: { ownerId, code, successfulCount: 0, earned: 0 } },
    { upsert: true, new: true }
  );
}

export async function rewardReferralIfEligible(referredId, condition) {
  const settings = await getBusinessSettings();
  if (String(settings.referralCondition || 'start') !== String(condition)) return null;

  const referred = await User.findOne({ telegramId: referredId }).lean();
  const referrerId = Number(referred?.referrerId);
  if (!Number.isSafeInteger(referrerId) || referrerId === referredId) return null;

  const amount = Number(settings.referralReward || 0);
  if (!(amount > 0)) return null;

  const transactionId = 'REF_' + condition + '_' + referredId;
  const existing = await ReferralReward.findOne({ transactionId });
  if (existing) return existing;

  const reward = await ReferralReward.create({
    transactionId,
    referrerId,
    referredId,
    amount,
    condition,
    status: 'pending'
  });

  try {
    await changeWallet({
      ownerId: referrerId,
      amount,
      type: 'referral_reward',
      reference: transactionId,
      description: 'Referral reward for user ' + referredId,
      transactionId
    });
    reward.status = 'completed';
    await reward.save();
    await User.updateOne({ telegramId: referrerId }, { $inc: { referrals: 1, referralEarned: amount } });
    await ReferralProfile.findOneAndUpdate({ ownerId: referrerId }, { $inc: { successfulCount: 1, earned: amount } }, { upsert: true });
    return reward;
  } catch (error) {
    await ReferralReward.deleteOne({ _id: reward._id });
    throw error;
  }
}
