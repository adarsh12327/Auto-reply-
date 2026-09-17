import { Telegraf, Markup } from 'telegraf';
import { User, Account, setting } from './db.js';
import { beginLogin, submitCode, submitPassword, cancelLogin, setAutoReply, removeAccount, getPending } from './userClient.js';

const bot=new Telegraf(process.env.BOT_TOKEN);
const state=new Map();
const support=process.env.SUPPORT_URL||'https://t.me/';

const menu=()=>Markup.inlineKeyboard([
 [Markup.button.callback('📨 Start Campaign','campaign'),Markup.button.callback('📢 Channel Promo','promo')],
 [Markup.button.callback('💬 Set Auto Reply','autoreply'),Markup.button.callback('📊 Ads Logs','adslogs')],
 [Markup.button.callback('📝 Set Message','setmsg'),Markup.button.callback('👁 Preview Message','preview')],
 [Markup.button.callback('📈 My Stats','stats'),Markup.button.callback('👤 My Account','account')],
 [Markup.button.callback('⭐ VIP Premium','vip'),Markup.button.callback('🎟 Redeem Code','redeem')],
 [Markup.button.callback('➕ Add Account','add'),Markup.button.callback('➖ Remove Account','remove')],
 [Markup.button.callback('🔗 Refer & Earn','refer')],
 [Markup.button.callback('📖 How to Use','help'),Markup.button.url('🆘 Support',support)],
 [Markup.button.url('↗ Create Your Own Bot','https://t.me/BotFather')]
]);

async function ensureUser(ctx,ref){
 const id=String(ctx.from.id); let u=await User.findOne({telegramId:id});
 if(!u){u=new User({telegramId:id,username:ctx.from.username,firstName:ctx.from.first_name});
  if(ref&&ref!==id){const r=await User.findOne({telegramId:ref});if(r){u.referrerId=ref;r.referrals+=1;await r.save();}}
  await u.save();
 } return u;
}
async function home(ctx){return ctx.reply('🏠 *Main Menu*\n\nManage your connected Telegram account, one-time DM auto replies, opt-in campaigns and referrals.',{parse_mode:'Markdown',...menu()});}
function setAction(id,action,data={}){state.set(String(id),{action,...data});}

bot.start(async ctx=>{const p=ctx.startPayload||'';await ensureUser(ctx,p.startsWith('ref_')?p.slice(4):null);await home(ctx);});
bot.command('menu',home);
bot.command('subscribe',async ctx=>{await ensureUser(ctx);await User.updateOne({telegramId:String(ctx.from.id)},{$set:{subscribed:true}});ctx.reply('✅ Campaign subscription enabled.');});
bot.command('unsubscribe',async ctx=>{await User.updateOne({telegramId:String(ctx.from.id)},{$set:{subscribed:false}});ctx.reply('✅ Campaign subscription disabled.');});

bot.action('cancel',async ctx=>{state.delete(String(ctx.from.id));await cancelLogin(ctx.from.id);await ctx.answerCbQuery();await ctx.reply('❌ Cancelled.');});
bot.action('help',async ctx=>{await ctx.answerCbQuery();await ctx.reply('📖 *How to use*\n\n1. Add Account and complete Telegram login.\n2. Set Auto Reply and enable it.\n3. Each incoming private sender gets the reply only once.\n4. Campaigns are restricted to users who explicitly subscribed with /subscribe.',{parse_mode:'Markdown',...menu()});});
bot.action('add',async ctx=>{await ctx.answerCbQuery();setAction(ctx.from.id,'phone');await ctx.reply('📱 Send your own Telegram phone number in international format, e.g. +919876543210.');});

bot.action('autoreply',async ctx=>{await ctx.answerCbQuery();const a=await Account.findOne({ownerId:String(ctx.from.id)});if(!a)return ctx.reply('❌ Add an account first.');await ctx.reply(`💬 *Auto Reply*\n\nStatus: ${a.autoReply?'ON':'OFF'}\nText: ${a.replyText||'(not set)'}`,{parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.callback('✏️ Set Text','replytext'),Markup.button.callback(a.autoReply?'⏹ Disable':'▶️ Enable','toggleReply')],[Markup.button.callback('🗑 Delete','delreply'),Markup.button.callback('⬅️ Back','back')]])});});
bot.action('replytext',async ctx=>{await ctx.answerCbQuery();setAction(ctx.from.id,'replytext');await ctx.reply('✉️ Send the exact auto-reply text. It will be sent only once to each private sender.');});
bot.action('toggleReply',async ctx=>{const a=await Account.findOne({ownerId:String(ctx.from.id)});if(!a)return ctx.reply('❌ No account.');if(!a.replyText)return ctx.reply('❌ Set reply text first.');await setAutoReply(a._id,!a.autoReply);await ctx.answerCbQuery();await ctx.reply(`✅ Auto Reply ${!a.autoReply?'enabled':'disabled'}.`);});
bot.action('delreply',async ctx=>{const a=await Account.findOne({ownerId:String(ctx.from.id)});if(a)await setAutoReply(a._id,false,'');await ctx.answerCbQuery('Deleted');await ctx.reply('🗑 Auto reply deleted.');});

bot.action('account',async ctx=>{const a=await Account.find({ownerId:String(ctx.from.id)}).lean();await ctx.answerCbQuery();if(!a.length)return ctx.reply('👤 No connected account.');await ctx.reply('👤 *Connected Accounts*\n\n'+a.map((x,i)=>`${i+1}. ${x.phone} — Auto Reply: ${x.autoReply?'ON':'OFF'}`).join('\n'),{parse_mode:'Markdown',...menu()});});
bot.action('remove',async ctx=>{const a=await Account.find({ownerId:String(ctx.from.id)});if(!a.length)return ctx.reply('No account to remove.');for(const x of a)await removeAccount(x._id);await ctx.answerCbQuery();await ctx.reply('✅ Connected account(s) removed.');});
bot.action('stats',async ctx=>{const u=await User.findOne({telegramId:String(ctx.from.id)});const accounts=await Account.countDocuments({ownerId:String(ctx.from.id)});await ctx.answerCbQuery();await ctx.reply(`📈 *My Stats*\n\n👥 Referrals: ${u?.referrals||0}\n💰 Referral earned: ₹${u?.referralEarned||0}\n📱 Accounts: ${accounts}`,{parse_mode:'Markdown',...menu()});});
bot.action('refer',async ctx=>{const u=await User.findOne({telegramId:String(ctx.from.id)});const pct=await setting('referral_percent',10);const username=process.env.BOT_USERNAME||ctx.botInfo?.username||'YourBot';await ctx.answerCbQuery();await ctx.reply(`🔗 *Refer & Earn*\n\nhttps://t.me/${username}?start=ref_${u.telegramId}\n\nCommission: ${pct}%\nReferrals: ${u.referrals}\nEarned: ₹${u.referralEarned}`,{parse_mode:'Markdown',...menu()});});
bot.action('vip',async ctx=>{await ctx.answerCbQuery();await ctx.reply('⭐ VIP Premium\n\nPremium plans are intentionally configurable instead of hard-coded.');});
bot.action('redeem',async ctx=>{await ctx.answerCbQuery();setAction(ctx.from.id,'redeem');await ctx.reply('🎟 Send your redeem code.');});
bot.action('promo',async ctx=>{await ctx.answerCbQuery();await ctx.reply('📢 *Channel Promo Builder*\n\nSend a channel username or invite link. This build formats promo text but does not send unsolicited bulk promotions.',{parse_mode:'Markdown'});});
bot.action('setmsg',async ctx=>{await ctx.answerCbQuery();setAction(ctx.from.id,'setmsg');await ctx.reply('📝 Send the campaign message.');});
bot.action('preview',async ctx=>{const s=state.get(String(ctx.from.id));await ctx.answerCbQuery();await ctx.reply(`👁 *Preview*\n\n${s?.campaignMessage||'No campaign message saved in the current session.'}`,{parse_mode:'Markdown'});});
bot.action('adslogs',async ctx=>{await ctx.answerCbQuery();await ctx.reply('📊 Ads logs are a placeholder. Connect a compliant ad provider before monetizing.');});
bot.action('back',async ctx=>{await ctx.answerCbQuery();await home(ctx);});
bot.action('campaign',async ctx=>{const u=await User.findOne({telegramId:String(ctx.from.id)});await ctx.answerCbQuery();if(!u?.subscribed)return ctx.reply('📨 First use /subscribe to opt into campaigns.');setAction(ctx.from.id,'campaign');await ctx.reply('📨 Send the campaign message. Delivery to non-consenting users is disabled.');});

bot.on('text',async ctx=>{
 const id=String(ctx.from.id),s=state.get(id);if(!s)return;
 try{
  if(s.action==='phone'){
   const st=await beginLogin(id,ctx.message.text.trim());setAction(id,'code');
   await ctx.reply('📨 Login started. Send the OTP code received from Telegram.');
   st.promise.then(()=>ctx.reply('✅ Telegram account connected successfully.')).catch(e=>ctx.reply(`❌ Login failed: ${e.message}`));return;
  }
  if(s.action==='code'){
   const st=await submitCode(id,ctx.message.text.trim());setAction(id,'password_wait');
   await new Promise(r=>setTimeout(r,1000));
   const p=getPending(id);if(p?.password){return ctx.reply('🔐 2-step verification is enabled. Send the 2FA password.');}
   return ctx.reply('⏳ Completing login. Please wait for the success message.');
  }
  if(s.action==='password_wait'){
   const p=getPending(id);if(!p?.password)return ctx.reply('⏳ Login is already finishing.');
   await submitPassword(id,ctx.message.text);state.delete(id);return ctx.reply('⏳ Completing login.');
  }
  if(s.action==='replytext'){const a=await Account.findOne({ownerId:id});if(!a)return ctx.reply('❌ No account.');await setAutoReply(a._id,a.autoReply,ctx.message.text);state.delete(id);return ctx.reply('✅ Auto Reply text saved.');}
  if(s.action==='setmsg'||s.action==='campaign'){state.set(id,{action:s.action,campaignMessage:ctx.message.text});return ctx.reply('✅ Campaign message saved for this session.');}
  if(s.action==='redeem'){state.delete(id);return ctx.reply('🎟 Code received. Redeem-code storage can be added by the admin.');}
 }catch(e){state.delete(id);await ctx.reply(`❌ ${e.message}`);}
});

export async function launchBot(){await bot.launch();console.log('Bot started');}
export {bot};
