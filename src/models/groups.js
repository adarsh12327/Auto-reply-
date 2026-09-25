import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  ownerId: { type: Number, index: true, required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  telegramGroupId: { type: String, required: true },
  name: { type: String, default: '' },
  username: { type: String, default: '' },
  type: { type: String, enum: ['group', 'supergroup', 'channel'], required: true },
  membershipStatus: { type: String, default: 'member' },
  isAdmin: { type: Boolean, default: false },
  canPost: { type: Boolean, default: false },
  lastSyncedAt: Date
}, { timestamps: true });

schema.index({ ownerId: 1, accountId: 1, telegramGroupId: 1 }, { unique: true });
export const ManagedGroup = mongoose.models.ManagedGroup || mongoose.model('ManagedGroup', schema);
