import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
  ownerId: { type: Number, index: true, required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, unique: true, index: true, required: true },
  enabled: { type: Boolean, default: false },
  templateId: { type: mongoose.Schema.Types.ObjectId, default: null },
  fallbackText: { type: String, default: '', maxlength: 4096 },
  cooldownMs: { type: Number, default: 60 * 60 * 1000, min: 0 }
}, { timestamps: true });

const eventSchema = new mongoose.Schema({
  ownerId: { type: Number, index: true, required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  senderId: { type: String, required: true },
  repliedAt: { type: Date, default: Date.now }
}, { timestamps: true });

eventSchema.index({ accountId: 1, senderId: 1 }, { unique: true });

export const AutoReplySetting = mongoose.models.AutoReplySetting || mongoose.model('AutoReplySetting', settingsSchema);
export const AutoReplyEvent = mongoose.models.AutoReplyEvent || mongoose.model('AutoReplyEvent', eventSchema);
