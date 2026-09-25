import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, index: true, required: true },
  role: { type: String, enum: ['owner', 'super_admin', 'admin', 'support'], default: 'admin' },
  permissions: { type: [String], default: [] },
  active: { type: Boolean, default: true },
  addedBy: Number
}, { timestamps: true });

export const AdminUser = mongoose.models.AdminUser || mongoose.model('AdminUser', schema);
