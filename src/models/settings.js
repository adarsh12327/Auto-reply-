import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  key: { type: String, unique: true, index: true, required: true },
  value: mongoose.Schema.Types.Mixed,
  updatedBy: Number
}, { timestamps: true });

export const BusinessSetting = mongoose.models.BusinessSetting || mongoose.model('BusinessSetting', schema);
