import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Account, ReplyLog } from './db.js';
import { encrypt,decrypt } from './crypto.js';

const clients=new Map();
const loggers=new Map();
const pending=new Map();
const apiId=Number(process.env.API_ID);
const apiHash=process.env.API_HASH;
export function getPending(userId){return pending.get(String(userId));}

async function attachAutoReply(client,account){
 const key=String(account._id); if(loggers.has(key)) client.removeEventHandler(loggers.get(key));
 const handler=async event=>{
  try{
   if(!account.autoReply||!account.replyText||event.message.out||!event.isPrivate)return;
   const peer=String(event.message.senderId??''); if(!peer)return;
   if(await ReplyLog.findOne({accountId:account._id,peerId:peer}))return;
   await client.sendMessage(peer,{message:account.replyText});
   await ReplyLog.create({accountId:account._id,peerId:peer});
  }catch(err){console.error('auto-reply error:',err.message);}
 };
 client.addEventHandler(handler,new NewMessage({incoming:true})); loggers.set(key,handler);
}

export async function loadAccounts(){
 for(const account of await Account.find())try{
  const client=new TelegramClient(new StringSession(decrypt(account.session)),apiId,apiHash,{connectionRetries:5});
  await client.connect(); if(await client.checkAuthorization()){clients.set(String(account._id),client);await attachAutoReply(client,account);}
 }catch(e){console.error('account load failed',account._id,e.message);}
}

export async function beginLogin(ownerId,phone){
 if(!apiId||!apiHash)throw new Error('API_ID/API_HASH missing');
 const client=new TelegramClient(new StringSession(''),apiId,apiHash,{connectionRetries:5});
 const state={ownerId:String(ownerId),phone,client,code:null,password:null,error:null}; pending.set(String(ownerId),state);
 state.promise=client.start({
  phoneNumber:async()=>phone,
  phoneCode:async()=>new Promise((resolve,reject)=>{state.code={resolve,reject};}),
  password:async()=>new Promise((resolve,reject)=>{state.password={resolve,reject};}),
  onError:async err=>{state.error=err;return false;}
 }).then(async()=>{
  const session=client.session.save(); let account=await Account.findOne({ownerId:String(ownerId),phone});
  if(!account)account=new Account({ownerId:String(ownerId),phone});
  account.session=encrypt(session); account.autoReply=false; await account.save();
  clients.set(String(account._id),client); await attachAutoReply(client,account); pending.delete(String(ownerId)); return account;
 }).catch(err=>{state.error=err;throw err;});
 await new Promise(r=>setTimeout(r,1200)); return state;
}
export async function submitCode(ownerId,code){const s=pending.get(String(ownerId));if(!s?.code)throw new Error('No code request is waiting');s.code.resolve(String(code));s.code=null;return s;}
export async function submitPassword(ownerId,password){const s=pending.get(String(ownerId));if(!s?.password)throw new Error('No 2FA request is waiting');s.password.resolve(String(password));s.password=null;return s;}
export async function cancelLogin(ownerId){const s=pending.get(String(ownerId));if(s){try{await s.client.disconnect();}catch{}pending.delete(String(ownerId));}}
export async function setAutoReply(accountId,enabled,text){const a=await Account.findById(accountId);if(!a)throw new Error('Account not found');a.autoReply=enabled;if(text!==undefined)a.replyText=text;await a.save();const c=clients.get(String(accountId));if(c)await attachAutoReply(c,a);return a;}
export async function removeAccount(accountId){const c=clients.get(String(accountId));if(c){try{await c.disconnect();}catch{}}clients.delete(String(accountId));loggers.delete(String(accountId));await Account.findByIdAndDelete(accountId);}
