import { Account } from '../db.js';
import { encryptText, decryptText } from '../crypto.js';
import { mainKeyboard } from '../bot/keyboards.js';
import { TelegramClient, Api } from 'telegram';
import { createHash, randomBytes } from 'node:crypto';
import { StringSession } from 'telegram/sessions/index.js';
import { createUserClient, attachAutoReply } from '../services/telegramClient.js';

const pending = new Map();

export function cancelPendingLogin(userId) {
  pending.delete(Number(userId));
}

function maskPhone(phone) {
  return phone.replace(/^(\+?\d{2})\d+(\d{3})$/, '$1••••$2');
}

async function deleteMessage(ctx) {
  try {
    await ctx.deleteMessage();
  } catch {
    // Best effort only.
  }
}

async function saveLoginSession(account, client, encryptionKey) {
  account.sessionEncrypted = encryptText(client.session.save(), encryptionKey);
  await account.save();
}

async function createPendingLoginClient(account, config) {
  const apiHash = decryptText(account.apiHashEncrypted, config.encryptionKey);
  const phone = decryptText(account.phoneEncrypted, config.encryptionKey);
  const session = account.sessionEncrypted
    ? decryptText(account.sessionEncrypted, config.encryptionKey)
    : '';

  const client = new TelegramClient(
    new StringSession(session),
    account.apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  await client.connect();
  return { client, apiHash, phone };
}

function createLoginWebToken() {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  return { token, hash, expiresAt: new Date(Date.now() + 10 * 60 * 1000) };
}

function getPublicBaseUrl() {
  const configured = process.env.PUBLIC_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (configured) return configured.startsWith('http') ? configured : 'https://' + configured;
  if (process.env.VERCEL_URL) return 'https://' + process.env.VERCEL_URL;
  return 'http://localhost:3000';
}

export function getLoginCodeUrl(token) {
  return getPublicBaseUrl().replace(/\/$/, '') + '/api/login?token=' + encodeURIComponent(token);
}

export function hashLoginWebToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function telegramErrorText(error) {
  return String(error?.errorMessage || error?.message || error || '').toUpperCase();
}

async function sendLoginCode(account, config, { force = false, forceSMS = false } = {}) {
  const now = Date.now();
  const sentAt = account.loginCodeSentAt ? new Date(account.loginCodeSentAt).getTime() : 0;

  // Telegram webhooks can be retried and Vercel can run two invocations
  // at once. Do not issue a second code for the same login attempt.
  if (
    !force &&
    account.loginPhoneCodeHashEncrypted &&
    sentAt &&
    now - sentAt < 10 * 60 * 1000
  ) {
    return { sent: false, alreadySent: true };
  }

  const staleLock = new Date(now - 60 * 1000);
  const locked = await Account.findOneAndUpdate(
    {
      _id: account._id,
      status: 'pending',
      loginStep: 'code',
      $or: [
        { loginCodeSendingAt: null },
        { loginCodeSendingAt: { $exists: false } },
        { loginCodeSendingAt: { $lt: staleLock } }
      ]
    },
    { $set: { loginCodeSendingAt: new Date() } },
    { new: true }
  ).select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted +loginPhoneCodeHashEncrypted');

  if (!locked) return { sent: false, locked: true };

  let client;
  try {
    const created = await createPendingLoginClient(locked, config);
    client = created.client;

    const result = await client.sendCode(
      { apiId: locked.apiId, apiHash: created.apiHash },
      created.phone,
      forceSMS
    );

    locked.sessionEncrypted = encryptText(client.session.save(), config.encryptionKey);
    locked.loginPhoneCodeHashEncrypted = encryptText(result.phoneCodeHash, config.encryptionKey);
    locked.loginCodeSentAt = new Date();
    locked.loginCodeSendingAt = null;
    locked.loginCodeVerifyingAt = null;
    locked.loginStep = 'code';
    locked.lastError = '';
    await locked.save();

    return { sent: true, isCodeViaApp: Boolean(result.isCodeViaApp) };
  } catch (error) {
    await Account.updateOne(
      { _id: locked._id },
      { $set: { loginCodeSendingAt: null, lastError: error?.message || String(error) } }
    );
    throw error;
  } finally {
    await client?.disconnect().catch(() => {});
  }
}

export async function finishLogin(account, config, code, password = null) {
  const { client, apiHash, phone } = await createPendingLoginClient(account, config);

  try {
    let me;

    if (password !== null) {
      if (typeof client.signInWithPassword !== 'function') {
        throw new Error('This Telegram client version does not support 2-step verification login.');
      }
      me = await client.signInWithPassword(
        { apiId: account.apiId, apiHash },
        { password }
      );
    } else {
      try {
        me = await client.invoke(new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: decryptText(account.loginPhoneCodeHashEncrypted, config.encryptionKey),
          phoneCode: code
        }));
      } catch (error) {
        const message = String(error?.message || error || '');
        if (
          error?.errorMessage === 'SESSION_PASSWORD_NEEDED' ||
          /SESSION_PASSWORD_NEEDED|password is needed|2-step|two-step/i.test(message)
        ) {
          account.loginStep = 'password';
          await saveLoginSession(account, client, config.encryptionKey);
          await client.disconnect().catch(() => {});
          await account.save();
          return { passwordRequired: true };
        }
        throw error;
      }
    }

    const user = me?.user || me;
    if (!user?.id) throw new Error('Telegram login did not return an authorized user.');

    account.telegramUserId = Number(user.id);
    account.status = 'connected';
    account.connectedAt = new Date();
    account.lastError = '';
    account.loginStep = null;
    account.loginPhoneCodeHashEncrypted = undefined;
    account.loginWebTokenHash = null;
    account.loginWebTokenExpiresAt = null;
    await saveLoginSession(account, client, config.encryptionKey);
    await client.disconnect().catch(() => {});
    return { connected: true };
  } catch (error) {
    await client.disconnect().catch(() => {});
    throw error;
  }
}

export function registerAccountHandlers(bot, config) {
  // Handle /cancel as a real Telegram command as well as plain text.
  // This is more reliable when Telegraf receives the update as a command
  // and the serverless invocation has no in-memory pending state.
  bot.command('cancel', async ctx => {
    const account = await Account.findOne({
      ownerId: ctx.from.id,
      status: 'pending',
      loginStep: { $in: ['code', 'password'] }
    }).sort({ updatedAt: -1 });

    if (account) {
      await Account.updateOne(
        { _id: account._id, ownerId: ctx.from.id, status: 'pending' },
        {
          $set: {
            status: 'error',
            lastError: 'Login cancelled',
            loginStep: null,
            loginCodeSendingAt: null,
            loginCodeVerifyingAt: null,
            loginPhoneCodeHashEncrypted: null,
            loginWebTokenHash: null,
            loginWebTokenExpiresAt: null
          }
        }
      );
    }

    pending.delete(ctx.from.id);
    await ctx.reply('❌ Login cancelled.', mainKeyboard());
  });

  bot.action('add_account', async ctx => {
    await ctx.answerCbQuery();
    pending.set(ctx.from.id, { step: 'api_id' });
    await ctx.editMessageText(
      '🔐 Add Telegram Account\n\n' +
      '1/4 Send your Telegram API ID.\n' +
      'Get it from my.telegram.org → API development tools.\n\n' +
      '/cancel to stop.'
    );
  });

  bot.on('text', async (ctx, next) => {
    let state = pending.get(ctx.from.id);
    const text = ctx.message.text.trim();

    // Vercel/serverless invocations do not guarantee that the in-memory
    // pending map survives between Telegram updates. Recover an active
    // login step from MongoDB so the login-code/password message is handled
    // even when the next update reaches a fresh function instance.
    if (!state) {
      const account = await Account.findOne({
        ownerId: ctx.from.id,
        status: 'pending',
        loginStep: { $in: ['code', 'password'] }
      }).sort({ updatedAt: -1 });

      if (account) {
        state = {
          step: account.loginStep,
          accountId: account._id
        };
        pending.set(ctx.from.id, state);
      }
    }

    if (!state) return next();

    if (text === '/cancel') {
      if (state.accountId) {
        await Account.updateOne(
          { _id: state.accountId, ownerId: ctx.from.id, status: 'pending' },
          { $set: { status: 'error', lastError: 'Login cancelled', loginStep: null } }
        );
      }
      pending.delete(ctx.from.id);
      await ctx.reply('❌ Cancelled.', mainKeyboard());
      return;
    }

    if (state.step === 'api_id') {
      await deleteMessage(ctx);
      if (!/^\d+$/.test(text)) {
        await ctx.reply('❌ API ID must contain only numbers. Try again.');
        return;
      }
      pending.set(ctx.from.id, { step: 'api_hash', apiId: Number(text) });
      await ctx.reply('2/4 Send your Telegram API Hash. It will be encrypted before being stored.\n\n/cancel to stop.');
      return;
    }

    if (state.step === 'api_hash') {
      await deleteMessage(ctx);
      if (!/^[A-Za-z0-9_-]{20,}$/.test(text)) {
        await ctx.reply('❌ That API Hash does not look valid. Please copy it exactly from my.telegram.org.');
        return;
      }
      pending.set(ctx.from.id, { step: 'phone', apiId: state.apiId, apiHash: text });
      await ctx.reply('3/4 Send your Telegram phone number in international format.\nExample: +919876543210');
      return;
    }

    if (state.step === 'phone') {
      const phone = text.replace(/[\s()-]/g, '');
      if (!/^\+\d{7,15}$/.test(phone)) {
        await ctx.reply('❌ Send a valid international phone number, e.g. +919876543210.');
        return;
      }

      const data = {
        ownerId: ctx.from.id,
        phoneMasked: maskPhone(phone),
        phoneEncrypted: encryptText(phone, config.encryptionKey),
        apiId: state.apiId,
        apiHashEncrypted: encryptText(state.apiHash, config.encryptionKey),
        status: 'pending',
        loginStep: 'code'
      };

      let account;
      try {
        account = await Account.findOne({
          ownerId: ctx.from.id,
          phoneMasked: data.phoneMasked
        });

        if (account && account.status === 'connected') {
          await ctx.reply('❌ This phone number is already connected. Use Accounts → Logout first.');
          pending.delete(ctx.from.id);
          return;
        }

        if (!account) {
          account = await Account.create(data);
        } else {
          account.phoneEncrypted = data.phoneEncrypted;
          account.apiId = data.apiId;
          account.apiHashEncrypted = data.apiHashEncrypted;
          account.status = 'pending';
          account.loginStep = 'code';
          account.lastError = '';
          await account.save();
        }
      } catch (error) {
        if (error?.code === 11000) {
          await ctx.reply('❌ This phone number is already added to your account.');
          pending.delete(ctx.from.id);
          return;
        }
        throw error;
      }

      try {
        // Keep an already-active challenge intact. This prevents a duplicate
        // Telegram webhook delivery from replacing the newest phone-code hash.
        const sentAt = account.loginCodeSentAt ? new Date(account.loginCodeSentAt).getTime() : 0;
        const challengeActive =
          account.status === 'pending' &&
          (
            Boolean(account.loginCodeSendingAt) ||
            Boolean(account.loginPhoneCodeHashEncrypted && sentAt && Date.now() - sentAt < 10 * 60 * 1000)
          );

        if (!challengeActive) {
          account.loginPhoneCodeHashEncrypted = undefined;
          account.loginCodeSentAt = null;
          account.loginCodeSendingAt = null;
          account.loginStep = 'code';
          await account.save();
        }

        const result = await sendLoginCode(account, config);

        let loginUrl = null;
        if (result.sent || result.alreadySent) {
          const webToken = createLoginWebToken();
          await Account.updateOne(
            { _id: account._id, ownerId: ctx.from.id, status: 'pending' },
            {
              $set: {
                loginWebTokenHash: webToken.hash,
                loginWebTokenExpiresAt: webToken.expiresAt
              }
            }
          );
          loginUrl = getLoginCodeUrl(webToken.token);
        }

        pending.set(ctx.from.id, { step: 'code', accountId: account._id });

        if (result.alreadySent || result.locked) {
          await ctx.reply(
            '4/4 📩 A Telegram login code has already been requested for this login.\n\n' +
            'Check your Telegram service chat and SMS, then use the secure login page to enter the latest code.\n\n' +
            '🔐 Login page: ' + loginUrl + '\n\n/cancel to stop.'
          );
        } else {
          const delivery = result.isCodeViaApp
            ? 'Telegram sent the code to your other logged-in Telegram session.'
            : 'Telegram requested delivery by SMS.';
          await ctx.reply(
            '4/4 📩 Login code requested.\n\n' +
            delivery + '\n\n' +
            'Check Telegram Service Notifications and your SMS.\n' +
            '🔐 Enter the latest code on the secure login page:\n' +
            loginUrl + '\n\n' +
            '⚠️ Do not send the login code in this Telegram chat.\n\n/cancel to stop.'
          );
        }
      } catch (error) {
        account.status = 'error';
        account.loginStep = null;
        account.loginCodeSendingAt = null;
        account.loginCodeVerifyingAt = null;
        account.lastError = error.message;
        await account.save();
        pending.delete(ctx.from.id);
        await ctx.reply(`❌ Could not send Telegram login code: ${error.message}`, mainKeyboard());
      }
      return;
    }

    if (state.step === 'code' || state.step === 'password') {
      await deleteMessage(ctx);

      const account = await Account.findOne({ _id: state.accountId, ownerId: ctx.from.id })
        .select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted +loginPhoneCodeHashEncrypted');

      if (!account) {
        pending.delete(ctx.from.id);
        await ctx.reply('❌ Login session not found. Please add the account again.', mainKeyboard());
        return;
      }

      try {
        if (state.step === 'code') {
          const code = text.replace(/\s+/g, '');
          if (!/^\d{3,8}$/.test(code)) {
            await ctx.reply('❌ Telegram login code must contain only digits. Please send the latest code.');
            return;
          }

          // Telegram/webhook retries can deliver the same OTP update twice.
          // Only one invocation may verify the code or request a replacement.
          const staleVerifyLock = new Date(Date.now() - 60 * 1000);
          const verifyLock = await Account.findOneAndUpdate(
            {
              _id: account._id,
              ownerId: ctx.from.id,
              status: 'pending',
              loginStep: 'code',
              $or: [
                { loginCodeVerifyingAt: null },
                { loginCodeVerifyingAt: { $exists: false } },
                { loginCodeVerifyingAt: { $lt: staleVerifyLock } }
              ]
            },
            { $set: { loginCodeVerifyingAt: new Date() } },
            { new: true }
          ).select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted +loginPhoneCodeHashEncrypted');

          if (!verifyLock) return;

          const result = await finishLogin(verifyLock, config, code);

          if (result.passwordRequired) {
            await Account.updateOne({ _id: account._id }, { $set: { loginCodeVerifyingAt: null } });
            pending.set(ctx.from.id, { step: 'password', accountId: account._id });
            await ctx.reply('🔑 Your Telegram account has 2-step verification enabled. Send the 2FA password:');
            return;
          }
        } else {
          await finishLogin(account, config, null, text);
        }

        const stored = await Account.findById(account._id)
          .select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted');
        const client = await createUserClient({
          account: stored,
          encryptionKey: config.encryptionKey
        });
        await attachAutoReply(stored, client);

        pending.delete(ctx.from.id);
        await ctx.reply('✅ Telegram account connected successfully!', mainKeyboard());
      } catch (error) {
        const errorText = telegramErrorText(error);

        // Do not automatically request another Telegram code after a
        // verification failure. Resending replaces the active challenge and
        // can make a valid code appear as already shared/expired.
        account.loginCodeVerifyingAt = null;
        account.lastError = error.message;
        await account.save();

        if (
          state.step === 'code' &&
          (
            errorText.includes('PHONE_CODE_INVALID') ||
            errorText.includes('PHONE_CODE_EXPIRED') ||
            errorText.includes('PHONE_CODE_HASH_INVALID')
          )
        ) {
          pending.set(ctx.from.id, { step: 'code', accountId: account._id });
          await ctx.reply(
            '❌ That Telegram login code is no longer valid.\n\n' +
            '⚠️ I will not request another code automatically, because that can invalidate the active challenge.\n\n' +
            'Use /cancel, then start Add Account again to request exactly one fresh code.'
          );
          return;
        }

        if (state.step === 'password') {
          await ctx.reply(
            '❌ 2FA password was not accepted.\n\n' +
            'Please enter the correct Telegram 2-step verification password, or /cancel.'
          );
          return;
        }

        await ctx.reply(
          `❌ Telegram login failed: ${error.message}\n\nPlease send the latest code again, or /cancel.`
        );
      }
      return;
    }
  });
}
