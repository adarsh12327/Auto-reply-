import { Account } from '../db.js';
import { encryptText, decryptText } from '../crypto.js';
import { mainKeyboard } from '../bot/keyboards.js';
import { createUserClient, attachAutoReply } from '../services/telegramClient.js';

const pending = new Map();

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

function waitForLoginInput(userId, step, prompt) {
  return new Promise((resolve, reject) => {
    pending.set(userId, { step, resolve, reject });
    pending.get(userId).prompt = prompt;
  });
}

export function registerAccountHandlers(bot, config) {
  bot.action('add_account', async ctx => {
    await ctx.answerCbQuery();
    pending.set(ctx.from.id, { step: 'api_id' });
    await ctx.reply(
      '🔐 Add Telegram Account\n\n' +
      '1/4 Send your Telegram API ID.\n' +
      'Get it from my.telegram.org → API development tools.\n\n' +
      '/cancel to stop.'
    );
  });

  bot.on('text', async ctx => {
    const state = pending.get(ctx.from.id);
    if (!state) return;

    const text = ctx.message.text.trim();

    if (text === '/cancel') {
      if (state.reject) state.reject(new Error('Login cancelled by user'));
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
        status: 'pending'
      };

      let account;
      try {
        account = await Account.create(data);
      } catch (error) {
        if (error?.code === 11000) {
          await ctx.reply('❌ This phone number is already added to your account.');
          pending.delete(ctx.from.id);
          return;
        }
        throw error;
      }

      pending.set(ctx.from.id, { step: 'login', accountId: account._id, apiId: state.apiId });

      await ctx.reply('4/4 Connecting… Telegram may send a login code to your account.\nPlease send the code here when I ask.');
      
      try {
        const client = await createUserClient({
          account: await Account.findById(account._id).select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted'),
          encryptionKey: config.encryptionKey,
          onLoginCode: async type => {
            const prompt = type === 'code'
              ? '📩 Enter the Telegram login code you received:'
              : '🔑 Enter your Telegram 2-step verification password:';
            return waitForLoginInput(ctx.from.id, type, prompt).then(async value => {
              await ctx.reply(type === 'code' ? 'Code received. Checking…' : 'Password received. Checking…');
              return value;
            });
          }
        });

        await attachAutoReply(account, client);
        pending.delete(ctx.from.id);
        await ctx.reply('✅ Telegram account connected successfully!', mainKeyboard());
      } catch (error) {
        pending.delete(ctx.from.id);
        account.status = 'error';
        account.lastError = error.message;
        await account.save();
        await ctx.reply(`❌ Telegram login failed: ${error.message}`, mainKeyboard());
      }
      return;
    }

    if (state.step === 'code' || state.step === 'password') {
      await deleteMessage(ctx);
      const resolver = state.resolve;
      pending.delete(ctx.from.id);
      resolver(text);
    }
  });
}
