import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  ownerId: { type: Number, index: true, required: true },
  type: { type: String, required: true },
  title: { type: String, required: true, maxlength: 120 },
  message: { type: String, required: true, maxlength: 4096 },
  readAt: Date
}, { timestamps: true });

schema.index({ ownerId: 1, createdAt: -1 });
export const Notification = mongoose.models.BusinessNotification || mongoose.model('BusinessNotification', schema);
