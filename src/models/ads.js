import mongoose from 'mongoose';

const adSchema = new mongoose.Schema({
  ownerId: { type: Number, index: true, required: true },
  title: { type: String, required: true, maxlength: 120 },
  message: { type: String, required: true, maxlength: 4096 },
  link: { type: String, default: '' },
  targetCount: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 0 },
  earningPercent: { type: Number, required: true, min: 0, max: 100 },
  successful: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  remaining: { type: Number, default: 0 },
  status: { type: String, enum: ['draft', 'awaiting_payment', 'pending_review', 'approved', 'running', 'paused', 'completed', 'rejected', 'cancelled', 'refunding', 'refunded'], default: 'draft' },
  paymentStatus: { type: String, enum: ['unpaid', 'submitted', 'approved', 'rejected', 'refunded'], default: 'unpaid' },
  paymentReference: { type: String, default: '' },
  paymentProofFileId: { type: String, default: '' },
  approvedAt: Date,
  completedAt: Date
}, { timestamps: true });

adSchema.index({ ownerId: 1, createdAt: -1 });

const deliverySchema = new mongoose.Schema({
  adId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  deliveryOwnerId: { type: Number, index: true, required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  targetId: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  earning: { type: Number, default: 0 },
  processedAt: Date,
  error: { type: String, default: '' }
}, { timestamps: true });

deliverySchema.index({ adId: 1, accountId: 1, targetId: 1 }, { unique: true });

export const AdCampaign = mongoose.models.AdCampaign || mongoose.model('AdCampaign', adSchema);
export const AdDelivery = mongoose.models.AdDelivery || mongoose.model('AdDelivery', deliverySchema);
