import 'dotenv/config';

const required = ['BOT_TOKEN', 'BOT_USERNAME', 'MONGODB_URI', 'SESSION_ENCRYPTION_KEY'];

export function isHexKey(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

export function loadConfig() {
  for (const name of required) {
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  }

  if (!isHexKey(process.env.SESSION_ENCRYPTION_KEY)) {
    throw new Error('SESSION_ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
  }

  const adminIds = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => {
      if (!/^\d+$/.test(v)) throw new Error('ADMIN_IDS must contain numeric Telegram IDs');
      return Number(v);
    });

  return {
    botToken: process.env.BOT_TOKEN,
    botUsername: process.env.BOT_USERNAME.replace(/^@/, ''),
    mongoUri: process.env.MONGODB_URI,
    encryptionKey: Buffer.from(process.env.SESSION_ENCRYPTION_KEY, 'hex'),
    adminIds,
    supportUrl: process.env.SUPPORT_URL || '',
    nodeEnv: process.env.NODE_ENV || 'production',
    logLevel: process.env.LOG_LEVEL || 'info',
    sendDelayMs: Math.max(10000, Number(process.env.DEFAULT_SEND_DELAY_MS || 20000)),
    maxRecipients: Math.max(1, Number(process.env.MAX_CAMPAIGN_RECIPIENTS || 500)),
    maxMessageLength: Math.min(4096, Math.max(1, Number(process.env.MAX_MESSAGE_LENGTH || 4096))),
    requireConsent: process.env.REQUIRE_RECIPIENT_CONSENT !== 'false',
    requireGroupPermission: process.env.REQUIRE_GROUP_POST_PERMISSION !== 'false',
    referralPercent: Math.min(100, Math.max(0, Number(process.env.DEFAULT_REFERRAL_PERCENT || 10)))
  };
}
