import { Account } from '../db.js';
import { encryptText, decryptText } from '../crypto.js';
import { mainKeyboard, qrLoginKeyboard } from '../bot/keyboards.js';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import QRCode from 'qrcode';
import { createUserClient, attachAutoReply } from '../services/telegramClient.js';
import { Markup } from 'telegraf';
import { randomBytes, createHash } from 'node:crypto';

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

const WEB_LOGIN_TTL_MS = 10 * 60 * 1000;
const QR_WAIT_MS = 24000;

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

function botUrl(config) {
  return config.botUsername ? 'https://t.me/' + config.botUsername : 'https://t.me/';
}

async function notifyBotLoginSuccess(config, ownerId, phoneMasked) {
  if (!config.botToken) return;
  try {
    await fetch('https://api.telegram.org/bot' + config.botToken + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: ownerId,
        text:
          '✅ Telegram account connected successfully!\\n\\n' +
          '📱 Account: ' + (phoneMasked || 'Telegram Account') + '\\n\\n' +
          '🏠 Business Dashboard is ready.',
        reply_markup: mainKeyboard().reply_markup
      })
    });
  } catch (error) {
    console.warn('Web login bot notification failed:', error?.message);
  }
}


function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loginWebPage({ token, state = 'loading', qr = '', telegramUrl = '', message = '', error = '', botLink = 'https://t.me/' }) {
  const body = state === 'loading'
    ? '<div class="brand">KAP</div><div class="badge">SECURE TELEGRAM LOGIN</div><h1>Preparing secure login</h1><p class="muted">Connecting to Telegram…</p><div class="qr-wrap"><img id="qr" src="" alt="Telegram QR Login"></div><a class="primary" href="#">📲 Open in Telegram App</a><div class="steps">Keep this page open. The secure QR will appear automatically and will refresh when needed.</div><div id="status" class="status">Connecting…</div>'
    : state === 'qr'
      ? '<div class="brand">KAP</div><div class="badge">SECURE TELEGRAM LOGIN</div><h1>Connect Telegram Account</h1><p class="muted">Approve this login from your Telegram app. No Google login and no Telegram login code is used.</p><div class="qr-wrap"><img id="qr" src="' + escapeHtml(qr) + '" alt="Telegram QR Login"></div><a class="primary" href="' + escapeHtml(telegramUrl) + '">📲 Open in Telegram App</a><div class="steps"><b>Continue in Telegram</b><br>1. Tap “Open in Telegram App” or scan the QR.<br>2. Confirm the new login in Telegram.<br>3. Keep this page open — it checks automatically.</div><div id="status" class="status">Waiting for Telegram confirmation…</div>'
      : state === 'password'
        ? '<div class="brand">KAP</div><div class="badge">2-STEP VERIFICATION</div><h1>Final Telegram security check</h1><p class="muted">This Telegram account requires its 2-step verification password.</p><form id="passwordForm"><input id="password" type="password" autocomplete="current-password" placeholder="Telegram 2FA password" required><button class="primary" type="submit">Continue Securely</button></form><div id="status" class="status"></div>'
        : state === 'success'
          ? '<div class="success">✓</div><div class="badge">CONNECTED</div><h1>Telegram account connected</h1><p class="muted">' + escapeHtml(message) + '</p><a class="primary" href="' + escapeHtml(botLink) + '">✅ Confirm & Return to Bot</a><div class="hint">Success was already sent to the bot. Returning automatically…</div><script>setTimeout(function(){location.href=' + JSON.stringify(botLink) + '},2000)</script>'
          : '<div class="errorIcon">!</div><h1>Login could not continue</h1><p class="error">' + escapeHtml(error) + '</p><a class="primary" href="' + escapeHtml(botLink) + '">↩️ Return to Bot</a>';

  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b1220"><title>KAP • Telegram Login</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#18304a,#070b12 70%);color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;padding:20px}.card{width:min(100%,460px);background:rgba(18,28,42,.96);border:1px solid #ffffff16;border-radius:28px;padding:28px;text-align:center;box-shadow:0 30px 90px #0008}.brand{font-weight:900;letter-spacing:5px;color:#2aabee}.badge{display:inline-block;margin-top:8px;padding:7px 11px;border-radius:999px;background:#2aabee18;color:#8bdcff;font-size:11px;font-weight:800;letter-spacing:1px}h1{font-size:26px;margin:16px 0 10px}.muted{color:#adbdca;line-height:1.55}.qr-wrap{background:#fff;padding:12px;border-radius:20px;width:min(100%,330px);margin:20px auto}.qr-wrap img{width:100%;display:block;border-radius:10px}.primary,button{display:block;width:100%;padding:15px;border:0;border-radius:14px;background:#2aabee;color:#fff;font-weight:800;font-size:15px;text-decoration:none;cursor:pointer}.steps,.status,.hint{margin-top:15px;padding:14px;border-radius:14px;background:#ffffff0a;color:#adbdca;font-size:13px;line-height:1.55}.status{text-align:center}.success,.errorIcon{width:76px;height:76px;border-radius:50%;display:grid;place-items:center;margin:4px auto 18px;font-size:42px;font-weight:900;background:#123b2c;color:#5cf0ae}.errorIcon{background:#4b2027;color:#ff9fab}.error{background:#4b2027;color:#ffd8dd;padding:14px;border-radius:14px;line-height:1.5}input{width:100%;padding:15px;border-radius:14px;border:1px solid #385064;background:#0d1723;color:#fff;font-size:16px;margin:18px 0 10px}.spinner{width:46px;height:46px;border:4px solid #2b4054;border-top-color:#2aabee;border-radius:50%;animation:s 1s linear infinite;margin:10px auto 20px}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div class="card">' + body + '</div><script>const token=' + JSON.stringify(token) + ';const wait=ms=>new Promise(r=>setTimeout(r,ms));async function run(){while(true){try{const r=await fetch(location.pathname+'?token='+encodeURIComponent(token)+'&action=wait',{cache:"no-store"});const reader=r.body.getReader();const dec=new TextDecoder();let buf="";while(true){const x=await reader.read();if(x.done)break;buf+=dec.decode(x.value,{stream:true});const lines=buf.split("\\n");buf=lines.pop()||"";for(const line of lines){if(!line.trim())continue;const d=JSON.parse(line);if(d.type==="qr"){const q=document.getElementById("qr");const a=document.querySelector("a.primary");if(q)q.src=d.image;if(a)a.href=d.telegramUrl;const s=document.getElementById("status");if(s)s.textContent="Waiting for Telegram confirmation…"}else if(d.type==="success"||d.type==="password"){document.open();document.write(d.html);document.close();return}else if(d.type==="error"){const s=document.getElementById("status");if(s)s.textContent=d.message||"Refreshing secure login…"}}}}catch(e){}await wait(500)}}if(document.getElementById("qr"))run();const pf=document.getElementById("passwordForm");if(pf)pf.addEventListener("submit",async e=>{e.preventDefault();document.getElementById("status").textContent="Completing Telegram authorization…";const r=await fetch(location.href,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"password",password:document.getElementById("password").value})});document.open();document.write(await r.text());document.close()});</script></body></html>';
}

async function loadWebAccount(token, config) {
  if (!token || token.length < 20) throw new Error('Invalid login link.');
  const hash = webTokenHash(token);
  const accounts = await Account.find({
    status: { $in: ['pending', 'connected'] },
    loginStep: { $in: ['web', 'qr', 'password'] }
  }).select(accountFields());

  for (const account of accounts) {
    if (!account.loginWebTokenHash || !account.loginWebTokenExpiresAt) continue;
    if (account.loginWebTokenExpiresAt.getTime() < Date.now()) continue;
    if (decryptText(account.loginWebTokenHash, config.encryptionKey) === hash) return account;
  }
  throw new Error('This secure login link is invalid or expired. Start Add Account again.');
}

async function finalizeWebQr(account, client, config, authorization) {
  if (!authorization) throw new Error('Telegram did not return authorization.');
  if (authorization.passwordPending) {
    await saveSession(account, client, config.encryptionKey);
    account.loginStep = 'password';
    account.loginQrTokenEncrypted = undefined;
    account.loginQrExpiresAt = null;
    await account.save();
    return { passwordRequired: true };
  }
  await completeQrAuthorization(account, client, config, authorization);
  const stored = await Account.findById(account._id).select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted');
  const liveClient = await createUserClient({ account: stored, encryptionKey: config.encryptionKey });
  await attachAutoReply(stored, liveClient);
  await notifyBotLoginSuccess(config, account.ownerId, account.phoneMasked);
  return { connected: true };
}

async function webLoginWait(account, config, token, res) {
  const { client, apiHash } = await createPendingLoginClient(account, config);
  let finished = false;
  let timer;

  const close = async payload => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { client.removeEventHandler(onUpdate); } catch {}
    await client.disconnect().catch(() => {});
    if (!res.writableEnded) {
      res.write(JSON.stringify(payload) + '\\n');
      res.end();
    }
  };

  const onUpdate = async update => {
    if (!(update instanceof Api.UpdateLoginToken)) return;
    try {
      let result = await exportQrAfterUpdate(client, account, apiHash);
      if (result instanceof Api.auth.LoginTokenMigrateTo) {
      await client._switchDC(result.dcId);
      result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
    }

    if (result instanceof Api.auth.LoginTokenSuccess && result.authorization instanceof Api.auth.Authorization) {
        const done = await finalizeWebQr(account, client, config, result.authorization);
        if (done.passwordRequired) {
          await close({ type: 'password', html: loginWebPage({ token, state: 'password', botLink: botUrl(config) }) });
        } else {
          await close({ type: 'success', html: loginWebPage({ token, state: 'success', message: 'Your Telegram account is now connected. Return to the bot.', botLink: botUrl(config) }) });
        }
        return;
      }
      if (result instanceof Api.auth.LoginTokenMigrateTo) {
        await client._switchDC(result.dcId);
        const migrated = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
        if (migrated instanceof Api.auth.LoginTokenSuccess && migrated.authorization instanceof Api.auth.Authorization) {
          const done = await finalizeWebQr(account, client, config, migrated.authorization);
          await close(done.passwordRequired
            ? { type: 'password', html: loginWebPage({ token, state: 'password', botLink: botUrl(config) }) }
            : { type: 'success', html: loginWebPage({ token, state: 'success', message: 'Your Telegram account is now connected. Return to the bot.', botLink: botUrl(config) }) });
          return;
        }
      }
      await close({ type: 'error', message: 'Telegram requested a fresh QR. Reconnecting…' });
    } catch (error) {
      await close({ type: 'error', message: error?.message || String(error) });
    }
  };

  client.addEventHandler(onUpdate);

  try {
    let result = await exportLoginToken(client, account, apiHash);
    if (result instanceof Api.auth.LoginToken) {
      const image = await QRCode.toDataURL('tg://login?token=' + Buffer.from(result.token).toString('base64url'), { width: 420, margin: 2, errorCorrectionLevel: 'M' });
      account.loginQrTokenEncrypted = encryptText(Buffer.from(result.token).toString('base64'), config.encryptionKey);
      account.loginQrExpiresAt = new Date(Number(result.expires) * 1000);
      account.loginStep = 'qr';
      await account.save();

      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.write(JSON.stringify({
        type: 'qr',
        image,
        telegramUrl: 'tg://login?token=' + Buffer.from(result.token).toString('base64url'),
        expiresAt: account.loginQrExpiresAt
      }) + '\\n');

      timer = setTimeout(() => close({ type: 'error', message: 'QR expired. Refreshing a new secure QR…' }), QR_WAIT_MS);
      return;
    }

    if (result instanceof Api.auth.LoginTokenSuccess && result.authorization instanceof Api.auth.Authorization) {
      const done = await finalizeWebQr(account, client, config, result.authorization);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(done.passwordRequired
        ? { type: 'password', html: loginWebPage({ token, state: 'password', botLink: botUrl(config) }) }
        : { type: 'success', html: loginWebPage({ token, state: 'success', message: 'Your Telegram account is now connected. Return to the bot.', botLink: botUrl(config) }) }) + '\\n');
      await client.disconnect().catch(() => {});
      return;
    }

    await close({ type: 'error', message: 'Telegram returned an unexpected login response.' });
  } catch (error) {
    await client.disconnect().catch(() => {});
    if (!res.headersSent) {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(loginWebPage({ token, state: 'error', error: error?.message || String(error), botLink: botUrl(config) }));
    }
  }
}

async function exportQrAfterUpdate(client, account, apiHash) {
  return exportLoginToken(client, account, apiHash);
}

export async function handleWebLogin(req, res, config) {
  const url = new URL(req.url, 'https://login.local');
  const token = url.searchParams.get('token') || '';
  const action = url.searchParams.get('action') || '';

  try {
    const account = await loadWebAccount(token, config);

    if (req.method === 'GET' && !action) {
      res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(loginWebPage({ token, state: 'loading', botLink: botUrl(config) }));
      return;
    }

    if (req.method === 'GET' && action === 'wait') {
      await webLoginWait(account, config, token, res);
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      if (body?.action !== 'password') throw new Error('Invalid login action.');

      const password = String(body.password || '');
      if (!password || password.length > 256) throw new Error('Invalid Telegram 2-step verification password.');

      const { client, apiHash } = await createPendingLoginClient(account, config);
      try {
        const user = await client.signInWithPassword({ apiId: Number(account.apiId), apiHash }, { password });
        await completeQrAuthorization(account, client, config, user);
        const stored = await Account.findById(account._id).select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted');
        const liveClient = await createUserClient({ account: stored, encryptionKey: config.encryptionKey });
        await attachAutoReply(stored, liveClient);
        await notifyBotLoginSuccess(config, account.ownerId, account.phoneMasked);

        res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(loginWebPage({ token, state: 'success', message: 'Your Telegram account is now connected. Return to the bot.', botLink: botUrl(config) }));
      } finally {
        await client.disconnect().catch(() => {});
      }
      return;
    }

    throw new Error('Method not allowed.');
  } catch (error) {
    if (res.headersSent) {
      try { res.end(JSON.stringify({ type: 'error', message: error?.message || String(error) }) + '\\n'); } catch {}
      return;
    }
    res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(loginWebPage({ token, state: 'error', error: error?.message || String(error), botLink: botUrl(config) }));
  }
}

function webLoginKeyboard(token) {
  return Markup.inlineKeyboard([
    [Markup.button.url('📱 Add Mobile Number Telegram Account', productionWebUrl(token))],
    [Markup.button.callback('🏠 Home', 'main_menu')]
  ]);
}

async function deleteMessage(ctx) {
  try {
    await ctx.deleteMessage();
  } catch {}
}

function accountFields() {
  return '+apiHashEncrypted +phoneEncrypted +sessionEncrypted +loginPhoneCodeHashEncrypted +loginQrTokenEncrypted +loginWebTokenHash';
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
      loginStep: { $in: ['web', 'qr', 'password'] }
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
      'After the API Hash is saved, a professional secure web login page will open.\n' +
      'You will confirm the Telegram account inside the Telegram app — no Google login and no login code in this bot chat.\n\n' +
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
        account = await Account.create({
          ownerId: ctx.from.id,
          phoneMasked: 'Telegram Account • Not Connected',
          apiId: state.apiId,
          apiHashEncrypted: encryptText(text, config.encryptionKey),
          status: 'pending',
          loginStep: 'web'
        });

        const token = issueWebToken(account, config.encryptionKey);
        await account.save();
        pending.delete(ctx.from.id);

        await ctx.reply(
          '✅ API credentials saved securely.\\n\\n' +
          '📱 Now add the mobile Telegram account from the professional secure login page.\\n\\n' +
          'No Google login is used. Telegram confirmation happens in the Telegram app.',
          webLoginKeyboard(token)
        );
      } catch (error) {
        if (account) {
          account.status = 'error';
          account.loginStep = null;
          clearWebToken(account);
          await account.save().catch(() => {});
        }
        pending.delete(ctx.from.id);
        await ctx.reply(
          '❌ Could not save Telegram API credentials: ' + (error.message || String(error)),
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
