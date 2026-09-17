import { Telegraf, Markup } from 'telegraf';
import { User, Account, setting, setSetting } from './db.js';
import { beginLogin, submitCode, submitPassword, cancelLogin, setAutoReply, removeAccount, getPending } from './userClient.js';

const bot=new Telegraf(process.env.BOT_TOKEN);
const state=new Map();
const admins=new Set((process.env.ADMIN_IDS||'').split(',').map(x=>x.trim()).filter(Boolean));
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
   if(ref && ref!==id){const r=await User.findOne({telegramId:ref}); if(r){u.referrerId=ref; r.referrals+=1; await r.save();}}
   await u.save();
 } return u;
}
async function home(ctx){ return ctx.reply('🏠 *Main Menu*\n\nManage your connected Telegram account, one-time DM auto replies, campaigns for opted-in users, referrals and account settings.',{parse_mode:'Markdown',...menu()}); }
function prompt(ctx,text){state.set(String(ctx.from.id),{action:text}); return ctx.reply(text,Markup.inlineKeyboard([[Markup.button.callback('Cancel','cancel')]]));}

bot.start(async ctx=>{const p=ctx.startPayload||'';const ref=p.startsWith('ref_')?p.slice(4):null;await ensureUser(ctx,ref);await home(ctx);});
bot.command('menu',home);
bot.command('subscribe',async ctx=>{await User.updateOne({telegramId:String(ctx.from.id)},{$set:{subscribed:true}});ctx.reply('✅ Campaign subscription enabled. You can disable it with /unsubscribe.');});
bot.command('unsubscribe',async ctx=>{await User.updateOne({telegramId:String(ctx.from.id)},{$set:{subscribed:false}});ctx.reply('✅ Campaign subscription disabled.');});

bot.action('cancel',async ctx=>{state.delete(String(ctx.from.id));await cancelLogin(ctx.from.id);await ctx.answerCbQuery();await ctx.reply('❌ Cancelled.');});
bot.action('help',async ctx=>{await ctx.answerCbQuery();await ctx.reply('📖 *How to use*\n1. Add Account and complete Telegram login.\n2. Set Auto Reply and enable it.\n3. The reply is sent only once to each private sender.\n4. Campaigns can target only users who explicitly subscribed with /subscribe.',{parse_mode:'Markdown',...menu()});});
bot.action('add',async ctx=>{await ctx.answerCbQuery();state.set(String(ctx.from.id),{action:'phone'});await ctx.reply('📱 Send the phone number of your own Telegram account in international format, e.g. +919876543210.\n\nNever send your Telegram password or login code to anyone except this bot you control.',Markup.inlineKeyboard([[Markup.button.callback('Cancel','cancel')]]));});
bot.action('autoreply',async ctx=>{await ctx.answerCbQuery();const accounts=await Account.find({ownerId:String(ctx.from.id)});if(!accounts.length)return ctx.reply('❌ Add an account first.');const a=accounts[0];await ctx.reply(`💬 *Auto Reply*\n\nCurrent: ${a.autoReply?'ON':'OFF'}\nText: ${a.replyText||'(not set)'}`,{parse_mode:'Markdown',...Markup.inlineKeyboard([[Markup.button.callback('✏️ Set Text','replytext'),Markup.button.callback(a.autoReply?'⏹ Disable':'▶️ Enable','toggleReply')],[Markup.button.callback('🗑 Delete','delreply'),Markup.button.callback('⬅️ Back','back')]])});});
bot.action('replytext',async ctx=>{await ctx.answerCbQuery();state.set(String(ctx.from.id),{action:'replytext'});await ctx.reply('✉️ Send the exact auto-reply text. It will be used only for incoming private DMs and only once per sender.');});
bot.action('toggleReply',async ctx=>{await ctx.answerCbQuery();const a=await Account.findOne({ownerId:String(ctx.from.id)});if(!a)return ctx.reply('❌ No account.');if(!a.replyText)return ctx.reply('❌ Set reply text first.');await setAutoReply(a._id,!a.autoReply);await ctx.reply(`✅ Auto Reply ${!a.autoReply?'enabled':'disabled'}.`);});
bot.action('delreply',async ctx=>{const a=await Account.findOne({ownerId:String(ctx.from.id)});if(a)await setAutoReply(a._id,false,'');await ctx.answerCbQuery('Deleted');await ctx.reply('🗑 Auto reply deleted.');});

bot.action('account',async ctx=>{await ctx.answerCbQuery();const a=await Account.find({ownerId:String(ctx.from.id)}).lean();if(!a.length)return ctx.reply('👤 No connected account.');await ctx.reply('👤 *Connected Accounts*\n\n'+a.map((x,i)=>`${i+1}. ${x.phone} — Auto Reply: ${x.autoReply?'ON':'OFF'}`).join('\n'),{parse_mode:'Markdown',...menu()});});
bot.action('remove',async ctx=>{const a=await Account.find({ownerId:String(ctx.from.id)});if(!a.length)return ctx.reply('No account to remove.');for(const x of a)await removeAccount(x._id);await ctx.answerCbQuery();await ctx.reply('✅ Connected account(s) removed.');});
bot.action('stats',async ctx=>{const u=await User.findOne({telegramId:String(ctx.from.id)});const accounts=await Account.countDocuments({ownerId:String(ctx.from.id)});await ctx.answerCbQuery();await ctx.reply(`📈 *My Stats*\n\n👥 Referrals: ${u?.referrals||0}\n💰 Referral earned: ₹${u?.referralEarned||0}\n📱 Accounts: ${accounts}`,{parse_mode:'Markdown',...menu()});});
bot.action('refer',async ctx=>{const u=await User.findOne({telegramId:String(ctx.from.id)});const pct=await setting('referral_percent',10);const username=process.env.BOT_USERNAME||ctx.botInfo?.username||'YourBot';await ctx.answerCbQuery();await ctx.reply(`🔗 *Refer & Earn*\n\nYour link:\nhttps://t.me/${username}?start=ref_${u.telegramId}\n\nCommission setting: ${pct}%\nReferrals: ${u.referrals}\nEarned: ₹${u.referralEarned}`,{parse_mode:'Markdown',...menu()});});
bot.action('vip',async ctx=>{await ctx.answerCbQuery();await ctx.reply('⭐ VIP Premium\n\nPlans can be configured by the admin. Payments are intentionally not hard-coded into this starter.');});
bot.action('redeem',async ctx=>{await ctx.answerCbQuery();state.set(String(ctx.from.id),{action:'redeem'});await ctx.reply('🎟 Send your redeem code.');});
bot.action('promo',async ctx=>{await ctx.answerCbQuery();await ctx.reply('📢 *Channel Promo Builder*\n\nSend a public channel username or an invite link and I will format a promo message. Automated unsolicited promotion is disabled.',{parse_mode:'Markdown'});});
bot.action('setmsg',async ctx=>{await ctx.answerCbQuery();await prompt(ctx,'📝 Send the message you want to use for an opted-in campaign.');});
bot.action('preview',async ctx=>{const s=state.get(String(ctx.from.id));await ctx.answerCbQuery();await ctx.reply(`👁 *Preview*\n\n${s?.campaignMessage||'No campaign message set yet.'}`,{parse_mode:'Markdown'});});
bot.action('adslogs',async ctx=>{await ctx.answerCbQuery();await ctx.reply('📊 Ads logs are not enabled in this starter. Add your own compliant ad provider before enabling monetized messages.');});
bot.action('back',async ctx=>{await ctx.answerCbQuery();await home(ctx);});

bot.action('campaign',async ctx=>{await ctx.answerCbQuery();const u=await User.findOne({telegramId:String(ctx.from.id)});if(!u?.subscribed)return ctx.reply('📨 Campaigns are limited to users who explicitly subscribed with /subscribe.');return prompt(ctx,'📨 Send the campaign message. It will be available only for an admin-controlled, opt-in audience.');});

bot.on('text',async ctx=>{
 const id=String(ctx.from.id), s=state.get(id); if(!s) return;
 try{
  if(s.action==='phone'){state.delete(id);const st=await beginLogin(id,ctx.message.text.trim());await ctx.reply('📨 Telegram login started. Send the OTP code you receive here.');return;}
  if(s.action==='replytext'){const a=await Account.findOne({ownerId:id});if(!a)return ctx.reply('❌ No account.');await setAutoReply(a._id,a.autoReply,ctx.message.text);state.delete(id);return ctx.reply('✅ Auto Reply text saved.');}
  if(s.action==='redeem'){state.delete(id);return ctx.reply('🎟 Code received. Redeem-code storage can be connected by the admin.');}
  if(s.action==='campaign' || s.action==='setmsg'){s.campaignMessage=ctx.message.text;state.set(id,s);return ctx.reply('✅ Message saved. Use /subscribe to opt into campaigns; admin delivery can be added after verification.');}
  if(s.action==='code'){await submitCode(id,ctx.message.text.trim());state.delete(id);await new Promise(r=>setTimeout(r,1200));const p=getPending(id);if(p?.password){state.set(id,{action:'password'});return ctx.reply('🔐 This account has 2-step verification. Send the 2FA password.');}return ctx.reply('⏳ Finishing login…');}
  if(s.action==='password'){await submitPassword(id,ctx.message.text);state.delete(id);return ctx.reply('⏳ Finishing login…');}
 }catch(e){state.delete(id);await ctx.reply(`❌ ${e.message}`);}
});

export async function launchBot(){await bot.launch();console.log('Bot started');return bot;}
export {bot};
