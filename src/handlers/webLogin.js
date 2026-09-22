import { Account } from '../db.js';
import { encryptText, decryptText } from '../crypto.js';
import { mainKeyboard } from '../bot/keyboards.js';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Markup } from 'telegraf';
import { createHash, randomBytes } from 'node:crypto';
import { createUserClient, attachAutoReply } from '../services/telegramClient.js';

const TTL = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;

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
  // Telegram Web App: the HTTPS URL is not rendered as a normal URL
  // button in the bot chat. It opens as an in-Telegram mini app.
  return Markup.inlineKeyboard([
    [Markup.button.webApp('📱 Add Mobile Number Telegram Account', loginUrl(token))],
    [Markup.button.callback('🏠 Home', 'main_menu')]
  ]);
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(token, config, state, data = {}) {
  const bot = esc(botUrl(config));
  let body = '';

  if (state === 'phone') {
    body =
      '<div class="brand">KAP</div><div class="badge">SECURE TELEGRAM LOGIN</div>' +
      '<h1>Add Mobile Telegram Account</h1>' +
      '<p class="muted">Enter the mobile number of the Telegram account you want to connect. Telegram will send its official verification code to that account.</p>' +
      '<form id="phoneForm">' +
      '<label>Mobile number</label>' +
      '<input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+91XXXXXXXXXX" required>' +
      '<button class="primary">📨 Send Telegram Code</button>' +
      '</form>' +
      '<div id="status" class="status">Your number is sent directly to Telegram for verification.</div>' +
      '<div class="security">🔒 Your phone number and verification code are transmitted only to Telegram through the official API. They are not sent to this bot chat.</div>';
  } else if (state === 'code') {
    body =
      '<div class="brand">KAP</div><div class="badge">TELEGRAM VERIFICATION</div>' +
      '<h1>Enter Telegram Code</h1>' +
      '<p class="muted">Telegram has sent a login code to the account. Enter the code here to complete the sign-in.</p>' +
      '<div class="masked">' + esc(data.phoneMasked || 'Telegram account') + '</div>' +
      '<form id="codeForm">' +
      '<input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="12345" required>' +
      '<button class="primary">✅ Verify & Continue</button>' +
      '</form>' +
      '<button id="resend" class="secondary" type="button">🔄 Resend Code</button>' +
      '<div id="status" class="status">Never forward your Telegram login code to anyone.</div>' +
      '<div class="security">🔒 The code is entered only on this secure login page and is used directly with Telegram.</div>';
  } else if (state === 'password') {
    body =
      '<div class="brand">KAP</div><div class="badge">2-STEP VERIFICATION</div>' +
      '<h1>Telegram 2-Step Password</h1>' +
      '<p class="muted">This Telegram account has 2-step verification enabled. Enter its Telegram password to finish signing in.</p>' +
      '<form id="passwordForm">' +
      '<input id="password" type="password" autocomplete="current-password" placeholder="Telegram 2FA password" required>' +
      '<button class="primary">🔐 Complete Login</button>' +
      '</form>' +
      '<div id="status" class="status"></div>' +
      '<div class="security">🔒 The password is submitted directly to Telegram through the encrypted server connection and is not sent to the bot chat.</div>';
  } else if (state === 'success') {
    body =
      '<div class="success">✓</div><div class="badge">CONNECTED</div>' +
      '<h1>Telegram Connected</h1>' +
      '<p class="muted">The Telegram account has been connected successfully. The bot has been notified.</p>' +
      '<a class="primary" href="' + bot + '">🏠 Return to Bot</a>' +
      '<div class="hint">You can safely close this page.</div>';
  } else {
    body =
      '<div class="errorIcon">!</div><h1>Login Could Not Continue</h1>' +
      '<p class="error">' + esc(data.error || 'Unknown error') + '</p>' +
      '<a class="primary" href="' + bot + '">↩️ Return to Bot</a>';
  }

  let script = '';

  if (state === 'phone') {
    script =
      '<script>' +
      'document.getElementById("phoneForm").addEventListener("submit",async function(e){' +
      'e.preventDefault();const s=document.getElementById("status");const b=this.querySelector("button");' +
      'b.disabled=true;s.textContent="Sending verification code through Telegram…";' +
      'try{const r=await fetch(location.href,{method:"POST",headers:{"content-type":"application/json","X-Telegram-Init-Data":window.__tgInitData||""},body:JSON.stringify({action:"send_code",phone:document.getElementById("phone").value})});' +
      'const d=await r.json();if(d.ok){document.open();document.write(d.html);document.close();}else{s.textContent=d.error||"Could not send the Telegram code.";b.disabled=false;}}' +
      'catch(e){s.textContent="Connection interrupted. Please try again.";b.disabled=false;}});' +
      '</script>';
  } else if (state === 'code') {
    script =
      '<script>' +
      'document.getElementById("codeForm").addEventListener("submit",async function(e){' +
      'e.preventDefault();const s=document.getElementById("status");const b=this.querySelector("button");' +
      'b.disabled=true;s.textContent="Verifying with Telegram…";' +
      'const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),25000);' +
      'try{const r=await fetch(location.href,{method:"POST",headers:{"content-type":"application/json","X-Telegram-Init-Data":window.__tgInitData||""},body:JSON.stringify({action:"verify_code",code:document.getElementById("code").value}),signal:controller.signal});' +
      'clearTimeout(timer);const d=await r.json();if(d.ok){document.open();document.write(d.html);document.close();}else{s.textContent=d.error||"Invalid Telegram code.";b.disabled=false;}}' +
      'catch(e){clearTimeout(timer);s.textContent=e.name==="AbortError"?"Telegram verification is taking too long. Do not click Verify again; tap Resend Code only if Telegram says the code expired.":"Connection interrupted. Please try again.";b.disabled=false;}});' +
      'document.getElementById("resend").addEventListener("click",async function(){' +
      'const b=this,s=document.getElementById("status");b.disabled=true;s.textContent="Requesting a new Telegram code…";' +
      'const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);' +
      'try{const r=await fetch(location.href,{method:"POST",headers:{"content-type":"application/json","X-Telegram-Init-Data":window.__tgInitData||""},body:JSON.stringify({action:"resend_code"}),signal:controller.signal});' +
      'clearTimeout(timer);const d=await r.json();s.textContent=d.ok?"A new Telegram code has been sent.":(d.error||"Could not resend.");}catch(e){clearTimeout(timer);s.textContent=e.name==="AbortError"?"Telegram did not respond in time. Please wait and try again.":"Connection interrupted. Please try again.";}finally{b.disabled=false;}});' +
      '</script>';
  } else if (state === 'password') {
    script =
      '<script>' +
      'document.getElementById("passwordForm").addEventListener("submit",async function(e){' +
      'e.preventDefault();const s=document.getElementById("status");const b=this.querySelector("button");' +
      'b.disabled=true;s.textContent="Completing Telegram authorization…";' +
      'try{const r=await fetch(location.href,{method:"POST",headers:{"content-type":"application/json","X-Telegram-Init-Data":window.__tgInitData||""},body:JSON.stringify({action:"password",password:document.getElementById("password").value})});' +
      'const d=await r.json();if(d.ok){document.open();document.write(d.html);document.close();}else{s.textContent=d.error||"2FA password was not accepted.";b.disabled=false;}}' +
      'catch(e){s.textContent="Connection interrupted. Please try again.";b.disabled=false;}});' +
      '</script>';
  }

  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<meta name="theme-color" content="#0b1220"><script src="https://telegram.org/js/telegram-web-app.js?63"></script><title>KAP • Telegram Login</title>' +
    '<style>' +
    '*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#18304a,#070b12 70%);color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;padding:18px}' +
    '.card{width:min(100%,460px);background:#121c2af5;border:1px solid #ffffff16;border-radius:28px;padding:28px;text-align:center;box-shadow:0 30px 90px #0008}' +
    '.brand{font-weight:900;letter-spacing:5px;color:#2aabee;font-size:26px}.badge{display:inline-block;margin-top:8px;padding:7px 11px;border-radius:999px;background:#2aabee18;color:#8bdcff;font-size:11px;font-weight:800;letter-spacing:1px}' +
    'h1{font-size:25px;margin:16px 0 10px}.muted{color:#adbdca;line-height:1.55;text-align:left}.security,.status,.hint,.masked{margin-top:15px;padding:14px;border-radius:14px;background:#ffffff0a;color:#adbdca;font-size:13px;line-height:1.55;text-align:left}' +
    '.masked{text-align:center;color:#fff;font-weight:800;letter-spacing:1px}.primary,button{display:block;width:100%;padding:15px;border:0;border-radius:14px;background:#2aabee;color:#fff;font-weight:800;font-size:15px;text-decoration:none;cursor:pointer;margin-top:12px}' +
    '.secondary{background:#ffffff10;border:1px solid #ffffff18}.primary:disabled,button:disabled{opacity:.55;cursor:wait}' +
    'label{display:block;text-align:left;color:#adbdca;font-size:13px;margin-top:18px}input{width:100%;padding:15px;border-radius:14px;border:1px solid #385064;background:#0d1723;color:#fff;font-size:17px;margin-top:8px;outline:none}' +
    '.success,.errorIcon{width:76px;height:76px;border-radius:50%;display:grid;place-items:center;margin:4px auto 18px;font-size:42px;font-weight:900;background:#123b2c;color:#5cf0ae}.errorIcon{background:#4b2027;color:#ff9fab}.error{background:#4b2027;color:#ffd8dd;padding:14px;border-radius:14px;line-height:1.5}' +
    '</style></head><body><div class="card">' + body + '</div>' +
    '<script>if(window.Telegram&&window.Telegram.WebApp){window.Telegram.WebApp.ready();window.Telegram.WebApp.expand();}' +
    'window.__tgInitData=(window.Telegram&&window.Telegram.WebApp&&window.Telegram.WebApp.initData)||"";</script>' +
    script + '</body></html>';
}

async function findAccount(token, config) {
  if (!token || token.length < 20) throw new Error('Invalid login link.');
  const wanted = hashToken(token);
  const accounts = await Account.find({
    status: 'pending',
    loginStep: { $in: ['web', 'phone', 'code', 'password'] }
  }).select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted +loginPhoneCodeHashEncrypted +loginWebTokenHash');

  for (const account of accounts) {
    if (!account.loginWebTokenHash || !account.loginWebTokenExpiresAt) continue;
    if (account.loginWebTokenExpiresAt.getTime() < Date.now()) continue;
    if (decryptText(account.loginWebTokenHash, config.encryptionKey) === wanted) return account;
  }

  throw new Error('This secure login session is invalid or expired. Start Add Account again.');
}

async function createClient(account, config) {
  const apiHash = decryptText(account.apiHashEncrypted, config.encryptionKey);
  const session = account.sessionEncrypted
    ? decryptText(account.sessionEncrypted, config.encryptionKey)
    : '';

  const client = new TelegramClient(
    new StringSession(session),
    Number(account.apiId),
    apiHash,
    { connectionRetries: 5 }
  );

  await client.connect();
  return { client, apiHash };
}

function normalizePhone(phone) {
  const value = String(phone || '').trim().replace(/[\s()-]/g, '');
  if (!/^\+\d{7,15}$/.test(value)) {
    throw new Error('Enter the Telegram mobile number in international format, for example +91XXXXXXXXXX.');
  }
  return value;
}

function maskPhone(phone) {
  const value = String(phone || '');
  return value.length > 6 ? value.slice(0, 3) + '••••' + value.slice(-3) : value;
}

function errorText(error) {
  return String(error?.errorMessage || error?.message || error || '');
}

function publicTelegramError(error) {
  const raw = errorText(error);
  const upper = raw.toUpperCase();

  if (upper.includes('PHONE_NUMBER_INVALID')) return 'Telegram rejected this mobile number. Check the country code and number.';
  if (upper.includes('PHONE_NUMBER_FLOOD') || upper.includes('PHONE_PASSWORD_FLOOD')) return 'Telegram is temporarily limiting login attempts for this number. Please wait and try again later.';
  if (upper.includes('PHONE_CODE_INVALID')) return 'The Telegram verification code is incorrect. Please enter the latest code.';
  if (upper.includes('PHONE_CODE_EXPIRED')) return 'That Telegram code has expired. Request a new code.';
  if (upper.includes('PHONE_CODE_EMPTY')) return 'Enter the Telegram verification code.';
  if (upper.includes('SESSION_PASSWORD_NEEDED')) return 'This account has Telegram 2-step verification enabled.';
  if (upper.includes('AUTH_KEY_UNREGISTERED')) return 'The Telegram login session expired. Start Add Account again.';
  if (upper.includes('AUTH_RESTART')) return 'Telegram asked to restart the login. Please send the mobile number again.';
  if (upper.includes('FLOOD_WAIT')) return 'Telegram asked to wait before trying again. Please try later.';
  return raw || 'Telegram login could not be completed.';
}

async function saveAuthorizedAccount(account, client, config, user) {
  if (!user?.id) throw new Error('Telegram did not return an authorized user.');

  account.telegramUserId = Number(user.id);

  if (user.phone) {
    const phone = String(user.phone).startsWith('+') ? String(user.phone) : '+' + String(user.phone);
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
  clearWebLogin(account);
  account.sessionEncrypted = encryptText(client.session.save(), config.encryptionKey);
  await account.save();

  // OTP verification must return immediately after Telegram authorization is
  // persisted. Connecting the long-lived auto-reply client can be slow on a
  // fresh Vercel instance and must never make the Verify button appear stuck.
  void (async () => {
    try {
      const stored = await Account.findById(account._id)
        .select('+apiHashEncrypted +phoneEncrypted +sessionEncrypted');
      if (!stored) return;

      const live = await createUserClient({
        account: stored,
        encryptionKey: config.encryptionKey
      });
      await attachAutoReply(stored, live);
    } catch (error) {
      console.warn('Post-login Telegram client setup failed:', error?.message);
      await Account.updateOne(
        { _id: account._id, status: 'connected' },
        { $set: { lastError: error?.message || 'Auto-reply client setup failed' } }
      ).catch(() => {});
    }
  })();

  if (config.botToken) {
    await fetch('https://api.telegram.org/bot' + config.botToken + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: account.ownerId,
        text: '✅ Telegram account connected successfully!\\n\\n📱 ' +
          (account.phoneMasked || 'Telegram Account') +
          '\\n\\n🏠 Home page is ready.',
        reply_markup: mainKeyboard().reply_markup
      })
    }).catch(error => console.warn('Web login bot notify failed:', error?.message));
  }
}

async function sendCode(account, config, phone, forceResend = false) {
  const now = Date.now();

  // Telegram applies flood limits to login-code requests. Keep a server-side
  // cooldown for both the first request and resend so the web button cannot
  // hammer auth.sendCode/auth.resendCode.
  if (account.loginCodeSentAt && now - account.loginCodeSentAt.getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil(
      (RESEND_COOLDOWN_MS - (now - account.loginCodeSentAt.getTime())) / 1000
    );

    if (forceResend || account.loginStep === 'code') {
      throw new Error(
        'Please wait ' + wait + ' seconds before requesting another Telegram code.'
      );
    }
  }

  account.loginCodeSendingAt = new Date();
  account.lastError = '';
  await account.save();

  const { client, apiHash } = await createClient(account, config);

  try {
    let result;

    if (forceResend) {
      if (!account.loginPhoneCodeHashEncrypted || !account.phoneEncrypted) {
        throw new Error('No active Telegram verification request. Send the mobile number again.');
      }

      const savedPhone = decryptText(account.phoneEncrypted, config.encryptionKey);
      const savedHash = decryptText(
        account.loginPhoneCodeHashEncrypted,
        config.encryptionKey
      );

      try {
        result = await client.invoke(new Api.auth.ResendCode({
          phoneNumber: savedPhone,
          phoneCodeHash: savedHash
        }));
      } catch (error) {
        const upper = errorText(error).toUpperCase();
        if (upper.includes('PHONE_CODE_EXPIRED') || upper.includes('PHONE_CODE_HASH_EMPTY')) {
          result = await client.sendCode(
            { apiId: Number(account.apiId), apiHash },
            savedPhone,
            false
          );
        } else {
          throw error;
        }
      }
    } else {
      result = await client.sendCode(
        { apiId: Number(account.apiId), apiHash },
        phone,
        false
      );
    }

    // Telegram can theoretically return auth.sentCodeSuccess when a future
    // authorization token is accepted. Handle that explicitly instead of
    // trying to read phoneCodeHash from a successful authorization response.
    if (result instanceof Api.auth.SentCodeSuccess) {
      const user = result.authorization?.user || result.authorization;
      await saveAuthorizedAccount(account, client, config, user);
      return {
        connected: true,
        isCodeViaApp: false,
        phoneMasked: account.phoneMasked
      };
    }

    if (!result?.phoneCodeHash) {
      throw new Error('Telegram did not return a verification-code hash.');
    }

    // IMPORTANT: auth.sendCode binds phone_code_hash to this Telegram
    // authorization key. Vercel creates a fresh function instance/client on
    // the next Verify request, so persist the StringSession now. Otherwise
    // auth.signIn runs with a different auth key and Telegram can report the
    // otherwise-valid code as expired/invalid.
    await saveSession(account, client, config.encryptionKey);

    account.phoneEncrypted = encryptText(phone, config.encryptionKey);
    account.phoneMasked = maskPhone(phone);
    account.loginPhoneCodeHashEncrypted = encryptText(
      result.phoneCodeHash,
      config.encryptionKey
    );
    account.loginCodeSentAt = new Date();
    account.loginCodeSendingAt = null;
    account.loginCodeVerifyingAt = null;
    account.loginStep = 'code';
    account.status = 'pending';
    await account.save();

    return {
      isCodeViaApp: Boolean(result.isCodeViaApp),
      phoneMasked: account.phoneMasked
    };
  } catch (error) {
    account.loginCodeSendingAt = null;
    account.lastError = errorText(error);
    await account.save().catch(() => {});
    throw error;
  } finally {
    await client.disconnect().catch(() => {});
  }
}
async function verifyCode(account, config, code) {
  if (!/^\d{4,7}$/.test(String(code || '').trim())) {
    throw new Error('Enter the numeric Telegram verification code.');
  }

  if (!account.loginPhoneCodeHashEncrypted || !account.phoneEncrypted) {
    throw new Error('No active Telegram verification request. Send the mobile number again.');
  }

  if (account.loginCodeVerifyingAt) {
    const age = Date.now() - account.loginCodeVerifyingAt.getTime();
    if (age < 60 * 1000) {
      throw new Error('Verification is already in progress. Please wait a moment.');
    }
  }

  account.loginCodeVerifyingAt = new Date();
  await account.save();

  const { client, apiHash } = await createClient(account, config);

  try {
    const phone = decryptText(account.phoneEncrypted, config.encryptionKey);
    const phoneCodeHash = decryptText(account.loginPhoneCodeHashEncrypted, config.encryptionKey);

    let result;

    try {
      result = await client.invoke(new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: String(code).trim()
      }));
    } catch (error) {
      const upper = errorText(error).toUpperCase();

      if (upper.includes('SESSION_PASSWORD_NEEDED')) {
        account.loginStep = 'password';
        account.loginCodeVerifyingAt = null;
        account.lastError = '';
        await account.save();
        return { passwordRequired: true };
      }

      if (upper.includes('PHONE_CODE_INVALID')) {
        account.loginCodeVerifyingAt = null;
        account.lastError = 'PHONE_CODE_INVALID';
        await account.save();
        throw new Error('The Telegram code is incorrect. Please enter the latest code again.');
      }

      if (upper.includes('PHONE_CODE_EXPIRED') || upper.includes('PHONE_CODE_EMPTY')) {
        account.loginCodeVerifyingAt = null;
        account.lastError = upper.includes('PHONE_CODE_EMPTY')
          ? 'PHONE_CODE_EMPTY'
          : 'PHONE_CODE_EXPIRED';
        await account.save();
        throw new Error('This Telegram code has expired. Tap “Resend Code” to request a new code.');
      }

      throw error;
    }

    const user = result?.user || result;

    if (!user?.id) throw new Error('Telegram did not return an authorized user.');

    await saveAuthorizedAccount(account, client, config, user);
    return { connected: true };
  } catch (error) {
    account.loginCodeVerifyingAt = null;
    account.lastError = errorText(error);
    await account.save().catch(() => {});
    throw error;
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function verifyPassword(account, config, password) {
  if (!String(password || '').trim()) throw new Error('Enter your Telegram 2-step password.');

  const { client, apiHash } = await createClient(account, config);

  try {
    const result = await client.signInWithPassword(
      { apiId: Number(account.apiId), apiHash },
      { password: String(password) }
    );

    const user = result?.user || result;
    await saveAuthorizedAccount(account, client, config, user);
    return { connected: true };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function json(res, payload) {
  res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.end(JSON.stringify(payload));
}

export async function handleWebLogin(req, res, config) {
  const url = new URL(req.url, 'https://login.local');
  const token = url.searchParams.get('token') || '';

  try {
    const account = await findAccount(token, config);

    if (req.method === 'GET') {
      if (account.loginStep === 'code') {
        return res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8'), res.end(
          page(token, config, 'code', { phoneMasked: account.phoneMasked })
        );
      }

      if (account.loginStep === 'password') {
        return res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8'), res.end(
          page(token, config, 'password')
        );
      }

      return res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8'), res.end(
        page(token, config, 'phone')
      );
    }

    if (req.method !== 'POST') {
      throw new Error('Method not allowed.');
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const action = String(body?.action || '');

    if (action === 'send_code' || action === 'resend_code') {
      let phone;

      if (action === 'send_code') {
        phone = normalizePhone(body.phone);
      } else {
        if (!account.phoneEncrypted) throw new Error('No mobile number is saved for this login.');
        phone = decryptText(account.phoneEncrypted, config.encryptionKey);
      }

      const result = await sendCode(account, config, phone, action === 'resend_code');

      return json(res, {
        ok: true,
        html: page(token, config, 'code', { phoneMasked: result.phoneMasked }),
        isCodeViaApp: result.isCodeViaApp
      });
    }

    if (action === 'verify_code') {
      const result = await verifyCode(account, config, body.code);

      if (result.passwordRequired) {
        return json(res, {
          ok: true,
          html: page(token, config, 'password')
        });
      }

      return json(res, {
        ok: true,
        html: page(token, config, 'success')
      });
    }

    if (action === 'password') {
      await verifyPassword(account, config, body.password);
      return json(res, {
        ok: true,
        html: page(token, config, 'success')
      });
    }

    throw new Error('Invalid login action.');
  } catch (error) {
    console.error('Web Telegram login error:', error);

    if (req.method === 'POST') {
      return json(res, {
        ok: false,
        error: publicTelegramError(error)
      });
    }

    if (!res.headersSent) {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(page(token, config, 'error', {
        error: publicTelegramError(error)
      }));
    }

    return res.end();
  }
}
