import { Account } from '../db.js';
import { encryptText, decryptText } from '../crypto.js';
import { mainKeyboard } from '../bot/keyboards.js';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import QRCode from 'qrcode';
import { Markup } from 'telegraf';
import { randomBytes, createHash } from 'node:crypto';
import { createUserClient, attachAutoReply } from '../services/telegramClient.js';

const TTL = 10 * 60 * 1000;
const WAIT_MS = 24000;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function botUrl(config) {
  return config.botUsername ? 'https://t.me/' + config.botUsername : 'https://t.me/';
}

function webUrl(token) {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || 'auto-reply-nine-liart.vercel.app';
  return 'https://' + host + '/api/login?token=' + encodeURIComponent(token);
}

export function issueWebLogin(account, encryptionKey) {
  const token = randomBytes(32).toString('base64url');
  account.loginWebTokenHash = encryptText(hashToken(token), encryptionKey);
  account.loginWebTokenExpiresAt = new Date(Date.now() + TTL);
  account.loginStep = 'web';
  return token;
}

export function clearWebLogin(account) {
  account.loginWebTokenHash = undefined;
  account.loginWebTokenExpiresAt = null;
}

export function webLoginKeyboard(token) {
  return Markup.inlineKeyboard([
    [Markup.button.url('📱 Add Mobile Number Telegram Account', webUrl(token))],
    [Markup.button.callback('🏠 Home', 'main_menu')]
  ]);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(token, state, data) {
  const bot = escapeHtml(botUrl(data.config));
  let body;

  if (state === 'loading') {
    body = '<div class="brand">KAP</div><div class="badge">SECURE TELEGRAM LOGIN</div>' +
      '<h1>Preparing secure login</h1><p class="muted">Connecting securely to Telegram…</p>' +
      '<div class="qr-wrap"><img id="qr" alt="Telegram QR"></div>' +
      '<a id="tg" class="primary" href="#">📲 Open in Telegram App</a>' +
      '<div id="status" class="status">Preparing your secure login…</div>';
  } else if (state === 'qr') {
    body = '<div class="brand">KAP</div><div class="badge">SECURE TELEGRAM LOGIN</div>' +
      '<h1>Connect Telegram Account</h1><p class="muted">Confirm this login in your Telegram app. No Google login and no Telegram login code is used.</p>' +
      '<div class="qr-wrap"><img id="qr" src="' + escapeHtml(data.image) + '" alt="Telegram QR"></div>' +
      '<a id="tg" class="primary" href="' + escapeHtml(data.telegramUrl) + '">📲 Open in Telegram App</a>' +
      '<div class="steps">1. Tap “Open in Telegram App” or scan the QR.<br>2. Confirm the new login in Telegram.<br>3. Keep this page open. It checks automatically.</div>' +
      '<div id="status" class="status">Waiting for Telegram confirmation…</div>';
  } else if (state === 'password') {
    body = '<div class="brand">KAP</div><div class="badge">2-STEP VERIFICATION</div>' +
      '<h1>Final Telegram security check</h1><p class="muted">This account requires its Telegram 2-step verification password.</p>' +
      '<form id="passwordForm"><input id="password" type="password" autocomplete="current-password" placeholder="Telegram 2FA password" required>' +
      '<button class="primary" type="submit">Continue Securely</button></form><div id="status" class="status"></div>';
  } else if (state === 'success') {
    body = '<div class="success">✓</div><div class="badge">CONNECTED</div>' +
      '<h1>Telegram account connected</h1><p class="muted">Login successful. The bot has been notified.</p>' +
      '<a class="primary" href="' + bot + '">✅ Confirm & Return to Bot</a>' +
      '<div class="hint">Returning automatically…</div>' +
      '<script>setTimeout(function(){location.href=' + JSON.stringify(botUrl(data.config)) + '},2000)</script>';
  } else {
    body = '<div class="errorIcon">!</div><h1>Login could not continue</h1>' +
      '<p class="error">' + escapeHtml(data.error) + '</p><a class="primary" href="' + bot + '">↩️ Return to Bot</a>';
  }

  const script = '<script>' +
    'const token=' + JSON.stringify(token) + ';' +
    'async function run(){while(true){try{' +
    'const r=await fetch(location.pathname+"?token="+encodeURIComponent(token)+"&action=wait",{cache:"no-store"});' +
    'const reader=r.body.getReader();const dec=new TextDecoder();let buf="";' +
    'while(true){const x=await reader.read();if(x.done)break;buf+=dec.decode(x.value,{stream:true});' +
    'const lines=buf.split("\\n");buf=lines.pop()||"";for(const line of lines){if(!line.trim())continue;' +
    'const d=JSON.parse(line);' +
    'if(d.type==="qr"){document.getElementById("qr").src=d.image;document.getElementById("tg").href=d.telegramUrl;document.getElementById("status").textContent="Waiting for Telegram confirmation…";}' +
    'else if(d.type==="success"||d.type==="password"){document.open();document.write(d.html);document.close();return;}' +
    'else if(d.type==="error"){document.getElementById("status").textContent=d.message||"Refreshing secure login…";}' +
    '}}}catch(e){}await new Promise(function(r){setTimeout(r,500)});}}' +
    'if(document.getElementById("qr"))run();' +
    'const pf=document.getElementById("passwordForm");if(pf){pf.addEventListener("submit",async function(e){e.preventDefault();' +
    'document.getElementById("status").textContent="Completing Telegram authorization…";' +
    'const r=await fetch(location.href,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"password",password:document.getElementById("password").value})});' +
    'document.open();document.write(await r.text());document.close();});}' +
    '</script>';

  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="theme-color" content="#0b1220"><title>KAP • Secure Telegram Login</title>' +
    '<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#18304a,#070b12 70%);color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;padding:20px}.card{width:min(100%,460px);background:#121c2af5;border:1px solid #ffffff16;border-radius:28px;padding:28px;text-align:center;box-shadow:0 30px 90px #0008}.brand{font-weight:900;letter-spacing:5px;color:#2aabee}.badge{display:inline-block;margin-top:8px;padding:7px 11px;border-radius:999px;background:#2aabee18;color:#8bdcff;font-size:11px;font-weight:800;letter-spacing:1px}h1{font-size:26px;margin:16px 0 10px}.muted{color:#adbdca;line-height:1.55}.qr-wrap{background:#fff;padding:12px;border-radius:20px;width:min(100%,330px);margin:20px auto}.qr-wrap img{width:100%;display:block;border-radius:10px;min-height:40px}.primary,button{display:block;width:100%;padding:15px;border:0;border-radius:14px;background:#2aabee;color:#fff;font-weight:800;font-size:15px;text-decoration:none;cursor:pointer}.steps,.status,.hint{margin-top:15px;padding:14px;border-radius:14px;background:#ffffff0a;color:#adbdca;font-size:13px;line-height:1.55}.status{text-align:center}.success,.errorIcon{width:76px;height:76px;border-radius:50%;display:grid;place-items:center;margin:4px auto 18px;font-size:42px;font-weight:900;background:#123b2c;color:#5cf0ae}.errorIcon{background:#4b2027;color:#ff9fab}.error{background:#4b2027;color:#ffd8dd;padding:14px;border-radius:14px;line-height:1.5}input{width:100%;padding:15px;border-radius:14px;border:1px solid #385064;background:#0d1723;color:#fff;font-size:16px;margin:18px 0 10px}</style></head><body><div class="card">' +
    body + '</div>' + script + '</body></html>';
}

async function findAccount(token, config) {
  const hash = hashToken(token);
  const accounts = await Account.find({
    status: 'pending',
    loginStep: { $in: ['web', 'qr', 'password'] }
  }).select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted +loginWebTokenHash');

  for (const account of accounts) {
    if (!account.loginWebTokenHash || !account.loginWebTokenExpiresAt) continue;
    if (account.loginWebTokenExpiresAt.getTime() < Date.now()) continue;
    if (decryptText(account.loginWebTokenHash, config.encryptionKey) === hash) return account;
  }
  throw new Error('This secure login link is invalid or expired. Start Add Account again.');
}

async function clientFor(account, config) {
  const apiHash = decryptText(account.apiHashEncrypted, config.encryptionKey);
  const session = account.sessionEncrypted ? decryptText(account.sessionEncrypted, config.encryptionKey) : '';
  const client = new TelegramClient(new StringSession(session), Number(account.apiId), apiHash, { connectionRetries: 5 });
  await client.connect();
  return { client, apiHash };
}

async function saveSession(account, client, config) {
  account.sessionEncrypted = encryptText(client.session.save(), config.encryptionKey);
}

async function notifyBot(config, account) {
  if (!config.botToken) return;
  await fetch('https://api.telegram.org/bot' + config.botToken + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: account.ownerId,
      text: '✅ Telegram account connected successfully!\\n\\n📱 ' + (account.phoneMasked || 'Telegram Account') + '\\n\\n🏠 Home page is ready.',
      reply_markup: mainKeyboard().reply_markup
    })
  }).catch(error => console.warn('Web login bot notify failed:', error?.message));
}

async function complete(account, client, config, authorization) {
  const user = authorization?.user || authorization;
  if (!user?.id) throw new Error('Telegram did not return an authorized user.');

  account.telegramUserId = Number(user.id);
  if (user.phone) {
    const phone = String(user.phone).startsWith('+') ? String(user.phone) : '+' + String(user.phone);
    account.phoneEncrypted = encryptText(phone, config.encryptionKey);
    account.phoneMasked = phone.slice(0, 3) + '••••' + phone.slice(-3);
  }
  account.status = 'connected';
  account.connectedAt = new Date();
  account.lastSeenAt = new Date();
  account.lastError = '';
  account.loginStep = null;
  account.loginQrTokenEncrypted = undefined;
  account.loginQrExpiresAt = null;
  clearWebLogin(account);
  await saveSession(account, client, config);
  await account.save();

  const stored = await Account.findById(account._id).select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted');
  const liveClient = await createUserClient({ account: stored, encryptionKey: config.encryptionKey });
  await attachAutoReply(stored, liveClient);
  await notifyBot(config, account);
}

async function exportToken(client, account, apiHash) {
  return client.invoke(new Api.auth.ExportLoginToken({
    apiId: Number(account.apiId),
    apiHash,
    exceptIds: []
  }));
}

async function resolveAfterUpdate(client, account, apiHash) {
  let result = await exportToken(client, account, apiHash);
  if (result instanceof Api.auth.LoginTokenMigrateTo) {
    await client._switchDC(result.dcId);
    result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
  }
  return result;
}

async function waitForLogin(account, config, token, res) {
  const { client, apiHash } = await clientFor(account, config);
  let done = false;
  let timer;

  const finish = async payload => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    await client.disconnect().catch(() => {});
    if (!res.writableEnded) {
      res.write(JSON.stringify(payload) + '\\n');
      res.end();
    }
  };

  const onUpdate = async update => {
    if (!(update instanceof Api.UpdateLoginToken)) return;
    try {
      const result = await resolveAfterUpdate(client, account, apiHash);
      if (result instanceof Api.auth.LoginTokenSuccess && result.authorization instanceof Api.auth.Authorization) {
        if (result.authorization.passwordPending) {
          await saveSession(account, client, config);
          account.loginStep = 'password';
          await account.save();
          await finish({ type: 'password', html: page(token, 'password', { config }) });
        } else {
          await complete(account, client, config, result.authorization);
          await finish({ type: 'success', html: page(token, 'success', { config }) });
        }
        return;
      }
      await finish({ type: 'error', message: 'Telegram requested a new QR. Refreshing…' });
    } catch (error) {
      await finish({ type: 'error', message: error?.message || String(error) });
    }
  };

  client.addEventHandler(onUpdate);

  try {
    const result = await exportToken(client, account, apiHash);
    if (result instanceof Api.auth.LoginToken) {
      const tokenUrl = 'tg://login?token=' + Buffer.from(result.token).toString('base64url');
      const image = await QRCode.toDataURL(tokenUrl, { width: 420, margin: 2, errorCorrectionLevel: 'M' });

      account.loginQrTokenEncrypted = encryptText(Buffer.from(result.token).toString('base64'), config.encryptionKey);
      account.loginQrExpiresAt = new Date(Number(result.expires) * 1000);
      account.loginStep = 'qr';
      await account.save();

      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.write(JSON.stringify({ type: 'qr', image, telegramUrl: tokenUrl }) + '\\n');
      timer = setTimeout(() => finish({ type: 'error', message: 'QR expired. Refreshing…' }), WAIT_MS);
      return;
    }

    if (result instanceof Api.auth.LoginTokenSuccess && result.authorization instanceof Api.auth.Authorization) {
      if (result.authorization.passwordPending) {
        await saveSession(account, client, config);
        account.loginStep = 'password';
        await account.save();
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        res.end(JSON.stringify({ type: 'password', html: page(token, 'password', { config }) }) + '\\n');
      } else {
        await complete(account, client, config, result.authorization);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        res.end(JSON.stringify({ type: 'success', html: page(token, 'success', { config }) }) + '\\n');
      }
      await client.disconnect().catch(() => {});
      return;
    }

    await finish({ type: 'error', message: 'Unexpected Telegram login response.' });
  } catch (error) {
    await client.disconnect().catch(() => {});
    if (!res.headersSent) {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(page(token, 'error', { config, error: error?.message || String(error) }));
    }
  }
}

export async function handleWebLogin(req, res, config) {
  const url = new URL(req.url, 'https://login.local');
  const token = url.searchParams.get('token') || '';
  const action = url.searchParams.get('action') || '';

  try {
    const account = await findAccount(token, config);

    if (req.method === 'GET' && !action) {
      res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(page(token, 'loading', { config }));
      return;
    }

    if (req.method === 'GET' && action === 'wait') {
      await waitForLogin(account, config, token, res);
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      if (body?.action !== 'password') throw new Error('Invalid login action.');

      const { client, apiHash } = await clientFor(account, config);
      try {
        const user = await client.signInWithPassword({ apiId: Number(account.apiId), apiHash }, { password: String(body.password || '') });
        await complete(account, client, config, user);
        res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(page(token, 'success', { config }));
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
    res.end(page(token, 'error', { config, error: error?.message || String(error) }));
  }
}
