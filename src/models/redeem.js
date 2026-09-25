import mongoose from 'mongoose';

const codeSchema = new mongoose.Schema({
  code: { type: String, unique: true, index: true, required: true, uppercase: true, trim: true },
  amount: { type: Number, min: 0, required: true },
  usageLimit: { type: Number, min: 1, default: 1 },
  usageCount: { type: Number, min: 0, default: 0 },
  expiresAt: Date,
  active: { type: Boolean, default: true }
}, { timestamps: true });

const redemptionSchema = new mongoose.Schema({
  codeId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  ownerId: { type: Number, index: true, required: true },
  transactionId: { type: String, unique: true, required: true }
}, { timestamps: true });

redemptionSchema.index({ codeId: 1, ownerId: 1 }, { unique: true });

export const RedeemCode = mongoose.models.RedeemCode || mongoose.model('RedeemCode', codeSchema);
export const RedeemRedemption = mongoose.models.RedeemRedemption || mongoose.model('RedeemRedemption', redemptionSchema);
