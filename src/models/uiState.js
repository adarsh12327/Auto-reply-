import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  ownerId: { type: Number, index: true, required: true },
  key: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  expiresAt: { type: Date }
}, { timestamps: true });

schema.index({ ownerId: 1, key: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UiState = mongoose.models.UiState || mongoose.model('UiState', schema);
