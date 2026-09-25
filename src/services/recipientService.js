import { Api } from 'telegram';
import { BusinessRecipient } from '../models/recipients.js';
import { restoreAccount } from './accountService.js';

export async function syncAuthorizedRecipients(ownerId, accountId, encryptionKey) {
  const { account, client } = await restoreAccount(accountId, ownerId, encryptionKey);
  const me = await client.getMe();
  const now = new Date();
  const rows = [];

  for await (const dialog of client.iterDialogs({})) {
    const entity = dialog.entity;
    if (!(entity instanceof Api.User)) continue;
    if (entity.bot || entity.self || String(entity.id) === String(me.id)) continue;

    let incoming = null;
    for await (const message of client.iterMessages(entity, { limit: 20 })) {
      if (!message?.out) {
        incoming = message;
        break;
      }
    }

    if (!incoming) continue;

    rows.push({
      ownerId,
      accountId: account._id,
      telegramUserId: String(entity.id),
      name: [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim() || 'Unknown',
      username: entity.username ? String(entity.username) : '',
      authorized: true,
      authorizationSource: 'incoming_dm',
      lastIncomingAt: incoming.date ? new Date(incoming.date * 1000) : now,
      lastSyncedAt: now
    });
  }

  if (rows.length) {
    await BusinessRecipient.bulkWrite(
      rows.map(row => ({
        updateOne: {
          filter: { ownerId, accountId: account._id, telegramUserId: row.telegramUserId },
          update: { $set: row },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }

  return BusinessRecipient.find({ ownerId, accountId: account._id, authorized: true }).sort({ lastIncomingAt: -1 }).lean();
}

export async function listAuthorizedRecipients(ownerId, accountIds) {
  return BusinessRecipient.find({
    ownerId,
    accountId: { $in: accountIds },
    authorized: true
  }).sort({ lastIncomingAt: -1 }).lean();
}
