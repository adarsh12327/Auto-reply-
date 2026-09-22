import { Account } from '../db.js';
import { encryptText, decryptText } from '../crypto.js';
import { mainKeyboard } from '../bot/keyboards.js';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Markup } from 'telegraf';
import { createUserClient, attachAutoReply } from '../services/telegramClient.js';
import { randomBytes, createHash } from 'node:crypto';

const pending = new Map();
const WEB_LOGIN_TTL_MS = 10 * 60 * 1000;

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

function accountFields() {
  return '+apiHashEncrypted +phoneEncrypted +sessionEncrypted +loginPhoneCodeHashEncrypted +loginWebTokenHash';
}

function webTokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function productionWebUrl(token) {
  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    'auto-reply-nine-liart.vercel.app';
  return 'https://' + host + '/api/login?token=' + encodeURIComponent(token);
}

function issueWebToken(account, encryptionKey) {
  const token = randomBytes(32).toString('base64url');
  account.loginWebTokenHash = encryptText(webTokenHash(token), encryptionKey);
  account.loginWebTokenExpiresAt = new Date(Date.now() + WEB_LOGIN_TTL_MS);
  return token;
}

function clearWebToken(account) {
  account.loginWebTokenHash = undefined;
  account.loginWebTokenExpiresAt = null;
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

async function sendLoginCode(account, config, phone) {
  const { client, apiHash } = await createPendingLoginClient(account, config);

  try {
    const result = await client.sendCode(
      { apiId: Number(account.apiId), apiHash },
      phone
    );

    await saveSession(account, client, config.encryptionKey);

    account.phoneEncrypted = encryptText(phone, config.encryptionKey);
    account.phoneMasked = maskPhone(phone);
    account.loginPhoneCodeHashEncrypted = encryptText(
      result.phoneCodeHash,
      config.encryptionKey
    );
    account.loginStep = 'code';
    account.status = 'pending';
    account.loginCodeSentAt = new Date();
    account.loginCodeSendingAt = null;
    account.loginCodeVerifyingAt = null;
    account.lastError = '';
    clearWebToken(account);

    const token = issueWebToken(account, config.encryptionKey);
    await account.save();

    return {
      token,
      isCodeViaApp: Boolean(result.isCodeViaApp),
      expiresAt: account.loginWebTokenExpiresAt
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function completeAuthorization(account, client, config, authorization) {
  const user = authorization?.user || authorization;
  if (!user?.id) throw new Error('Telegram did not return an authorized user.');

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
  account.loginCodeSentAt = null;
  account.loginCodeSendingAt = null;
  account.loginCodeVerifyingAt = null;
  account.loginQrTokenEncrypted = undefined;
  account.loginQrExpiresAt = null;
  clearWebToken(account);

  await saveSession(account, client, config.encryptionKey);
  await account.save();
}

function loginWebKeyboard(url) {
  return Markup.inlineKeyboard([
    [Markup.button.url('🔐 Open Secure Login', url)],
    [Markup.button.callback('❌ Cancel Login', 'account_web_cancel')]
  ]);
}

async function finishWebCodeLogin(account, config, code) {
  const { client, apiHash } = await createPendingLoginClient(account, config);

  try {
    const phone = decryptText(account.phoneEncrypted, config.encryptionKey);
    const phoneCodeHash = decryptText(
      account.loginPhoneCodeHashEncrypted,
      config.encryptionKey
    );

    account.loginCodeVerifyingAt = new Date();
    await account.save();

    try {
      const authorization = await client.invoke(new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code
      }));

      if (authorization instanceof Api.auth.Authorization) {
        await completeAuthorization(account, client, config, authorization);
        return { connected: true };
      }

      throw new Error('Telegram returned an unexpected authorization response.');
    } catch (error) {
      const text = telegramErrorText(error);

      if (text.includes('SESSION_PASSWORD_NEEDED')) {
        account.loginStep = 'password';
        account.lastError = '';
        account.loginCodeVerifyingAt = null;
        await account.save();
        return { passwordRequired: true };
      }

      throw error;
    }
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function finishWebPasswordLogin(account, config, password) {
  const { client, apiHash } = await createPendingLoginClient(account, config);

  try {
    const user = await client.signInWithPassword(
      { apiId: Number(account.apiId), apiHash },
      { password }
    );

    await completeAuthorization(account, client, config, user);
    return { connected: true };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function loadWebAccount(token, config) {
  if (!token || token.length < 20) throw new Error('Invalid login link.');

  const hash = webTokenHash(token);
  const accounts = await Account.find({
    status: 'pending',
    loginStep: { $in: ['code', 'password'] }
  }).select(accountFields());

  for (const account of accounts) {
    if (!account.loginWebTokenHash || !account.loginWebTokenExpiresAt) continue;
    if (account.loginWebTokenExpiresAt.getTime() < Date.now()) continue;

    const stored = decryptText(account.loginWebTokenHash, config.encryptionKey);
    if (stored === hash) return account;
  }

  throw new Error('This login link is invalid or expired. Start Add Account again.');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loginPage({ token, step = 'code', message = '', error = '' }) {
  const title = step === 'password' ? 'Telegram 2-Step Verification' : 'Telegram Login Code';
  const label = step === 'password'
    ? 'Enter your Telegram 2FA password'
    : 'Enter the login code Telegram sent to your account';
  const action = step === 'password' ? 'password' : 'code';
  const inputType = step === 'password' ? 'password' : 'text';
  const inputMode = step === 'password' ? 'text' : 'numeric';
  const safeMessage = message
    ? '<div class="ok">' + escapeHtml(message) + '</div>'
    : '';
  const safeError = error
    ? '<div class="error">' + escapeHtml(error) + '</div>'
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#101820;color:#fff;font-family:Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}
.card{width:100%;max-width:430px;background:#1d2a35;border-radius:20px;padding:26px;box-sizing:border-box;box-shadow:0 12px 40px #0008}
h1{font-size:24px;margin:0 0 10px}.sub{color:#b8c4cc;line-height:1.5;margin-bottom:22px}
label{display:block;font-size:14px;color:#cbd5dc;margin-bottom:8px}
input{width:100%;box-sizing:border-box;padding:15px;border:1px solid #465765;background:#101820;color:#fff;border-radius:12px;font-size:18px;outline:none}
button{width:100%;margin-top:14px;padding:15px;border:0;border-radius:12px;background:#2aabee;color:#fff;font-weight:700;font-size:16px}
.ok,.error{padding:12px;border-radius:10px;margin-bottom:14px;line-height:1.4}.ok{background:#174b36}.error{background:#5b2228}
.note{margin-top:18px;color:#9eabb4;font-size:12px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
<h1>🔐 ${escapeHtml(title)}</h1>
<div class="sub">${escapeHtml(label)}.<br><br>For security, the login code is entered on this secure page and is <b>not sent to the Telegram bot chat</b>.</div>
${safeMessage}${safeError}
<form id="loginForm">
<input id="value" name="value" type="${inputType}" inputmode="${inputMode}" autocomplete="${step === 'password' ? 'current-password' : 'one-time-code'}" required autofocus>
<button type="submit">Continue</button>
</form>
<div class="note">Never share this login link or your Telegram 2FA password with anyone.</div>
</div>
<script>
document.getElementById('loginForm').addEventListener('submit',async function(e){
 e.preventDefault();
 const value=document.getElementById('value').value.trim();
 const r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'${action}',value})});
 document.open();document.write(await r.text());document.close();
});
</script>
</body>
</html>`;
}

export async function handleWebLogin(req, res, config) {
  const url = new URL(req.url, 'https://login.local');
  const token = url.searchParams.get('token') || '';

  try {
    const account = await loadWebAccount(token, config);

    if (req.method === 'GET') {
      res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(loginPage({ token, step: account.loginStep }));
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).end('Method not allowed');
      return;
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const action = String(body.action || '');
    const value = String(body.value || '').trim();

    if (!value) throw new Error('Please enter the required value.');

    let result;
    if (action === 'code' && account.loginStep === 'code') {
      if (!/^\d{5,7}$/.test(value)) throw new Error('Enter the Telegram login code exactly as received.');
      result = await finishWebCodeLogin(account, config, value);
    } else if (action === 'password' && account.loginStep === 'password') {
      if (value.length < 1 || value.length > 256) throw new Error('Invalid 2FA password.');
      result = await finishWebPasswordLogin(account, config, value);
    } else {
      throw new Error('This login step is no longer valid. Start Add Account again.');
    }

    if (result.connected) {
      const stored = await Account.findById(account._id)
        .select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted');
      const client = await createUserClient({
        account: stored,
        encryptionKey: config.encryptionKey
      });
      await attachAutoReply(stored, client);

      res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(loginPage({
        token,
        step: 'code',
        message: 'Telegram account connected successfully. You can return to the bot.'
      }).replace(
        '<form id="loginForm">',
        '<div class="ok">Login complete. This link is now disabled.</div><div class="note">You can safely close this page and return to Telegram.</div><form id="loginForm" style="display:none">'
      ));
      return;
    }

    if (result.passwordRequired) {
      res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(loginPage({
        token,
        step: 'password',
        message: 'Code accepted. Your account requires 2-step verification.'
      }));
      return;
    }

    throw new Error('Login did not complete.');
  } catch (error) {
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(loginPage({
      token,
      step: 'code',
      error: error?.message || String(error)
    }));
  }
}

async function deleteMessage(ctx) {
  try {
    await ctx.deleteMessage();
  } catch {}
}

export function registerAccountHandlers(bot, config) {
  bot.command('cancel', async ctx => {
    const account = await Account.findOne({
      ownerId: ctx.from.id,
      status: 'pending',
      loginStep: { $in: ['phone', 'code', 'password'] }
    }).sort({ updatedAt: -1 });

    if (account) {
      account.status = 'error';
      account.lastError = 'Login cancelled';
      account.loginStep = null;
      account.loginPhoneCodeHashEncrypted = undefined;
      account.loginQrTokenEncrypted = undefined;
      account.loginQrExpiresAt = null;
      clearWebToken(account);
      await account.save();
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
      'After that, the bot will ask for API Hash and phone number.\n' +
      'The Telegram login code will be entered on a secure web page, NOT in this bot chat.\n\n' +
      '/cancel to stop.'
    );
  });

  bot.action('account_web_cancel', async ctx => {
    await ctx.answerCbQuery();

    const account = await Account.findOne({
      ownerId: ctx.from.id,
      status: 'pending',
      loginStep: { $in: ['phone', 'code', 'password'] }
    }).sort({ updatedAt: -1 });

    if (account) {
      account.status = 'error';
      account.loginStep = null;
      account.loginPhoneCodeHashEncrypted = undefined;
      clearWebToken(account);
      account.lastError = 'Login cancelled';
      await account.save();
    }

    pending.delete(ctx.from.id);
    await ctx.reply('❌ Telegram account login cancelled.', mainKeyboard());
  });

  bot.on('text', async (ctx, next) => {
    let state = pending.get(ctx.from.id);
    const text = ctx.message.text.trim();

    if (!state) {
      const account = await Account.findOne({
        ownerId: ctx.from.id,
        status: 'pending',
        loginStep: { $in: ['phone', 'code', 'password'] }
      }).sort({ updatedAt: -1 });

      if (account) {
        state = { step: account.loginStep, accountId: account._id };
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
        account.loginPhoneCodeHashEncrypted = undefined;
        clearWebToken(account);
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
        '2/4 Send your Telegram API Hash.\n\n' +
        'It will be encrypted before being stored.\n\n/cancel to stop.'
      );
      return;
    }

    if (state.step === 'api_hash') {
      await deleteMessage(ctx);

      if (!/^[A-Za-z0-9_-]{20,}$/.test(text)) {
        await ctx.reply('❌ That API Hash does not look valid. Please copy it exactly from my.telegram.org.');
        return;
      }

      try {
        const account = await Account.create({
          ownerId: ctx.from.id,
          phoneMasked: 'Pending Telegram Account',
          apiId: state.apiId,
          apiHashEncrypted: encryptText(text, config.encryptionKey),
          status: 'pending',
          loginStep: 'phone'
        });

        pending.set(ctx.from.id, { step: 'phone', accountId: account._id });
        await ctx.reply(
          '3/4 Send the Telegram phone number for this account.\n\n' +
          'Use international format, for example: +919876543210\n\n' +
          'The login code will NOT be entered in this Telegram chat.\n/cancel to stop.'
        );
      } catch (error) {
        await ctx.reply('❌ Could not create login session: ' + (error.message || String(error)), mainKeyboard());
      }
      return;
    }

    if (state.step === 'phone') {
      await deleteMessage(ctx);

      const phone = text.replace(/[\s()-]/g, '');
      if (!/^\+\d{7,15}$/.test(phone)) {
        await ctx.reply('❌ Enter a valid phone number in international format, e.g. +919876543210.');
        return;
      }

      const account = await Account.findOne({
        _id: state.accountId,
        ownerId: ctx.from.id,
        status: 'pending',
        loginStep: 'phone'
      }).select(accountFields());

      if (!account) {
        pending.delete(ctx.from.id);
        await ctx.reply('❌ Login session not found. Please start Add Account again.', mainKeyboard());
        return;
      }

      try {
        const result = await sendLoginCode(account, config, phone);
        pending.set(ctx.from.id, { step: 'code', accountId: account._id });

        const url = productionWebUrl(result.token);
        const delivery = result.isCodeViaApp
          ? 'Telegram sent the login code to your Telegram app.'
          : 'Telegram sent the login code using its available verification method.';

        await ctx.reply(
          '4/4 🔐 Secure Login\n\n' +
          delivery + '\n\n' +
          'Open the secure page below and enter the code there.\n' +
          '⚠️ Do NOT forward or send the Telegram login code to this bot.\n\n' +
          'The secure login link expires in 10 minutes.',
          loginWebKeyboard(url)
        );
      } catch (error) {
        account.lastError = error.message || String(error);
        await account.save().catch(() => {});
        await ctx.reply(
          '❌ Could not send Telegram login code: ' + (error.message || String(error)),
          mainKeyboard()
        );
      }
      return;
    }

    if (state.step === 'code' || state.step === 'password') {
      await ctx.reply(
        '🔐 Your login is waiting on the secure web page.\n\n' +
        'Use the “🔐 Open Secure Login” button from the previous message.\n' +
        'Do not send the Telegram login code or 2FA password in this bot chat.\n\n/cancel to stop.'
      );
      return;
    }
  });
}
