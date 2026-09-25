import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Wallet, WalletTransaction } from '../models/wallet.js';

function transactionId(prefix = 'TX') {
  return prefix + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
}

export async function ensureWallet(ownerId) {
  return Wallet.findOneAndUpdate(
    { ownerId },
    { $setOnInsert: { ownerId, balance: 0 } },
    { upsert: true, new: true }
  );
}

export async function changeWallet({ ownerId, amount, type, reference = '', description = '', transactionId: suppliedId }) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0) throw new Error('Invalid wallet amount.');

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const txId = suppliedId || transactionId(type.toUpperCase());
      if (await WalletTransaction.exists({ transactionId: txId }).session(session)) {
        result = await WalletTransaction.findOne({ transactionId: txId }).session(session);
        return;
      }

      const wallet = await Wallet.findOneAndUpdate(
        { ownerId },
        { $setOnInsert: { ownerId, balance: 0 } },
        { upsert: true, new: true, session }
      );

      const next = Number(wallet.balance || 0) + value;
      if (next < 0) throw new Error('Insufficient wallet balance.');

      wallet.balance = next;
      await wallet.save({ session });

      result = await WalletTransaction.create([{
        transactionId: txId,
        ownerId,
        amount: value,
        type,
        status: 'completed',
        reference,
        description,
        balanceAfter: next
      }], { session }).then(rows => rows[0]);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
