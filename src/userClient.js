import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Account, ReplyLog } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import { logger, safeError } from './logger.js';

const clients = new Map();
const handlers = new Map();
const pending = new Map();

const apiId = () => Number(process.env.API_ID);
const apiHash = () => process.env.API_HASH;

function ownerKey(ownerId) { return String(ownerId); }
function accountKey(accountId) { return String(accountId); }

async function claimReply(accountId, peerId) {
  try {
    return await ReplyLog.create({ accountId, peerId });
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

async function attachAutoReply(client, accountId) {
  const key = accountKey(accountId);
  const previous = handlers.get(key);
  if (previous) client.removeEventHandler(previous);

  const handler = async (event) => {
    try {
      if (!event?.message || event.message.out || !event.isPrivate) return;

      const account = await Account.findById(accountId).lean();
      if (!account?.autoReply || !account.replyText) return;

      const senderId = event.message.senderId;
      const peerId = String(senderId?.value ?? senderId ?? '');
      if (!peerId) return;

      // Atomic unique-index claim: concurrent incoming updates cannot reply twice.
      const claim = await claimReply(accountId, peerId);
      if (!claim) return;

      try {
        await client.sendMessage(peerId, { message: account.replyText });
        await Account.updateOne(
          { _id: accountId },
          { $set: { lastSeenAt: new Date(), status: 'connected', lastError: '' } }
        );
      } catch (sendError) {
        // Release the claim when delivery fails so a later message can retry.
        await ReplyLog.deleteOne({ _id: claim._id });
        throw sendError;
      }
    } catch (error) {
      logger.error('Auto-reply handler failed', {
        accountId: String(accountId),
        error: safeError(error)
      });
      await Account.updateOne(
        { _id: accountId },
        { $set: { status: 'error', lastError: String(error?.message || error) } }
      ).catch(() => {});
    }
  };

  client.addEventHandler(handler, new NewMessage({ incoming: true }));
  handlers.set(key, handler);
}

async function connectAccount(account) {
  const client = new TelegramClient(
    new StringSession(decrypt(account.session)),
    apiId(),
    apiHash(),
    { connectionRetries: 5 }
  );

  await client.connect();

  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    throw new Error('Telegram session is no longer authorized');
  }

  clients.set(accountKey(account._id), client);
  await attachAutoReply(client, account._id);

  await Account.updateOne(
    { _id: account._id },
    { $set: { status: 'connected', lastError: '', lastSeenAt: new Date() } }
  );

  return client;
}

export function getPending(ownerId) {
  return pending.get(ownerKey(ownerId));
}

export async function loadAccounts() {
  const accounts = await Account.find({}).select('+session').lean();
  let loaded = 0;

  for (const account of accounts) {
    try {
      await connectAccount(account);
      loaded += 1;
    } catch (error) {
      logger.error('Failed to restore Telegram account', {
        accountId: String(account._id),
        error: safeError(error)
      });
      await Account.updateOne(
        { _id: account._id },
        { $set: { status: 'error', lastError: String(error?.message || error) } }
      ).catch(() => {});
    }
  }

  logger.info('Telegram accounts restored', { total: accounts.length, loaded });
}

export async function beginLogin(ownerId, phone) {
  const key = ownerKey(ownerId);

  if (pending.has(key)) throw new Error('A login is already in progress. Use /cancel first.');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new Error('Use an international phone number such as +919876543210');
  }

  const client = new TelegramClient(
    new StringSession(''),
    apiId(),
    apiHash(),
    { connectionRetries: 5 }
  );

  const state = {
    ownerId: key,
    phone,
    client,
    code: null,
    password: null,
    createdAt: Date.now(),
    promise: null
  };

  pending.set(key, state);

  state.promise = client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => new Promise((resolve, reject) => {
      state.code = { resolve, reject };
    }),
    password: async () => new Promise((resolve, reject) => {
      state.password = { resolve, reject };
    }),
    onError: async (error) => {
      state.lastError = error;
      return false;
    }
  }).then(async () => {
    const session = client.session.save();
    let account = await Account.findOne({ ownerId: key, phone }).select('+session');

    if (!account) account = new Account({ ownerId: key, phone });

    account.session = encrypt(session);
    account.status = 'connected';
    account.lastError = '';
    account.connectedAt = new Date();
    await account.save();

    const id = account._id;
    clients.set(accountKey(id), client);
    await attachAutoReply(client, id);
    pending.delete(key);

    logger.info('Telegram account connected', {
      ownerId: key,
      accountId: String(id)
    });

    return account;
  }).catch(async (error) => {
    pending.delete(key);
    try { await client.disconnect(); } catch {}
    logger.error('Telegram login failed', { ownerId: key, error: safeError(error) });
    throw error;
  });

  return state;
}

export async function submitCode(ownerId, code) {
  const state = pending.get(ownerKey(ownerId));
  if (!state?.code) throw new Error('Telegram is not currently waiting for the OTP code.');

  const value = String(code).trim();
  if (!/^\d{3,8}$/.test(value)) throw new Error('Invalid OTP format.');

  const request = state.code;
  state.code = null;
  request.resolve(value);
}

export async function submitPassword(ownerId, password) {
  const state = pending.get(ownerKey(ownerId));
  if (!state?.password) throw new Error('Telegram is not currently waiting for the 2-step password.');
  if (!String(password)) throw new Error('2-step password cannot be empty.');

  const request = state.password;
  state.password = null;
  request.resolve(String(password));
}

export async function cancelLogin(ownerId) {
  const key = ownerKey(ownerId);
  const state = pending.get(key);
  if (!state) return false;

  try { state.code?.reject(new Error('Login cancelled')); } catch {}
  try { state.password?.reject(new Error('Login cancelled')); } catch {}
  try { await state.client.disconnect(); } catch {}
  pending.delete(key);
  return true;
}

export async function setAutoReply(accountId, enabled, text) {
  const account = await Account.findById(accountId);
  if (!account) throw new Error('Account not found.');

  if (text !== undefined) {
    const value = String(text);
    if (value.length > 4096) throw new Error('Auto-reply text cannot exceed 4096 characters.');
    account.replyText = value;
  }

  account.autoReply = Boolean(enabled);
  await account.save();

  const client = clients.get(accountKey(accountId));
  if (client) await attachAutoReply(client, accountId);

  return account;
}

export async function removeAccount(accountId) {
  const key = accountKey(accountId);
  const client = clients.get(key);

  if (client) {
    try { await client.disconnect(); } catch {}
  }

  clients.delete(key);
  handlers.delete(key);
  await ReplyLog.deleteMany({ accountId });
  await Account.findByIdAndDelete(accountId);
}

export async function shutdownAccounts() {
  for (const [key, client] of clients.entries()) {
    try { await client.disconnect(); }
    catch (error) {
      logger.warn('Telegram client shutdown error', {
        accountId: key,
        error: safeError(error)
      });
    }
  }

  clients.clear();
  handlers.clear();
}
