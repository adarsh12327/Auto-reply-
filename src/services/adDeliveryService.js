import { AdCampaign, AdDelivery } from '../models/ads.js';
import { AdParticipant } from '../models/adParticipants.js';
import { BusinessRecipient } from '../models/recipients.js';
import { Account } from '../db.js';
import { ensureAccountClient, sendAuthorizedMessage } from './telegramClient.js';
import { changeWallet } from './walletService.js';
import { logger } from '../logger.js';

function adText(ad) {
  return ad.link ? ad.message + '\n\n🔗 ' + ad.link : ad.message;
}

export async function processAdBatch(encryptionKey, batchSize = 5) {
  const ads = await AdCampaign.find({ status: 'approved', paymentStatus: 'approved', remaining: { $gt: 0 } })
    .sort({ approvedAt: 1, createdAt: 1 }).limit(3).lean();
  const results = [];

  for (const ad of ads) {
    const participants = await AdParticipant.find({ enabled: true, approved: true }).limit(20).lean();
    let processed = 0;

    for (const participant of participants) {
      if (processed >= batchSize || ad.remaining <= 0) break;

      const account = await Account.findOne({
        _id: participant.accountId,
        ownerId: participant.ownerId,
        status: 'connected'
      }).lean();
      if (!account || participant.ownerId === ad.ownerId) continue;

      const recipient = await BusinessRecipient.findOne({
        ownerId: participant.ownerId,
        accountId: participant.accountId,
        authorized: true,
        telegramUserId: { $exists: true, $ne: String(ad.ownerId) }
      }).sort({ lastIncomingAt: -1 }).lean();
      if (!recipient) continue;

      const existing = await AdDelivery.findOne({
        adId: ad._id,
        accountId: participant.accountId,
        targetId: recipient.telegramUserId
      }).lean();
      if (existing) continue;

      const delivery = await AdDelivery.create({
        adId: ad._id,
        deliveryOwnerId: participant.ownerId,
        accountId: participant.accountId,
        targetId: String(recipient.telegramUserId),
        status: 'pending'
      });

      try {
        const client = await ensureAccountClient(account._id, encryptionKey);
        await sendAuthorizedMessage(client, recipient.telegramUserId, adText(ad));

        const earning = Math.round((Number(ad.price) / Math.max(1, Number(ad.targetCount))) * (Number(ad.earningPercent || 0) / 100) * 100) / 100;
        await AdDelivery.updateOne({ _id: delivery._id, status: 'pending' }, {
          $set: { status: 'sent', processedAt: new Date(), earning }
        });
        await AdCampaign.updateOne({ _id: ad._id, status: 'approved', remaining: { $gt: 0 } }, {
          $inc: { successful: 1, remaining: -1 }
        });

        if (earning > 0) {
          await changeWallet({
            ownerId: participant.ownerId,
            amount: earning,
            type: 'ad_earning',
            reference: String(ad._id),
            transactionId: 'AD_EARN_' + String(delivery._id),
            description: 'Ad delivery earning'
          });
          await AdDelivery.updateOne({ _id: delivery._id }, { $set: { earningCredited: true } });
        }

        processed += 1;
      } catch (error) {
        await AdDelivery.updateOne({ _id: delivery._id, status: 'pending' }, {
          $set: { status: 'failed', processedAt: new Date(), error: String(error?.message || error).slice(0, 500) }
        });
        await AdCampaign.updateOne({ _id: ad._id }, { $inc: { failed: 1 } });
        logger.warn('Ad delivery failed', { adId: String(ad._id), accountId: String(account._id), error: error?.message });
      }
    }

    const fresh = await AdCampaign.findById(ad._id);
    if (fresh && fresh.remaining <= 0) {
      fresh.status = 'completed';
      fresh.completedAt = new Date();
      await fresh.save();
    }
    results.push({ adId: String(ad._id), processed, remaining: fresh?.remaining ?? ad.remaining });
  }

  return results;
}
