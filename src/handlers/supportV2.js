import { Markup } from 'telegraf';
import { SupportTicket, SupportMessage } from '../models/support.js';
import { UiState } from '../models/uiState.js';
import { getBusinessSettings } from '../services/businessSettings.js';
import { AdminUser } from '../models/admin.js';

const key='support_flow';

async function edit(ctx,text,keyboard=Markup.inlineKeyboard([[Markup.button.callback('⬅️ Dashboard','main_menu')]])){try{await ctx.editMessageText(text,keyboard)}catch{}}

export function registerSupportHandlers(bot){
  bot.action('feature_support',async ctx=>{
    await ctx.answerCbQuery();
    const s=await getBusinessSettings();
    await edit(ctx,'🆘 <b>SUPPORT</b>\\n\\nCreate a support ticket and the configured support team can reply through the bot.',Markup.inlineKeyboard([
      [Markup.button.callback('➕ New Ticket','support_new')],
      ...(s.supportUrl?[[Markup.button.url('💬 Open Support',s.supportUrl)]]:[]),
      [Markup.button.callback('📋 My Tickets','support_list')],
      [Markup.button.callback('⬅️ Dashboard','main_menu')]
    ]));
  });

  bot.action('support_new',async ctx=>{
    await ctx.answerCbQuery();
    await UiState.findOneAndUpdate({ownerId:ctx.from.id,key},{ $set:{data:{step:'message'},expiresAt:new Date(Date.now()+15*60*1000)}},{upsert:true});
    await edit(ctx,'🆘 <b>NEW SUPPORT TICKET</b>\\n\\nSend your message.\\n\\n/cancel to stop.');
  });

  bot.action('support_list',async ctx=>{
    await ctx.answerCbQuery();
    const rows=await SupportTicket.find({ownerId:ctx.from.id}).sort({updatedAt:-1}).limit(10).lean();
    await edit(ctx,rows.length?('📋 <b>MY TICKETS</b>\\n\\n'+rows.map((t,i)=>(i+1)+'. '+t._id+' · '+t.status).join('\\n')):'📋 <b>No tickets</b>');
  });

  bot.on('text',async(ctx,next)=>{
    const state=await UiState.findOne({ownerId:ctx.from.id,key,expiresAt:{$gt:new Date()}});
    if(!state)return next();
    const text=String(ctx.message.text||'').trim();
    if(text==='/cancel'){await UiState.deleteOne({_id:state._id});await ctx.reply('❌ Cancelled.');return;}
    if(state.data?.step==='message'){
      const ticket=await SupportTicket.create({ownerId:ctx.from.id,status:'open',subject:'Support request',lastMessageAt:new Date()});
      await SupportMessage.create({ticketId:ticket._id,senderId:ctx.from.id,senderRole:'user',text:text.slice(0,4096)});
      await UiState.deleteOne({_id:state._id});
      const admins=await AdminUser.find({active:true,role:{$in:['owner','super_admin','admin','support']}}).select('telegramId').lean();
      for(const admin of admins) await ctx.telegram.sendMessage(admin.telegramId,'🆘 New support ticket\\n\\nTicket: '+ticket._id+'\\nUser: '+ctx.from.id+'\\n\\n'+text.slice(0,3500)).catch(()=>{});
      await ctx.reply('✅ Support ticket created.\\n\\nTicket ID: '+ticket._id);
      return;
    }
    return next();
  });

  bot.command('supportreply',async ctx=>{
    const admins=await AdminUser.findOne({telegramId:ctx.from.id,active:true}).lean();
    const owner=Number(process.env.OWNER_ID||0)===ctx.from.id || (process.env.ADMIN_IDS||'').split(',').map(Number).includes(ctx.from.id);
    if(!admins && !owner)return ctx.reply('⛔ Support access required.');
    const parts=ctx.message.text.trim().split(/\\s+/);
    const id=parts[1];
    const text=parts.slice(2).join(' ').trim();
    if(!id||!text)return ctx.reply('Usage: /supportreply TICKET_ID MESSAGE');
    const ticket=await SupportTicket.findById(id);
    if(!ticket)return ctx.reply('❌ Ticket not found.');
    await SupportMessage.create({ticketId:ticket._id,senderId:ctx.from.id,senderRole:'support',text:text.slice(0,4096)});
    ticket.status='pending';ticket.lastMessageAt=new Date();await ticket.save();
    await ctx.telegram.sendMessage(ticket.ownerId,'🆘 Support reply\\n\\n'+text.slice(0,4000)).catch(()=>{});
    await ctx.reply('✅ Reply sent.');
  });
}
