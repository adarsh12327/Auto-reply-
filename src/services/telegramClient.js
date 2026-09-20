import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Api } from 'telegram';
import { encryptText, decryptText } from '../crypto.js';
import { ReplyLog } from '../db.js';
import { logger } from '../logger.js';

const clients = new Map();

function key(accountId) {
  return String(accountId);
}

export async function createUserClient({ account, encryptionKey, onLoginCode }) {
  const existing = clients.get(key(account._id));
  if (existing) return existing;

  if (!account.apiId || !account.apiHashEncrypted) {
    throw new Error('Account API credentials are missing');
  }

  const apiHash = decryptText(account.apiHashEncrypted, encryptionKey);
  const phone = account.phoneEncrypted ? decryptText(account.phoneEncrypted, encryptionKey) : null;
  if (!phone) throw new Error('Account phone is missing');

  let session = '';
  if (account.sessionEncrypted) {
    session = decryptText(account.sessionEncrypted, encryptionKey);
  }

  const client = new TelegramClient(new StringSession(session), account.apiId, apiHash, {
    connectionRetries: 5
  });

  if (!session) {
    if (!onLoginCode) throw new Error('Account is not authenticated');
    await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => onLoginCode('code'),
      password: async () => onLoginCode('password'),
      onError: err => logger.error('Telegram login error', { error: err.message })
    });
  } else {
    await client.connect();
  }

  account.sessionEncrypted = encryptText(client.session.save(), encryptionKey);
  account.telegramUserId = Number((await client.getMe()).id);
  account.status = 'connected';
  account.connectedAt = account.connectedAt || new Date();
  account.lastError = '';
  account.lastSeenAt = new Date();
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
