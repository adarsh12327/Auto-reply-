import { Api } from 'telegram';
import { Account } from '../db.js';
import { AutoReplySetting, AutoReplyEvent } from '../models/autoReply.js';
import { MessageTemplate } from '../models/messages.js';
import { ensureAccountClient } from './telegramClient.js';
import { getBusinessSettings } from './businessSettings.js';
import { logger } from '../logger.js';

function messageId(message) {
  return String(message?.id || '');
}

async function replyTextFor(setting) {
  if (setting.templateId) {
    const template = await MessageTemplate.findOne({ _id: setting.templateId, ownerId: setting.ownerId }).lean();
    if (template?.text) return template.text;
  }
  return setting.fallbackText || '';
}

export async function pollAutoReplies(encryptionKey, maxAccounts = 20) {
  const settings = await AutoReplySetting.find({ enabled: true }).limit(maxAccounts).lean();
  const results = [];

  for (const setting of settings) {
    try {
      const account = await Account.findOne({
        _id: setting.accountId,
        ownerId: setting.ownerId,
        status: 'connected'
      }).select('+sessionEncrypted +apiHashEncrypted +phoneEncrypted');

      if (!account) continue;
      const client = await ensureAccountClient(account._id, encryptionKey);
      const text = await replyTextFor(setting);
      if (!text) continue;

      const now = Date.now();
      for await (const dialog of client.iterDialogs({})) {
        const entity = dialog.entity;
        if (!(entity instanceof Api.User) || entity.bot || entity.self) continue;

        const recent = [];
        for await (const message of client.iterMessages(entity, { limit: 5 })) {
          if (!message?.out) recent.push(message);
        }
        if (!recent.length) continue;

        const incoming = recent[0];
        const incomingId = messageId(incoming);
        if (!incomingId) continue;

        const event = await AutoReplyEvent.findOne({
          accountId: account._id,
          senderId: String(entity.id)
        });

        if (event?.lastMessageId === incomingId) continue;

        const cooldown = Math.min(
          Math.max(0, Number(setting.cooldownMs) || 0),
          Math.max(0, Number((await getBusinessSettings()).maxAutoReplyCooldownMs) || 24 * 60 * 60 * 1000)
        );

        const cooldownActive = event?.repliedAt && now - new Date(event.repliedAt).getTime() < cooldown;

        if (!cooldownActive) {
          await client.sendMessage(entity, { message: text });
          await AutoReplyEvent.findOneAndUpdate(
            { accountId: account._id, senderId: String(entity.id) },
            {
              $set: {
                ownerId: setting.ownerId,
                repliedAt: new Date(),
                lastMessageId: incomingId
              }
            },
            { upsert: true, new: true }
          );
          results.push({ accountId: String(account._id), senderId: String(entity.id), sent: true });
        } else {
          await AutoReplyEvent.findOneAndUpdate(
            { accountId: account._id, senderId: String(entity.id) },
            {
              $set: {
                ownerId: setting.ownerId,
                lastMessageId: incomingId
              }
            },
            { upsert: true, new: true }
          );
        }
      }
    } catch (error) {
      logger.warn('Auto reply poll failed', { accountId: String(setting.accountId), error: error?.message });
      results.push({ accountId: String(setting.accountId), error: error?.message });
    }
  }

  return results;
}
