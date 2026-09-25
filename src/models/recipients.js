import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  ownerId: { type: Number, index: true, required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  telegramUserId: { type: String, required: true },
  name: { type: String, default: '' },
  username: { type: String, default: '' },
  authorized: { type: Boolean, default: false },
  authorizationSource: { type: String, default: '' },
  lastIncomingAt: Date,
  lastSyncedAt: Date
}, { timestamps: true });

schema.index({ ownerId: 1, accountId: 1, telegramUserId: 1 }, { unique: true });
export const BusinessRecipient = mongoose.models.BusinessRecipient || mongoose.model('BusinessRecipient', schema);
