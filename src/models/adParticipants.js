import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  ownerId: { type: Number, index: true, required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, unique: true, index: true, required: true },
  enabled: { type: Boolean, default: false },
  approved: { type: Boolean, default: false },
  totalSuccessful: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 }
}, { timestamps: true });

export const AdParticipant = mongoose.models.AdParticipant || mongoose.model('AdParticipant', schema);
