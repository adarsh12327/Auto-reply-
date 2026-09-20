import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Api } from 'telegram';
import { encryptText, decryptText } from '../crypto.js';
import { Account, ReplyLog, Consent } from '../db.js';
import { logger } from '../logger.js';

const clients = new Map();
const autoReplyAttached = new Set();
const AUTO_REPLY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function key(accountId) {
  return String(accountId);
}

export async function createUserClient({ account, encryptionKey, onLoginCode }) {
  const id = key(account._id);
  const existing = clients.get(id);

  if (existing && existing.connected) return existing;

  if (existing) {
    try {
      await existing.connect();
      return existing;
    } catch {
      clients.delete(id);
      autoReplyAttached.delete(id);
    }
  }

  if (!account.apiId || !account.apiHashEncrypted) {
    throw new Error('Account API credentials are missing');
  }

  const apiHash = decryptText(account.apiHashEncrypted, encryptionKey);
  const phone = account.phoneEncrypted
    ? decryptText(account.phoneEncrypted, encryptionKey)
    : null;

  if (!phone) throw new Error('Account phone is missing');

  let session = '';
  if (account.sessionEncrypted) {
    session = decryptText(account.sessionEncrypted, encryptionKey);
  }

  const client = new TelegramClient(
    new StringSession(session),
    account.apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  if (!session) {
    if (!onLoginCode) throw new Error('Account is not authenticated');

    await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => onLoginCode('code'),
      password: async () => onLoginCode('password'),
      onError: err => logger.error('Telegram login error', { error: err?.message })
    });
  } else {
    await client.connect();
  }

  const me = await client.getMe();

  account.sessionEncrypted = encryptText(client.session.save(), encryptionKey);
  account.telegramUserId = Number(me.id);
  account.status = 'connected';
  account.connectedAt = account.connectedAt || new Date();
  account.lastError = '';
  account.lastSeenAt = new Date();
  await account.save();

  clients.set(id, client);
  return client;
}

async function claimAutoReplySlot(accountId, peerId) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - AUTO_REPLY_COOLDOWN_MS);

  const claimed = await ReplyLog.findOneAndUpdate(
    {
      accountId,
      peerId,
      $or: [
        { repliedAt: { $lte: cutoff } },
        { repliedAt: { $exists: false } }
      ]
    },
    { $set: { repliedAt: now } },
    { new: true }
  );

  if (claimed) return true;

  try {
    await ReplyLog.create({ accountId, peerId, repliedAt: now });
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

export async function attachAutoReply(account, client) {
  const id = key(account._id);
  if (autoReplyAttached.has(id)) return;

  autoReplyAttached.add(id);

  client.addEventHandler(async event => {
    const message = event.message;
    if (!message?.isPrivate) return;

    const senderId = message.senderId == null ? null : String(message.senderId);
    if (!senderId) return;

    try {
      const sender = await message.getSender();
      if (!(sender instanceof Api.User) || sender.bot || sender.self) return;

      // Reply only when Telegram explicitly reports the sender as offline.
      if (!(sender.status instanceof Api.UserStatusOffline)) return;

      await Consent.findOneAndUpdate(
        { ownerId: account.ownerId, recipientId: senderId },
        {
          $set: {
            active: true,
            source: 'user_reply',
            revokedAt: null
          },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );

      const current = await Account.findById(account._id)
        .select('ownerId status autoReplyEnabled autoReplyText')
        .lean();

      if (
        !current ||
        current.status !== 'connected' ||
        !current.autoReplyEnabled ||
        !current.autoReplyText
      ) {
        return;
      }

      const claimed = await claimAutoReplySlot(account._id, senderId);
      if (!claimed) return;

      try {
        await client.sendMessage(sender, {
          message: current.autoReplyText
        });
      } catch (error) {
        await ReplyLog.deleteOne({
          accountId: account._id,
          peerId: senderId
        }).catch(() => {});

        logger.error('Auto-reply send failed', {
          accountId: id,
          peerId: senderId,
          error: error?.message
        });
      }
    } catch (error) {
      logger.warn('Auto-reply handler failed', {
        accountId: id,
        peerId: senderId,
        error: error?.message
      });
    }
  }, new NewMessage({ incoming: true }));
}

export async function canPost(client, target) {
  const entity = await client.getEntity(target);

  if (!(entity instanceof Api.Channel)) return true;

  try {
    const permissions = await client.invoke(
      new Api.channels.GetParticipant({
        channel: entity,
        participant: await client.getMe()
      })
    );

    const participant = permissions.participant;
    return Boolean(
      participant?.adminRights?.postMessages ||
      participant?.adminRights?.postStories
    );
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

export function isClientConnected(accountId) {
  const client = getClient(accountId);
  return Boolean(client?.connected);
}

export async function disconnectAccount(accountId) {
  const id = key(accountId);
  autoReplyAttached.delete(id);

  const client = clients.get(id);
  if (!client) return;

  try {
    await client.disconnect();
  } finally {
    clients.delete(id);
  }
}


export async function listWritableGroups(accountId) {
  const client = getClient(accountId);
  if (!client?.connected) throw new Error('Telegram account is not connected');

  const groups = [];
  for await (const dialog of client.iterDialogs({})) {
    const entity = dialog.entity;
    if (!entity) continue;

    const isBasicGroup = entity instanceof Api.Chat;
    const isSupergroup = entity instanceof Api.Channel && Boolean(entity.megagroup);
    if (!isBasicGroup && !isSupergroup) continue;

    const target = String(entity.id);
    let allowed = false;
    try {
      allowed = await canPost(client, entity);
    } catch {
      allowed = false;
    }

    if (!allowed) continue;

    groups.push({
      id: target,
      title: String(dialog.title || entity.title || 'Untitled group'),
      username: entity.username ? String(entity.username) : '',
      type: isSupergroup ? 'supergroup' : 'group'
    });
  }

  return groups;
}


export async function listPersonalDialogs(accountId) {
  const client = getClient(accountId);
  if (!client?.connected) throw new Error('Telegram account is not connected');

  const me = await client.getMe();
  const peers = [];

  for await (const dialog of client.iterDialogs({})) {
    const entity = dialog.entity;
    if (!entity || !(entity instanceof Api.User)) continue;
    if (entity.bot || entity.self || String(entity.id) === String(me.id)) continue;

    peers.push({
      id: String(entity.id),
      name: [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim() || 'Unknown',
      username: entity.username ? String(entity.username) : '',
      type: 'personal'
    });
  }

  return peers;
}


export async function listAllGroups(accountId) {
  const client = getClient(accountId);
  if (!client?.connected) throw new Error('Telegram account is not connected');

  const groups = [];
  for await (const dialog of client.iterDialogs({})) {
    const entity = dialog.entity;
    if (!entity) continue;

    const isBasicGroup = entity instanceof Api.Chat;
    const isSupergroup = entity instanceof Api.Channel && Boolean(entity.megagroup);
    if (!isBasicGroup && !isSupergroup) continue;

    groups.push({
      id: String(entity.id),
      name: String(dialog.title || entity.title || 'Untitled group'),
      username: entity.username ? String(entity.username) : '',
      type: 'group'
    });
  }

  return groups;
}
