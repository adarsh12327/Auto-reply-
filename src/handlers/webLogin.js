import { Account } from '../db.js';
import { encryptText, decryptText } from '../crypto.js';
import { mainKeyboard } from '../bot/keyboards.js';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import QRCode from 'qrcode';
import { Markup } from 'telegraf';
import { createHash, randomBytes } from 'node:crypto';
import { createUserClient, attachAutoReply } from '../services/telegramClient.js';

const TTL = 10 * 60 * 1000;
const QR_REFRESH_MS = 28000;

const clients = globalThis.__KAP_WEB_LOGIN_CLIENTS || (globalThis.__KAP_WEB_LOGIN_CLIENTS = new Map());

const hashToken = value => createHash('sha256').update(value).digest('hex');

function botUrl(config) {
  return config.botUsername ? 'https://t.me/' + config.botUsername : 'https://t.me/';
}

function loginUrl(token) {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || 'auto-reply-nine-liart.vercel.app';
  return 'https://' + host + '/api/login?token=' + encodeURIComponent(token);
}

export function issueWebLogin(account, key) {
  const token = randomBytes(32).toString('base64url');
  account.loginWebTokenHash = encryptText(hashToken(token), key);
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
    [Markup.button.url('📱 Add Mobile Number Telegram Account', loginUrl(token))],
    [Markup.button.callback('🏠 Home', 'main_menu')]
  ]);
}

function esc(v) {
  return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function page(token, config, state, data = {}) {
  const bot = esc(botUrl(config));
  let body = '';

  if (state === 'qr') {
    body =
      '<div class="brand">KAP</div><div class="badge">SECURE TELEGRAM LOGIN</div>' +
      '<h1>Connect Telegram Account</h1>' +
      '<p class="muted">Approve this login inside your Telegram app. Google login and Telegram login codes are not used here.</p>' +
      '<div class="qr"><img id="qr" src="' + esc(data.image) + '" alt="Telegram QR"></div>' +
      '<a id="open" class="primary" href="' + esc(data.telegramUrl) + '">📲 Open in Telegram App</a>' +
      '<div class="steps"><b>How to continue</b><br>1. Tap “Open in Telegram App”.<br>2. Confirm the login in Telegram.<br>3. Return here; this page checks automatically.</div>' +
      '<div id="status" class="status">Waiting for Telegram confirmation…</div>';
  } else if (state === 'password') {
    body =
      '<div class="brand">KAP</div><div class="badge">2-STEP VERIFICATION</div>' +
      '<h1>Final security check</h1><p class="muted">Enter the Telegram account’s 2-step verification password.</p>' +
      '<form id="passwordForm"><input id="password" type="password" autocomplete="current-password" placeholder="Telegram 2FA password" required><button class="primary">Continue Securely</button></form><div id="status" class="status"></div>';
  } else if (state === 'success') {
    body =
      '<div class="success">✓</div><div class="badge">CONNECTED</div><h1>Login successful</h1>' +
      '<p class="muted">Telegram account connected successfully. The bot has been notified.</p>' +
      '<a class="primary" href="' + bot + '">✅ Confirm & Return to Bot</a>' +
      '<div class="hint">Returning automatically…</div>' +
      '<script>setTimeout(function(){location.href=' + JSON.stringify(botUrl(config)) + '},1800)</script>';
  } else {
    body =
      '<div class="errorIcon">!</div><h1>Login could not continue</h1>' +
      '<p class="error">' + esc(data.error || 'Unknown error') + '</p>' +
      '<a class="primary" href="' + bot + '">↩️ Return to Bot</a>';
  }

  const script = state === 'qr'
    ? '<script>' +
      'const token=' + JSON.stringify(token) + ';' +
      'async function check(){try{' +
      'const r=await fetch(location.pathname+"?token="+encodeURIComponent(token)+"&action=wait",{cache:"no-store"});' +
      'const d=await r.json();' +
      'if(d.type==="success"||d.type==="password"){document.open();document.write(d.html);document.close();return;}' +
      'if(d.type==="qr"){document.getElementById("qr").src=d.image;document.getElementById("open").href=d.telegramUrl;document.getElementById("status").textContent="New secure QR generated. Confirm it in Telegram.";}' +
      'else if(d.type==="error"){document.getElementById("status").textContent=d.message||"Please wait…";}' +
      '}catch(e){document.getElementById("status").textContent="Connection interrupted. Retrying…";}' +
      'setTimeout(check,1200);}check();' +
      '</script>'
    : state === 'password'
      ? '<script>document.getElementById("passwordForm").addEventListener("submit",async function(e){e.preventDefault();const s=document.getElementById("status");s.textContent="Completing Telegram authorization…";const r=await fetch(location.href,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"password",password:document.getElementById("password").value})});document.open();document.write(await r.text());document.close();});</script>'
      : '';

  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b1220"><title>KAP • Telegram Login</title>' +
    '<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#18304a,#070b12 70%);color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;padding:20px}.card{width:min(100%,460px);background:#121c2af5;border:1px solid #ffffff16;border-radius:28px;padding:28px;text-align:center;box-shadow:0 30px 90px #0008}.brand{font-weight:900;letter-spacing:5px;color:#2aabee}.badge{display:inline-block;margin-top:8px;padding:7px 11px;border-radius:999px;background:#2aabee18;color:#8bdcff;font-size:11px;font-weight:800;letter-spacing:1px}h1{font-size:26px;margin:16px 0 10px}.muted{color:#adbdca;line-height:1.55}.qr{background:#fff;padding:12px;border-radius:20px;width:min(100%,330px);margin:20px auto}.qr img{width:100%;display:block;border-radius:10px}.primary,button{display:block;width:100%;padding:15px;border:0;border-radius:14px;background:#2aabee;color:#fff;font-weight:800;font-size:15px;text-decoration:none;cursor:pointer}.steps,.status,.hint{margin-top:15px;padding:14px;border-radius:14px;background:#ffffff0a;color:#adbdca;font-size:13px;line-height:1.55}.status{text-align:center}.success,.errorIcon{width:76px;height:76px;border-radius:50%;display:grid;place-items:center;margin:4px auto 18px;font-size:42px;font-weight:900;background:#123b2c;color:#5cf0ae}.errorIcon{background:#4b2027;color:#ff9fab}.error{background:#4b2027;color:#ffd8dd;padding:14px;border-radius:14px;line-height:1.5}input{width:100%;padding:15px;border-radius:14px;border:1px solid #385064;background:#0d1723;color:#fff;font-size:16px;margin:18px 0 10px}</style></head><body><div class="card">' +
    body + '</div>' + script + '</body></html>';
}

async function findAccount(token, config) {
  if (!token || token.length < 20) throw new Error('Invalid login link.');
  const wanted = hashToken(token);
  const accounts = await Account.find({status:'pending',loginStep:{$in:['web','qr','password']}})
    .select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted +loginWebTokenHash');
  for (const account of accounts) {
    if (!account.loginWebTokenHash || !account.loginWebTokenExpiresAt) continue;
    if (account.loginWebTokenExpiresAt.getTime() < Date.now()) continue;
    if (decryptText(account.loginWebTokenHash, config.encryptionKey) === wanted) return account;
  }
  throw new Error('This secure login link is invalid or expired. Start Add Account again.');
}

async function getClient(account, config) {
  const key = String(account._id);
  let item = clients.get(key);
  if (item?.client?.connected) return item;

  const apiHash = decryptText(account.apiHashEncrypted, config.encryptionKey);
  const session = account.sessionEncrypted ? decryptText(account.sessionEncrypted, config.encryptionKey) : '';
  const client = new TelegramClient(new StringSession(session), Number(account.apiId), apiHash, {connectionRetries:5});

  item = {
    client,
    apiHash,
    accepted: false,
    expiresAt: 0,
    eventHandler: null
  };

  item.eventHandler = update => {
    if (update instanceof Api.UpdateLoginToken) {
      item.accepted = true;
    }
  };

  await client.connect();
  client.addEventHandler(item.eventHandler);
  clients.set(key, item);
  return item;
}

async function makeQr(account, config) {
  const item = await getClient(account, config);
  const {client, apiHash} = item;

  let result = await client.invoke(new Api.auth.ExportLoginToken({
    apiId:Number(account.apiId), apiHash, exceptIds:[]
  }));

  if (result instanceof Api.auth.LoginTokenMigrateTo) {
    await client._switchDC(result.dcId);
    result = await client.invoke(new Api.auth.ImportLoginToken({token:result.token}));
  }

  if (!(result instanceof Api.auth.LoginToken)) return {result, client, item};

  const telegramUrl = 'tg://login?token=' + Buffer.from(result.token).toString('base64url');
  const image = await QRCode.toDataURL(telegramUrl,{width:420,margin:2,errorCorrectionLevel:'M'});
  item.accepted = false;
  item.expiresAt = Number(result.expires) * 1000;

  account.loginQrTokenEncrypted = encryptText(Buffer.from(result.token).toString('base64'),config.encryptionKey);
  account.loginQrExpiresAt = new Date(item.expiresAt);
  account.loginStep = 'qr';
  await account.save();

  return {image,telegramUrl,client,item};
}

async function notifyBot(config, account) {
  if (!config.botToken) return;
  await fetch('https://api.telegram.org/bot' + config.botToken + '/sendMessage',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({
      chat_id:account.ownerId,
      text:'✅ Telegram account connected successfully!\\n\\n📱 ' + (account.phoneMasked || 'Telegram Account') + '\\n\\n🏠 Home page is ready.',
      reply_markup:mainKeyboard().reply_markup
    })
  }).catch(e=>console.warn('Web login bot notify failed:',e?.message));
}

async function complete(account, client, config, authorization) {
  const user = authorization?.user || authorization;
  if (!user?.id) throw new Error('Telegram did not return an authorized user.');
  account.telegramUserId = Number(user.id);
  if (user.phone) {
    const phone = String(user.phone).startsWith('+') ? String(user.phone) : '+' + String(user.phone);
    account.phoneEncrypted = encryptText(phone,config.encryptionKey);
    account.phoneMasked = phone.slice(0,3) + '••••' + phone.slice(-3);
  }
  account.status='connected'; account.connectedAt=new Date(); account.lastSeenAt=new Date();
  account.lastError=''; account.loginStep=null; account.loginQrTokenEncrypted=undefined; account.loginQrExpiresAt=null;
  clearWebLogin(account);
  account.sessionEncrypted=encryptText(client.session.save(),config.encryptionKey);
  await account.save();

  const stored=await Account.findById(account._id).select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted');
  const live=await createUserClient({account:stored,encryptionKey:config.encryptionKey});
  await attachAutoReply(stored,live);
  await notifyBot(config,account);
}

export async function handleWebLogin(req,res,config) {
  const url=new URL(req.url,'https://login.local');
  const token=url.searchParams.get('token')||'';
  const action=url.searchParams.get('action')||'';

  try {
    const account=await findAccount(token,config);

    if(req.method==='GET' && !action) {
      const qr=await makeQr(account,config);
      if(qr.result instanceof Api.auth.LoginTokenSuccess && qr.result.authorization instanceof Api.auth.Authorization) {
        if(qr.result.authorization.passwordPending){
          await account.save();
          return res.status(200).setHeader('Content-Type','text/html; charset=utf-8'),res.end(page(token,config,'password'));
        }
        await complete(account,qr.client,config,qr.result.authorization);
        return res.status(200).setHeader('Content-Type','text/html; charset=utf-8'),res.end(page(token,config,'success'));
      }
      res.status(200).setHeader('Content-Type','text/html; charset=utf-8');
      return res.end(page(token,config,'qr',qr));
    }

    if(req.method==='GET' && action==='wait') {
      const item=await getClient(account,config);
      const {client,apiHash}=item;

      // Telegram sends updateLoginToken to the same live connection after the
      // QR is accepted. Only then do we call exportLoginToken again, as required
      // by Telegram's official QR-login flow.
      if (!item.accepted && Date.now() < item.expiresAt - 1500) {
        return res.json({type:'waiting'});
      }

      let result=await client.invoke(new Api.auth.ExportLoginToken({apiId:Number(account.apiId),apiHash,exceptIds:[]}));

      if(result instanceof Api.auth.LoginTokenMigrateTo){
        await client._switchDC(result.dcId);
        result=await client.invoke(new Api.auth.ImportLoginToken({token:result.token}));
      }

      if(result instanceof Api.auth.LoginTokenSuccess && result.authorization instanceof Api.auth.Authorization){
        if(result.authorization.passwordPending){
          account.loginStep='password'; await account.save();
          return res.json({type:'password',html:page(token,config,'password')});
        }
        await complete(account,client,config,result.authorization);
        const current=clients.get(String(account._id));
        if(current?.eventHandler) {
          try { client.removeEventHandler(current.eventHandler); } catch {}
        }
        clients.delete(String(account._id));
        return res.json({type:'success',html:page(token,config,'success')});
      }

      if(result instanceof Api.auth.LoginToken){
        item.accepted=false;
        item.expiresAt=Number(result.expires)*1000;
        const telegramUrl='tg://login?token='+Buffer.from(result.token).toString('base64url');
        const image=await QRCode.toDataURL(telegramUrl,{width:420,margin:2,errorCorrectionLevel:'M'});
        account.loginQrTokenEncrypted=encryptText(Buffer.from(result.token).toString('base64'),config.encryptionKey);
        account.loginQrExpiresAt=new Date(item.expiresAt);
        account.loginStep='qr'; await account.save();
        return res.json({type:'qr',image,telegramUrl});
      }

      return res.json({type:'error',message:'Telegram returned an unexpected login response.'});
    }

    if(req.method==='POST'){
      let body=req.body;
      if(typeof body==='string'){try{body=JSON.parse(body)}catch{body={}}}
      if(body?.action!=='password') throw new Error('Invalid login action.');
      const {client}=await getClient(account,config);
      const apiHash=decryptText(account.apiHashEncrypted,config.encryptionKey);
      const user=await client.signInWithPassword({apiId:Number(account.apiId),apiHash},{password:String(body.password||'')});
      await complete(account,client,config,user);
      clients.delete(String(account._id));
      res.status(200).setHeader('Content-Type','text/html; charset=utf-8');
      return res.end(page(token,config,'success'));
    }

    throw new Error('Method not allowed.');
  } catch(error) {
    console.error('Web login error:',error);
    if(res.headersSent) return res.end();
    res.status(400).setHeader('Content-Type','text/html; charset=utf-8');
    res.end(page(token,config,'error',{error:error?.message||String(error)}));
  }
}
