import { Account } from '../db.js';
import { ManagedGroup } from '../models/groups.js';
import { ensureAccountClient, listAllGroups, listWritableGroups } from './telegramClient.js';

export async function getOwnedAccounts(ownerId) {
  return Account.find({ ownerId }).sort({ createdAt: -1 }).lean();
}

export async function restoreAccount(accountId, ownerId, encryptionKey) {
  const account = await Account.findOne({ _id: accountId, ownerId });
  if (!account) throw new Error('Account not found.');
  const client = await ensureAccountClient(account._id, encryptionKey);
  return { account, client };
}

export async function restoreSelectedAccounts(ownerId, accountIds, encryptionKey) {
  const ids = [...new Set((accountIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error('Select at least one account.');

  const accounts = await Account.find({
    ownerId,
    _id: { $in: ids },
    status: { $in: ['connected', 'pending'] }
  });

  if (!accounts.length) throw new Error('No selected connected accounts are available.');

  const result = [];
  for (const account of accounts) {
    try {
      const client = await ensureAccountClient(account._id, encryptionKey);
      result.push({ account, client });
    } catch (error) {
      result.push({ account, error });
    }
  }

  const ready = result.filter(x => !x.error);
  if (!ready.length) {
    throw new Error('None of the selected Telegram accounts could be restored.');
  }
  return ready;
}

export async function syncAccountGroups(ownerId, accountId, encryptionKey) {
  const { account, client } = await restoreAccount(accountId, ownerId, encryptionKey);
  const all = await listAllGroups(account._id);
  const writable = await listWritableGroups(account._id);
  const writableIds = new Set(writable.map(x => String(x.id)));
  const now = new Date();

  if (all.length) {
    await ManagedGroup.bulkWrite(
      all.map(group => ({
        updateOne: {
          filter: {
            ownerId,
            accountId: account._id,
            telegramGroupId: String(group.id)
          },
          update: {
            $set: {
              name: group.name || '',
              username: group.username || '',
              type: group.type || 'group',
              membershipStatus: 'member',
              canPost: writableIds.has(String(group.id)),
              lastSyncedAt: now
            }
          },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }

  return ManagedGroup.find({
    ownerId,
    accountId: account._id
  }).sort({ name: 1 }).lean();
}

export async function syncAllAccountGroups(ownerId, encryptionKey) {
  const accounts = await Account.find({ ownerId, status: 'connected' }).lean();
  const results = [];
  for (const account of accounts) {
    try {
      const groups = await syncAccountGroups(ownerId, account._id, encryptionKey);
      results.push({ accountId: account._id, count: groups.length });
    } catch (error) {
      results.push({ accountId: account._id, count: 0, error: error.message });
    }
  }
  return results;
}
