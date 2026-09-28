import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Api } from 'telegram';

const { Schema } = mongoose;

const accountSchema = new Schema({
  ownerId: { type: Number, required: true },
  apiId: { type: Number, required: true },
  apiHashEncrypted: { type: String, select: false, required: true },
  phoneEncrypted: { type: String, select: false },
  sessionEncrypted: { type: String, select: false },
  status: { type: String, default: 'pending' }
}, { timestamps: true });

const settingSchema = new Schema({
  ownerId: { type: Number, required: true },
  accountId: { type: Schema.Types.ObjectId, unique: true, required: true },
  enabled: { type: Boolean, default: false },
  templateId: { type: Schema.Types.ObjectId, default: null },
  fallbackText: { type: String, default: '' },
  cooldownMs: { type: Number, default: 60 * 60 * 1000, min: 0 }
}, { timestamps: true });

const eventSchema = new Schema({
  ownerId: { type: Number, required: true },
  accountId: { type: Schema.Types.ObjectId, required: true },
  senderId: { type: String, required: true },
  repliedAt: { type: Date, default: Date.now },
  lastMessageId: { type: String, default: '' }
}, { timestamps: true });

eventSchema.index({ accountId: 1, senderId: 1 }, { unique: true });

const templateSchema = new Schema({
  ownerId: { type: Number, required: true },
  text: { type: String, default: '' }
}, { timestamps: true });

const Account = mongoose.models.AutoReplyWorkerAccount || mongoose.model('AutoReplyWorkerAccount', accountSchema, 'accounts');
const AutoReplySetting = mongoose.models.AutoReplyWorkerSetting || mongoose.model('AutoReplyWorkerSetting', settingSchema, 'autoreplysettings');
const AutoReplyEvent = mongoose.models.AutoReplyWorkerEvent || mongoose.model('AutoReplyWorkerEvent', eventSchema, 'autoreplyevents');
const MessageTemplate = mongoose.models.AutoReplyWorkerTemplate || mongoose.model('AutoReplyWorkerTemplate', templateSchema, 'messagetemplates');

const clients = new Map();
const attached = new Set();

function decryptText(payload) {
  const key = Buffer.from(process.env.SESSION_ENCRYPTION_KEY || '', 'hex');
  if (key.length !== 32) throw new Error('Invalid SESSION_ENCRYPTION_KEY');
  const [version, ivText, tagText, dataText] = String(payload).split('.');
  if (version !== 'v1') throw new Error('Unsupported encrypted session format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataText, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

async function replyText(setting) {
  if (setting.templateId) {
    const template = await MessageTemplate.findOne({
      _id: setting.templateId,
      ownerId: setting.ownerId
    }).lean();
    if (template?.text) return template.text;
  }
  return String(setting.fallbackText || '');
}

async function attachAccount(account) {
  const id = String(account._id);
  const existing = clients.get(id);

  if (existing?.connected) return existing;

  let client = existing;
  if (!client) {
    const session = decryptText(account.sessionEncrypted);
    const apiHash = decryptText(account.apiHashEncrypted);

    client = new TelegramClient(
      new StringSession(session),
      Number(account.apiId),
      apiHash,
      { connectionRetries: 5 }
    );

    await client.connect();
    if (!(await client.checkAuthorization())) {
      throw new Error('Telegram session is no longer authorized');
    }

    clients.set(id, client);
  } else {
    await client.connect();
  }

  if (!attached.has(id)) {
    attached.add(id);

    client.addEventHandler(async event => {
      const message = event.message;
      if (!message || message.out || !event.isPrivate) return;

      try {
        let sender = await message.getSender();
        if (!sender && message.senderId != null) {
          try {
            sender = await client.getEntity(message.senderId);
          } catch {}
        }

        console.log(JSON.stringify({
          level: 'info',
          message: 'Auto Reply incoming DM detected',
          accountId: id,
          senderId: message.senderId == null ? '' : String(message.senderId),
          resolved: Boolean(sender)
        }));

        if (!(sender instanceof Api.User) || sender.bot || sender.self) return;

        const setting = await AutoReplySetting.findOne({
          accountId: account._id,
          ownerId: account.ownerId,
          enabled: true
        }).lean();

        if (!setting) {
          console.log(JSON.stringify({
            level: 'info',
            message: 'Auto Reply skipped: no enabled setting',
            accountId: id
          }));
          return;
        }

        const text = await replyText(setting);
        if (!text) {
          console.log(JSON.stringify({
            level: 'info',
            message: 'Auto Reply skipped: empty reply text',
            accountId: id
          }));
          return;
        }

        const incomingId = String(message.id || '');
        const senderId = String(sender.id);
        if (!incomingId || !senderId) return;

        const now = Date.now();
        const cooldown = Math.max(0, Number(setting.cooldownMs) || 60 * 60 * 1000);
        const cutoff = new Date(now - cooldown);

        // Atomically claim the sender before sending. This prevents multiple
        // concurrent Telegram updates from sending duplicate auto replies.
        let claim;
        try {
          claim = await AutoReplyEvent.findOneAndUpdate(
            {
              accountId: account._id,
              senderId,
              $or: [
                { repliedAt: { $lte: cutoff } },
                { repliedAt: { $exists: false } }
              ]
            },
            {
              $set: {
                ownerId: account.ownerId,
                repliedAt: new Date(now),
                lastMessageId: incomingId
              }
            },
            { upsert: true, new: true }
          );
        } catch (error) {
          if (error?.code === 11000) {
            console.log(JSON.stringify({
              level: 'info',
              message: 'Auto Reply skipped: cooldown already claimed',
              accountId: id,
              senderId
            }));
            return;
          }
          throw error;
        }

        if (!claim) return;

        await client.sendMessage(sender, { message: text });

        console.log(JSON.stringify({
          level: 'info',
          message: 'Instant auto reply sent',
          accountId: id,
          senderId
        }));

        console.log(JSON.stringify({
          level: 'info',
          message: 'Instant auto reply sent',
          accountId: id,
          senderId
        }));
      } catch (error) {
        console.warn(JSON.stringify({
          level: 'warn',
          message: 'Instant auto reply failed',
          accountId: id,
          error: error?.message
        }));
      }
    }, new NewMessage({ incoming: true }));
  }

  return client;
}

async function refreshAccounts() {
  const settings = await AutoReplySetting.find({ enabled: true }).lean();

  for (const setting of settings) {
    try {
      const account = await Account.findOne({
        _id: setting.accountId,
        ownerId: setting.ownerId,
        status: 'connected'
      }).select('+sessionEncrypted +apiHashEncrypted +phoneEncrypted').lean();

      if (!account?.sessionEncrypted || !account.apiHashEncrypted) continue;

      await attachAccount(account);
    } catch (error) {
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'Auto Reply account connection failed',
        accountId: String(setting.accountId),
        error: error?.message
      }));
    }
  }
}

async function shutdown() {
  for (const client of clients.values()) {
    try {
      await client.disconnect();
    } catch {}
  }
  clients.clear();
  attached.clear();
  try {
    await mongoose.disconnect();
  } catch {}
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Missing MONGODB_URI');
  if (!process.env.SESSION_ENCRYPTION_KEY) throw new Error('Missing SESSION_ENCRYPTION_KEY');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(JSON.stringify({
    level: 'info',
    message: 'Instant Auto Reply worker connected'
  }));

  await refreshAccounts();

  setInterval(() => {
    refreshAccounts().catch(error => {
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'Auto Reply refresh failed',
        error: error?.message
      }));
    });
  }, 15000);

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(error => {
  console.error(JSON.stringify({
    level: 'error',
    message: 'Instant Auto Reply worker stopped',
    error: error?.message,
    stack: error?.stack
  }));
  process.exitCode = 1;
});
