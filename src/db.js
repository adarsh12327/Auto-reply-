import mongoose from 'mongoose';

const { Schema } = mongoose;

const userSchema = new Schema({
  telegramId: { type: Number, unique: true, index: true, required: true },
  username: String,
  firstName: String,
  subscribed: { type: Boolean, default: false },
  blocked: { type: Boolean, default: false },
  referrerId: { type: Number, default: null },
  referrals: { type: Number, default: 0 },
  referralEarned: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now }
});

const accountSchema = new Schema({
  ownerId: { type: Number, index: true, required: true },
  telegramUserId: { type: Number, index: true },
  phoneMasked: String,
  phoneEncrypted: { type: String, select: false },
  sessionEncrypted: { type: String, select: false },
  loginPhoneCodeHashEncrypted: { type: String, select: false },
  loginCodeSentAt: { type: Date, default: null },
  loginCodeSendingAt: { type: Date, default: null },
  loginCodeVerifyingAt: { type: Date, default: null },
  loginStep: { type: String, enum: ['code', 'password', null], default: null },
  apiId: { type: Number, required: true },
  apiHashEncrypted: { type: String, select: false, required: true },
  status: { type: String, enum: ['pending', 'connected', 'paused', 'error', 'removed'], default: 'pending' },
  autoReplyEnabled: { type: Boolean, default: false },
  autoReplyText: { type: String, default: '' },
  connectedAt: Date,
  lastError: String,
  lastSeenAt: Date
}, { timestamps: true });
accountSchema.index({ ownerId: 1, phoneMasked: 1 }, { unique: true });

const replyLogSchema = new Schema({
  accountId: { type: Schema.Types.ObjectId, index: true, required: true },
  peerId: { type: String, required: true },
  repliedAt: { type: Date, default: Date.now }
});
replyLogSchema.index({ accountId: 1, peerId: 1 }, { unique: true });

const consentSchema = new Schema({
  ownerId: { type: Number, index: true, required: true },
  recipientId: { type: String, required: true },
  source: { type: String, enum: ['user_added', 'user_reply', 'bot_opt_in', 'group_permission'], required: true },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  revokedAt: Date
});
consentSchema.index({ ownerId: 1, recipientId: 1 }, { unique: true });

const scannedPeerSchema = new Schema({
  ownerId: { type: Number, index: true, required: true },
  accountId: { type: Schema.Types.ObjectId, index: true, required: true },
  peerId: { type: String, required: true },
  type: { type: String, enum: ['personal', 'group'], required: true },
  name: { type: String, default: '' },
  username: { type: String, default: '' },
  lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });
scannedPeerSchema.index({ ownerId: 1, accountId: 1, peerId: 1 }, { unique: true });

const campaignSchema = new Schema({
  ownerId: { type: Number, index: true, required: true },
  accountId: { type: Schema.Types.ObjectId, required: true },
  type: { type: String, enum: ['dm', 'group', 'channel'], required: true },
  targetIds: [String],
  message: { type: String, required: true },
  delayMs: { type: Number, default: 20000, min: 1000 },
  status: { type: String, enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'], default: 'draft' },
  scheduledAt: Date,
  stats: {
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 }
  }
}, { timestamps: true });

const settingSchema = new Schema({
  key: { type: String, unique: true },
  value: Schema.Types.Mixed
});

export const User = mongoose.model('User', userSchema);
export const Account = mongoose.model('Account', accountSchema);
export const ReplyLog = mongoose.model('ReplyLog', replyLogSchema);
export const Consent = mongoose.model('Consent', consentSchema);
export const Campaign = mongoose.model('Campaign', campaignSchema);
export const ScannedPeer = mongoose.model('ScannedPeer', scannedPeerSchema);
export const Setting = mongoose.model('Setting', settingSchema);

export async function connectDb(uri) {
  await mongoose.connect(uri);
}

export async function closeDb() {
  await mongoose.disconnect();
}
