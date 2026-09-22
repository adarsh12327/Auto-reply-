import { Account } from '../db.js';
import { encryptText, decryptText } from '../crypto.js';
import { mainKeyboard, qrLoginKeyboard } from '../bot/keyboards.js';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import QRCode from 'qrcode';
import { createUserClient, attachAutoReply } from '../services/telegramClient.js';

const pending = new Map();

export function cancelPendingLogin(userId) {
  pending.delete(Number(userId));
}

function maskPhone(phone) {
  const normalized = String(phone || '').replace(/[^\d+]/g, '');
  if (!normalized) return 'Telegram Account';
  return normalized.replace(/^(\+?\d{2})\d+(\d{3})$/, '$1••••$2');
}

function telegramErrorText(error) {
  return String(error?.errorMessage || error?.message || error || '').toUpperCase();
}

async function deleteMessage(ctx) {
  try {
    await ctx.deleteMessage();
  } catch {}
}

function accountFields() {
  return '+apiHashEncrypted +phoneEncrypted +sessionEncrypted +loginPhoneCodeHashEncrypted +loginQrTokenEncrypted';
}

async function createPendingLoginClient(account, config) {
  const apiHash = decryptText(account.apiHashEncrypted, config.encryptionKey);
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
  return { client, apiHash };
}

async function saveSession(account, client, encryptionKey) {
  account.sessionEncrypted = encryptText(client.session.save(), encryptionKey);
}

async function exportQrChallenge(account, config) {
  const { client, apiHash } = await createPendingLoginClient(account, config);

  try {
    const result = await client.invoke(new Api.auth.ExportLoginToken({
      apiId: Number(account.apiId),
      apiHash,
      exceptIds: []
    }));

    if (!(result instanceof Api.auth.LoginToken)) {
      throw new Error('Telegram did not return a QR login token.');
    }

    const tokenUrl = 'tg://login?token=' + Buffer.from(result.token).toString('base64url');
    const image = await QRCode.toBuffer(tokenUrl, {
      width: 560,
      margin: 2,
      errorCorrectionLevel: 'M'
    });

    await saveSession(account, client, config.encryptionKey);
    account.loginQrTokenEncrypted = encryptText(
      Buffer.from(result.token).toString('base64'),
      config.encryptionKey
    );
    account.loginQrExpiresAt = new Date(Number(result.expires) * 1000);
    account.loginStep = 'qr';
    account.status = 'pending';
    account.loginCodeSendingAt = null;
    account.loginCodeVerifyingAt = null;
    account.lastError = '';
    await account.save();

    return {
      image,
      expiresAt: account.loginQrExpiresAt
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function completeQrAuthorization(account, client, config, authorization) {
  const user = authorization?.user || authorization;
  if (!user?.id) throw new Error('Telegram QR login did not return an authorized user.');

  account.telegramUserId = Number(user.id);

  if (user.phone) {
    const phone = String(user.phone).startsWith('+')
      ? String(user.phone)
      : '+' + String(user.phone);
    account.phoneEncrypted = encryptText(phone, config.encryptionKey);
    account.phoneMasked = maskPhone(phone);
  }

  account.status = 'connected';
  account.connectedAt = new Date();
  account.lastSeenAt = new Date();
  account.lastError = '';
  account.loginStep = null;
  account.loginPhoneCodeHashEncrypted = undefined;
  account.loginQrTokenEncrypted = undefined;
  account.loginQrExpiresAt = null;

  await saveSession(account, client, config.encryptionKey);
  await account.save();
}

async function checkQrLogin(account, config, password = null) {
  const { client, apiHash } = await createPendingLoginClient(account, config);

  try {
    if (password !== null) {
      const me = await client.signInWithPassword(
        { apiId: account.apiId, apiHash },
        { password }
      );
      await completeQrAuthorization(account, client, config, me);
      return { connected: true };
    }

    let result;
    try {
      result = await client.invoke(new Api.auth.ExportLoginToken({
        apiId: Number(account.apiId),
        apiHash,
        exceptIds: []
      }));
    } catch (error) {
      if (
        error?.errorMessage === 'SESSION_PASSWORD_NEEDED' ||
        /SESSION_PASSWORD_NEEDED|password is needed|2-step|two-step/i.test(String(error?.message || ''))
      ) {
        await saveSession(account, client, config.encryptionKey);
        account.loginStep = 'password';
        account.loginQrTokenEncrypted = undefined;
        account.loginQrExpiresAt = null;
        account.loginCodeVerifyingAt = null;
        await account.save();
        return { passwordRequired: true };
      }
      throw error;
    }

    if (
      result instanceof Api.auth.LoginTokenSuccess &&
      result.authorization instanceof Api.auth.Authorization
    ) {
      await completeQrAuthorization(account, client, config, result.authorization);
      return { connected: true };
    }

    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      await client._switchDC(result.dcId);

      const migrated = await client.invoke(new Api.auth.ImportLoginToken({
        token: result.token
      }));

      if (
        migrated instanceof Api.auth.LoginTokenSuccess &&
        migrated.authorization instanceof Api.auth.Authorization
      ) {
        await completeQrAuthorization(account, client, config, migrated.authorization);
        return { connected: true };
      }

      throw new Error('Telegram QR login could not complete after the data-center switch.');
    }

    if (result instanceof Api.auth.LoginToken) {
      const tokenUrl = 'tg://login?token=' + Buffer.from(result.token).toString('base64url');
      const image = await QRCode.toBuffer(tokenUrl, {
        width: 560,
        margin: 2,
        errorCorrectionLevel: 'M'
      });

      await saveSession(account, client, config.encryptionKey);
      account.loginQrTokenEncrypted = encryptText(
        Buffer.from(result.token).toString('base64'),
        config.encryptionKey
      );
      account.loginQrExpiresAt = new Date(Number(result.expires) * 1000);
      account.loginStep = 'qr';
      account.status = 'pending';
      await account.save();

      return {
        connected: false,
        refreshed: true,
        image,
        expiresAt: account.loginQrExpiresAt
      };
    }

    throw new Error('Unexpected Telegram QR login response.');
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function startQrLogin(account, config) {
  account.status = 'pending';
  account.loginStep = 'qr';
  account.lastError = '';
  account.loginCodeSendingAt = null;
  account.loginCodeVerifyingAt = null;
  await account.save();

  return exportQrChallenge(account, config);
}

async function finishPasswordLogin(account, config, password) {
  return checkQrLogin(account, config, password);
}

async function sendQrMessage(ctx, challenge, accountId, prefix = '') {
  const expires = Math.max(
    1,
    Math.ceil((new Date(challenge.expiresAt).getTime() - Date.now()) / 1000)
  );

  const caption =
    (prefix ? prefix + '\n\n' : '') +
    '🔐 Telegram QR Login\n\n' +
    '1. Open Telegram on a device where this account is already logged in.\n' +
    '2. Go to Settings → Devices → Link Desktop Device.\n' +
    '3. Scan the QR code above and confirm the login.\n\n' +
    '⏳ QR expires in about ' + expires + 's.\n' +
    'After scanning, tap “🔄 Check QR Login”.\n\n' +
    '⚠️ No Telegram login code is requested or sent through this bot.';

  return ctx.replyWithPhoto(
    { source: challenge.image, filename: 'telegram-login-qr.png' },
    { caption, ...qrLoginKeyboard(accountId) }
  );
}

export function registerAccountHandlers(bot, config) {
  bot.command('cancel', async ctx => {
    const account = await Account.findOne({
      ownerId: ctx.from.id,
      status: 'pending',
      loginStep: { $in: ['qr', 'password'] }
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
            loginQrExpiresAt: null,
            loginQrTokenEncrypted: null
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
      '1/2 Send your Telegram API ID.\n' +
      'Get it from my.telegram.org → API development tools.\n\n' +
      'After the API Hash, the bot will show a Telegram QR code.\n' +
      'You will NOT need to send a Telegram login code to this bot.\n\n' +
      '/cancel to stop.'
    );
  });

  bot.action(/^account_qr_cancel:(.+)$/, async ctx => {
    await ctx.answerCbQuery();
    const account = await Account.findOne({
      _id: ctx.match[1],
      ownerId: ctx.from.id,
      status: 'pending'
    });

    if (account) {
      account.status = 'error';
      account.loginStep = null;
      account.loginQrExpiresAt = null;
      account.loginQrTokenEncrypted = undefined;
      account.lastError = 'Login cancelled';
      await account.save();
    }

    pending.delete(ctx.from.id);
    await ctx.editMessageText('❌ Telegram account login cancelled.', mainKeyboard());
  });

  bot.action(/^account_qr_check:(.+)$/, async ctx => {
    await ctx.answerCbQuery('Checking Telegram login...');

    const account = await Account.findOne({
      _id: ctx.match[1],
      ownerId: ctx.from.id,
      status: 'pending'
    }).select(accountFields());

    if (!account) {
      await ctx.reply('❌ Login session not found. Please start Add Account again.', mainKeyboard());
      return;
    }

    try {
      const result = await checkQrLogin(account, config);

      if (result.connected) {
        const stored = await Account.findById(account._id)
          .select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted');
        const client = await createUserClient({
          account: stored,
          encryptionKey: config.encryptionKey
        });
        await attachAutoReply(stored, client);

        pending.delete(ctx.from.id);
        await ctx.reply('✅ Telegram account connected successfully!', mainKeyboard());
        return;
      }

      if (result.passwordRequired) {
        pending.set(ctx.from.id, { step: 'password', accountId: account._id });
        await ctx.reply(
          '🔑 QR scan accepted. Your Telegram account has 2-step verification enabled.\n\n' +
          'Send the 2FA password here. /cancel to stop.'
        );
        return;
      }

      if (result.refreshed) {
        try {
          await ctx.deleteMessage();
        } catch {}
        await sendQrMessage(
          ctx,
          result,
          account._id,
          '🔄 The previous QR was not completed yet, so Telegram issued a fresh QR.'
        );
      }
    } catch (error) {
      const text = telegramErrorText(error);

      if (text.includes('AUTH_TOKEN_EXPIRED') || text.includes('AUTH_TOKEN_INVALID')) {
        const challenge = await exportQrChallenge(account, config);
        try { await ctx.deleteMessage(); } catch {}
        await sendQrMessage(ctx, challenge, account._id, '🔄 QR expired. Here is a fresh QR.');
        return;
      }

      account.lastError = error.message || String(error);
      await account.save();
      await ctx.reply('❌ Telegram QR login failed: ' + (error.message || String(error)), mainKeyboard());
    }
  });

  bot.on('text', async (ctx, next) => {
    let state = pending.get(ctx.from.id);
    const text = ctx.message.text.trim();

    if (!state) {
      const account = await Account.findOne({
        ownerId: ctx.from.id,
        status: 'pending',
        loginStep: { $in: ['qr', 'password'] }
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
      const account = state.accountId
        ? await Account.findOne({ _id: state.accountId, ownerId: ctx.from.id, status: 'pending' })
        : null;

      if (account) {
        account.status = 'error';
        account.loginStep = null;
        account.loginQrExpiresAt = null;
        account.loginQrTokenEncrypted = undefined;
        account.lastError = 'Login cancelled';
        await account.save();
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
      await ctx.reply(
        '2/2 Send your Telegram API Hash.\n\n' +
        'It will be encrypted before being stored.\n\n' +
        '/cancel to stop.'
      );
      return;
    }

    if (state.step === 'api_hash') {
      await deleteMessage(ctx);

      if (!/^[A-Za-z0-9_-]{20,}$/.test(text)) {
        await ctx.reply('❌ That API Hash does not look valid. Please copy it exactly from my.telegram.org.');
        return;
      }

      let account;
      try {
        const temporaryPhone = 'QR-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);

        account = await Account.create({
          ownerId: ctx.from.id,
          phoneMasked: temporaryPhone,
          apiId: state.apiId,
          apiHashEncrypted: encryptText(text, config.encryptionKey),
          status: 'pending',
          loginStep: 'qr'
        });

        const challenge = await startQrLogin(account, config);
        pending.set(ctx.from.id, { step: 'qr', accountId: account._id });
        await sendQrMessage(ctx, challenge, account._id);
      } catch (error) {
        if (account) {
          account.status = 'error';
          account.loginStep = null;
          account.loginQrTokenEncrypted = undefined;
          account.loginQrExpiresAt = null;
          account.lastError = error.message || String(error);
          await account.save().catch(() => {});
        }

        pending.delete(ctx.from.id);
        await ctx.reply(
          '❌ Could not start Telegram QR login: ' + (error.message || String(error)),
          mainKeyboard()
        );
      }
      return;
    }

    if (state.step === 'qr') {
      await ctx.reply(
        '🔐 QR login is waiting.\n\n' +
        'Scan the QR code with your already logged-in Telegram app, then tap “🔄 Check QR Login”.\n\n' +
        '/cancel to stop.'
      );
      return;
    }

    if (state.step === 'password') {
      await deleteMessage(ctx);

      const account = await Account.findOne({
        _id: state.accountId,
        ownerId: ctx.from.id,
        status: 'pending'
      }).select(accountFields());

      if (!account) {
        pending.delete(ctx.from.id);
        await ctx.reply('❌ Login session not found. Please start Add Account again.', mainKeyboard());
        return;
      }

      try {
        const result = await finishPasswordLogin(account, config, text);

        if (result.connected) {
          const stored = await Account.findById(account._id)
            .select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted');
          const client = await createUserClient({
            account: stored,
            encryptionKey: config.encryptionKey
          });
          await attachAutoReply(stored, client);

          pending.delete(ctx.from.id);
          await ctx.reply('✅ Telegram account connected successfully!', mainKeyboard());
          return;
        }

        await ctx.reply('❌ 2FA password was not accepted. Please enter it again, or /cancel.');
      } catch (error) {
        const textError = telegramErrorText(error);

        account.lastError = error.message || String(error);
        await account.save();

        if (textError.includes('PASSWORD_HASH_INVALID') || textError.includes('PASSWORD_MISSING')) {
          await ctx.reply('❌ 2FA password was not accepted. Please enter it again, or /cancel.');
        } else {
          await ctx.reply('❌ Telegram 2FA login failed: ' + (error.message || String(error)));
        }
      }
      return;
    }
  });
}
