import { Markup } from 'telegraf';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Wallet, WalletTransaction } from '../models/wallet.js';
import { RedeemCode, RedeemRedemption } from '../models/redeem.js';
import { UiState } from '../models/uiState.js';
import { getBusinessSettings } from '../services/businessSettings.js';
import { ensureWallet, changeWallet } from '../services/walletService.js';

const key = 'wallet_flow';

async function edit(ctx, text, keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Dashboard','main_menu')]])) {
  try { await ctx.editMessageText(text, keyboard); } catch {}
}

export function registerWalletHandlers(bot) {
  bot.action('feature_redeem', async ctx => {
    await ctx.answerCbQuery();
    await UiState.findOneAndUpdate(
      { ownerId: ctx.from.id, key },
      { $set: { data: { step: 'redeem' }, expiresAt: new Date(Date.now()+10*60*1000) } },
      { upsert: true }
    );
    await edit(ctx, '🎁 <b>REDEEM CODE</b>\n\nSend your redeem code.');
  });

  bot.action('wallet', async ctx => {
    await ctx.answerCbQuery();
    const wallet = await ensureWallet(ctx.from.id);
    const txs = await WalletTransaction.find({ ownerId: ctx.from.id }).sort({ createdAt: -1 }).limit(10).lean();
    const lines = txs.length ? txs.map(t => t.type + ' · ' + (t.amount >= 0 ? '+' : '') + t.amount + ' · ' + t.status).join('\n') : 'No transactions yet.';
    await edit(ctx, '💰 <b>WALLET</b>\n\nBalance: ₹' + Number(wallet.balance || 0).toFixed(2) + '\n\n' + lines, Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add Balance', 'wallet_add')],
      [Markup.button.callback('🎁 Redeem Code', 'feature_redeem')],
      [Markup.button.callback('⬅️ Dashboard', 'main_menu')]
    ]));
  });

  bot.action('wallet_add', async ctx => {
    await ctx.answerCbQuery();
    const s = await getBusinessSettings();
    await edit(ctx,
      '➕ <b>ADD BALANCE</b>\n\nUPI: <code>' + String(s.upiId || 'Not configured') + '</code>\n\n' +
      String(s.paymentInstructions || '') + '\n\n' +
      'For now, balance credits require manual admin verification. Send the amount and transaction reference.',
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Wallet', 'wallet')]])
    );
  });

  bot.on('text', async (ctx, next) => {
    const state = await UiState.findOne({ ownerId: ctx.from.id, key, expiresAt: { $gt: new Date() } });
    if (!state) return next();
    const text = String(ctx.message.text || '').trim();
    if (text === '/cancel') {
      await UiState.deleteOne({ _id: state._id });
      await ctx.reply('❌ Cancelled.');
      return;
    }
    if (state.data?.step === 'redeem') {
      const code = text.toUpperCase();
      const session = await mongoose.startSession();
      try {
        let amount = null;
        let txId = null;
        await session.withTransaction(async () => {
          const row = await RedeemCode.findOneAndUpdate(
            {
              code,
              active: true,
              $expr: { $lt: ['$usageCount', '$usageLimit'] },
              $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
            },
            { $inc: { usageCount: 1 } },
            { new: true, session }
          );
          if (!row) throw new Error('Invalid, expired, disabled or exhausted redeem code.');

          const existing = await RedeemRedemption.findOne({ codeId: row._id, ownerId: ctx.from.id }).session(session);
          if (existing) throw new Error('This redeem code has already been used by this account.');

          txId = 'REDEEM_' + crypto.randomBytes(8).toString('hex');
          amount = Number(row.amount);
          await RedeemRedemption.create([{ codeId: row._id, ownerId: ctx.from.id, transactionId: txId }], { session });

          const wallet = await Wallet.findOneAndUpdate(
            { ownerId: ctx.from.id },
            { $setOnInsert: { ownerId: ctx.from.id, balance: 0 } },
            { upsert: true, new: true, session }
          );
          wallet.balance += amount;
          await wallet.save({ session });
          await WalletTransaction.create([{
            transactionId: txId,
            ownerId: ctx.from.id,
            amount,
            type: 'redeem',
            status: 'completed',
            reference: code,
            description: 'Redeem code credit',
            balanceAfter: wallet.balance
          }], { session });
        });
        await UiState.deleteOne({ _id: state._id });
        await ctx.reply('✅ Redeem successful.\n\nCredited: ₹' + amount + '\nTransaction: ' + txId);
      } catch (error) {
        await ctx.reply('❌ ' + (error.message || 'Redeem failed.'));
      } finally {
        await session.endSession();
      }
      return;
    }
    return next();
  });
}
