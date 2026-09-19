import crypto from 'node:crypto';
import { isValidHexKey } from './config.js';

function getKey() {
  const raw = process.env.SESSION_ENCRYPTION_KEY;
  if (!isValidHexKey(raw)) throw new Error('SESSION_ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
  return Buffer.from(raw, 'hex');
}

export function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) throw new Error('Cannot encrypt an empty session');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decrypt(payload) {
  if (typeof payload !== 'string') throw new Error('Encrypted session is missing');
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported encrypted session format');

  const [, ivPart, tagPart, dataPart] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}
