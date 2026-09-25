import mongoose from 'mongoose';

const campaignSchema = new mongoose.Schema({
  ownerId: { type: Number, index: true, required: true },
  accountIds: [{ type: mongoose.Schema.Types.ObjectId, index: true }],
  type: { type: String, enum: ['dm', 'group'], required: true },
  source: { type: String, default: 'manual' },
  messageTemplateId: { type: mongoose.Schema.Types.ObjectId, default: null },
  message: { type: String, default: '', maxlength: 4096 },
  targetIds: [String],
  delayMs: { type: Number, default: 20000, min: 1000 },
  status: { type: String, enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'], default: 'draft' },
  scheduledAt: Date,
  repeatEveryMs: { type: Number, default: 0, min: 0 },
  endAt: Date,
  timezone: { type: String, default: 'UTC' },
  stats: {
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 }
  },
  currentIndex: { type: Number, default: 0 },
  startedAt: Date,
  completedAt: Date,
  pausedAt: Date,
  lastError: { type: String, default: '' }
}, { timestamps: true });

campaignSchema.index({ ownerId: 1, createdAt: -1 });
campaignSchema.index({ status: 1, scheduledAt: 1 });

const recipientSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  ownerId: { type: Number, index: true, required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  targetId: { type: String, required: true },
  status: { type: String, enum: ['pending', 'sent', 'failed', 'skipped'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: '' },
  sentAt: Date
}, { timestamps: true });

recipientSchema.index({ campaignId: 1, accountId: 1, targetId: 1 }, { unique: true });

export const BusinessCampaign = mongoose.models.BusinessCampaign || mongoose.model('BusinessCampaign', campaignSchema);
export const CampaignRecipient = mongoose.models.CampaignRecipient || mongoose.model('CampaignRecipient', recipientSchema);
