import { Account } from '../db.js';
import { encryptText, decryptText } from '../crypto.js';
import { mainKeyboard } from '../bot/keyboards.js';
import { TelegramClient, Api } from 'telegram';
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

async function finishLogin(account, config, code, password = null) {
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
    await saveLoginSession(account, client, config.encryptionKey);
    await client.disconnect().catch(() => {});
    return { connected: true };
  } catch (error) {
    await client.disconnect().catch(() => {});
    throw error;
  }
}

export function registerAccountHandlers(bot, config) {
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
        const apiHash = state.apiHash;
        const client = new TelegramClient(
          new StringSession(''),
          state.apiId,
          apiHash,
          { connectionRetries: 5 }
        );

        await client.connect();
        const result = await client.sendCode(
          { apiId: state.apiId, apiHash },
          phone
        );

        account.sessionEncrypted = encryptText(client.session.save(), config.encryptionKey);
        account.loginPhoneCodeHashEncrypted = encryptText(result.phoneCodeHash, config.encryptionKey);
        account.loginStep = 'code';
        await account.save();
        await client.disconnect().catch(() => {});

        pending.set(ctx.from.id, { step: 'code', accountId: account._id });
        await ctx.reply(
          '4/4 📩 Telegram login code sent.\n\n' +
          'Send the code here. Your code is never stored.\n\n/cancel to stop.'
        );
      } catch (error) {
        account.status = 'error';
        account.loginStep = null;
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
          const result = await finishLogin(account, config, text);

          if (result.passwordRequired) {
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
        account.lastError = error.message;
        await account.save();
        await ctx.reply(`❌ Telegram login failed: ${error.message}\n\nPlease send the correct ${state.step === 'code' ? 'code' : '2FA password'} again, or /cancel.`);
      }
      return;
    }
  });
}
