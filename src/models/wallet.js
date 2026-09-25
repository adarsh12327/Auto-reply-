import mongoose from 'mongoose';

const walletSchema = new mongoose.Schema({
  ownerId: { type: Number, unique: true, index: true, required: true },
  balance: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

const txSchema = new mongoose.Schema({
  transactionId: { type: String, unique: true, index: true, required: true },
  ownerId: { type: Number, index: true, required: true },
  amount: { type: Number, required: true },
  type: { type: String, enum: ['deposit', 'ad_spend', 'redeem', 'referral_reward', 'ad_earning', 'refund', 'admin_credit', 'admin_debit'], required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'completed', 'reversed'], default: 'completed' },
  reference: { type: String, default: '' },
  description: { type: String, default: '' },
  balanceAfter: { type: Number, min: 0, default: 0 }
}, { timestamps: true });

export const Wallet = mongoose.models.BusinessWallet || mongoose.model('BusinessWallet', walletSchema);
export const WalletTransaction = mongoose.models.WalletTransaction || mongoose.model('WalletTransaction', txSchema);
