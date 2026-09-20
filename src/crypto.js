import crypto from 'node:crypto';

const VERSION = 'v1';

export function encryptText(plainText, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptText(payload, key) {
  const [version, ivText, tagText, dataText] = String(payload).split('.');
  if (version !== VERSION) throw new Error('Unsupported encrypted session format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
}

export function randomHexKey() {
  return crypto.randomBytes(32).toString('hex');
}
