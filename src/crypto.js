import crypto from 'node:crypto';

function key(){
  const raw=process.env.SESSION_ENCRYPTION_KEY;
  if(!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('SESSION_ENCRYPTION_KEY must be 64 hex characters');
  return Buffer.from(raw,'hex');
}
export function encrypt(text){
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);
  const data=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return [iv.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join('.');
}
export function decrypt(value){
  const [iv,tag,data]=value.split('.');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64'));
  decipher.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString('utf8');
}
