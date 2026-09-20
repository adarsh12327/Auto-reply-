import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Api } from 'telegram';
import { encryptText, decryptText } from '../crypto.js';
import { Account, ReplyLog } from '../db.js';
import { logger } from '../logger.js';

const clients = new Map();

function key(accountId) {
  return String(accountId);
}

export async function createUserClient({ account, apiId, apiHash, encryptionKey, onLoginCode }) {
  const existing = clients.get(key(account._id));
  if (existing) return existing;

  let session = '';
  if (account.sessionEncrypted) session = decryptText(account.sessionEncrypted, encryptionKey);

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5
  });

  await client.connect();

  if (onLoginCode) {
    await client.start({
      phoneNumber: async () => account.phone,
      phoneCode: async () => onLoginCode('code'),
      password: async () => onLoginCode('password'),
      onError: err => logger.error('Telegram login error', { error: err.message })
    });
  }

  account.sessionEncrypted = encryptText(client.session.save(), encryptionKey);
  account.telegramUserId = Number((await client.getMe()).id);
  account.status = 'connected';
  account.connectedAt = new Date();
  account.lastError = '';
  await account.save();

  clients.set(key(account._id), client);
  return client;
}

export async function attachAutoReply(account, client) {
  client.addEventHandler(async event => {
    const message = event.message;
    if (!message?.isPrivate || !account.autoReplyEnabled || !account.autoReplyText) return;

    const peerId = String(message.senderId);
    try {
      await ReplyLog.create({ accountId: account._id, peerId });
    } catch (error) {
      if (error?.code === 11000) return;
      throw error;
    }

    try {
      await client.sendMessage(message.peerId, { message: account.autoReplyText });
    } catch (error) {
      await ReplyLog.deleteOne({ accountId: account._id, peerId });
      throw error;
    }
  }, new NewMessage({ incoming: true }));
}

export async function canPost(client, target) {
  const entity = await client.getEntity(target);
  if (!(entity instanceof Api.Channel)) return true;
  try {
    const permissions = await client.invoke(new Api.channels.GetParticipant({
      channel: entity,
      participant: await client.getMe()
    }));
    const participant = permissions.participant;
    return Boolean(participant?.adminRights?.postMessages || participant?.adminRights?.postStories);
  } catch {
    return false;
  }
}

export async function sendAuthorizedMessage(client, target, message) {
  await client.sendMessage(target, { message });
}

export function getClient(accountId) {
  return clients.get(key(accountId));
}

export async function disconnectAccount(accountId) {
  const client = clients.get(key(accountId));
  if (client) {
    await client.disconnect();
    clients.delete(key(accountId));
  }
}
