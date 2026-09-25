import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  ownerId: { type: Number, index: true, required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  type: { type: String, enum: ['text', 'photo', 'video', 'document'], default: 'text' },
  text: { type: String, default: '', maxlength: 4096 },
  parseMode: { type: String, enum: ['HTML', 'MarkdownV2', null], default: 'HTML' },
  mediaFileId: { type: String, default: '' },
  link: { type: String, default: '' },
  buttons: { type: mongoose.Schema.Types.Mixed, default: [] },
  active: { type: Boolean, default: false },
  useCount: { type: Number, default: 0 }
}, { timestamps: true });

schema.index({ ownerId: 1, name: 1 }, { unique: true });
export const MessageTemplate = mongoose.models.MessageTemplate || mongoose.model('MessageTemplate', schema);
