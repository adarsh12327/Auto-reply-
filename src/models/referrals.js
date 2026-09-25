import mongoose from 'mongoose';

const referralSchema = new mongoose.Schema({
  ownerId: { type: Number, unique: true, index: true, required: true },
  code: { type: String, unique: true, index: true, required: true },
  referredBy: { type: Number, default: null },
  successfulCount: { type: Number, default: 0 },
  earned: { type: Number, default: 0 }
}, { timestamps: true });

const rewardSchema = new mongoose.Schema({
  transactionId: { type: String, unique: true, required: true },
  referrerId: { type: Number, index: true, required: true },
  referredId: { type: Number, index: true, required: true },
  amount: { type: Number, min: 0, required: true },
  condition: { type: String, required: true },
  status: { type: String, enum: ['pending', 'completed', 'rejected'], default: 'pending' }
}, { timestamps: true });

export const ReferralProfile = mongoose.models.ReferralProfile || mongoose.model('ReferralProfile', referralSchema);
export const ReferralReward = mongoose.models.ReferralReward || mongoose.model('ReferralReward', rewardSchema);
