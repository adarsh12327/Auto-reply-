import mongoose from 'mongoose';
import { logger } from './logger.js';

const { Schema } = mongoose;

const UserSchema = new Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  username: { type: String, default: '', trim: true, maxlength: 64 },
  firstName: { type: String, default: '', trim: true, maxlength: 128 },
  referrerId: { type: String, default: '', index: true },
  referrals: { type: Number, default: 0, min: 0 },
  referralEarned: { type: Number, default: 0, min: 0 },
  subscribed: { type: Boolean, default: false, index: true },
  blocked: { type: Boolean, default: false, index: true },
  lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true, versionKey: false });

const AccountSchema = new Schema({
  ownerId: { type: String, required: true, index: true },
  phone: { type: String, required: true, trim: true },
  session: { type: String, required: true, select: false },
  autoReply: { type: Boolean, default: false, index: true },
  replyText: { type: String, default: '', maxlength: 4096 },
  status: { type: String, enum: ['connected', 'offline', 'error'], default: 'connected' },
  lastError: { type: String, default: '' },
  connectedAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true, versionKey: false });

AccountSchema.index({ ownerId: 1, phone: 1 }, { unique: true });

const ReplyLogSchema = new Schema({
  accountId: { type: Schema.Types.ObjectId, required: true, index: true },
  peerId: { type: String, required: true },
  repliedAt: { type: Date, default: Date.now }
}, { versionKey: false });

ReplyLogSchema.index({ accountId: 1, peerId: 1 }, { unique: true });

const SettingSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Schema.Types.Mixed }
}, { timestamps: true, versionKey: false });

export const User = mongoose.model('User', UserSchema);
export const Account = mongoose.model('Account', AccountSchema);
export const ReplyLog = mongoose.model('ReplyLog', ReplyLogSchema);
export const Setting = mongoose.model('Setting', SettingSchema);

let connected = false;

export async function connectDb(uri) {
  if (connected) return;
  await mongoose.connect(uri, {
    maxPoolSize: 10,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    family: 4,
    autoIndex: true
  });
  connected = true;
  logger.info('MongoDB connected', { host: mongoose.connection.host });
}

export async function closeDb() {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
  logger.info('MongoDB disconnected');
}

export async function getSetting(key, fallback = null) {
  const row = await Setting.findOne({ key }).lean();
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  return Setting.findOneAndUpdate(
    { key },
    { $set: { value } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
}

export async function incrementReferral(referrerId) {
  return User.updateOne({ telegramId: referrerId }, { $inc: { referrals: 1 } });
}
