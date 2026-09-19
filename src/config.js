import crypto from 'node:crypto';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('Missing required environment variable: ' + name);
  return value;
}

function integer(name, min, max) {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
  }
  return value;
}

export function loadConfig() {
  const sessionKey = required('SESSION_ENCRYPTION_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(sessionKey)) {
    throw new Error('SESSION_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters');
  }

  const adminIds = required('ADMIN_IDS').split(',').map((id) => id.trim()).filter(Boolean);
  if (!adminIds.length || adminIds.some((id) => !/^\d+$/.test(id))) {
    throw new Error('ADMIN_IDS must be a comma-separated list of numeric Telegram IDs');
  }

  const apiId = integer('API_ID', 1, Number.MAX_SAFE_INTEGER);
  const apiHash = required('API_HASH');
  if (/^(your_|replace_)/i.test(apiHash)) throw new Error('API_HASH still contains a placeholder');

  const botToken = required('BOT_TOKEN');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error('BOT_TOKEN format looks invalid');

  return Object.freeze({
    nodeEnv: process.env.NODE_ENV?.trim() || 'production',
    botToken,
    botUsername: process.env.BOT_USERNAME?.trim().replace(/^@/, '') || '',
    mongoUri: required('MONGODB_URI'),
    apiId,
    apiHash,
    sessionEncryptionKey: sessionKey,
    adminIds: new Set(adminIds),
    supportUrl: process.env.SUPPORT_URL?.trim() || '',
    maxReplyLength: Math.min(4096, Math.max(1, Number(process.env.MAX_REPLY_LENGTH || 4096))),
    broadcastDelayMs: Math.max(35, Number(process.env.BROADCAST_DELAY_MS || 40)),
    appVersion: '2.0.0'
  });
}

export function isValidHexKey(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

export function generateEncryptionKey() {
  return crypto.randomBytes(32).toString('hex');
}
