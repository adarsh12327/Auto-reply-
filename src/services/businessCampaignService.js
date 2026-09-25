import { BusinessCampaign, CampaignRecipient } from '../models/campaigns.js';
import { BusinessRecipient } from '../models/recipients.js';
import { Account } from '../db.js';
import { ensureAccountClient, canPost, sendAuthorizedMessage } from './telegramClient.js';
import { getBusinessSettings } from './businessSettings.js';
import { logger } from '../logger.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isFloodWait(error) {
  const text = String(error?.message || error?.errorMessage || '');
  const m = text.match(/FLOOD_WAIT[_ ]?(\d+)/i);
  return m ? Number(m[1]) : 0;
}

export async function createCampaign({ ownerId, accountIds, type, message, targetIds, delayMs, templateId = null }) {
  if (!Array.isArray(accountIds) || !accountIds.length) throw new Error('Select at least one account.');
  if (!message?.trim()) throw new Error('Campaign message is required.');
  if (!Array.isArray(targetIds) || !targetIds.length) throw new Error('No eligible recipients or groups selected.');

  const accounts = await Account.find({ ownerId, _id: { $in: accountIds }, status: 'connected' }).select('_id').lean();
  if (!accounts.length) throw new Error('No connected selected accounts.');

  const campaign = await BusinessCampaign.create({
    ownerId,
    accountIds: accounts.map(a => a._id),
    type,
    message: message.slice(0, 4096),
    targetIds: targetIds.map(String),
    delayMs: Math.max(1000, Number(delayMs) || 20000),
    messageTemplateId: templateId,
    stats: { total: targetIds.length * accounts.length, sent: 0, failed: 0, skipped: 0 }
  });

  const recipients = [];
  for (const account of accounts) {
    for (const targetId of targetIds) {
      recipients.push({
        campaignId: campaign._id,
        ownerId,
        accountId: account._id,
        targetId: String(targetId)
      });
    }
  }
  await CampaignRecipient.insertMany(recipients, { ordered: false });
  return campaign;
}

export async function processCampaignBatch(campaignId, encryptionKey, batchSize = 8) {
  const campaign = await BusinessCampaign.findOne({
    _id: campaignId,
    status: { $in: ['draft', 'running', 'paused'] }
  });
  if (!campaign) return { done: true };

  if (campaign.status === 'paused') return { done: false, paused: true };

  campaign.status = 'running';
  campaign.startedAt = campaign.startedAt || new Date();
  await campaign.save();

  const pending = await CampaignRecipient.find({
    campaignId: campaign._id,
    status: 'pending'
  }).sort({ createdAt: 1 }).limit(batchSize);

  if (!pending.length) {
    campaign.status = 'completed';
    campaign.completedAt = new Date();
    await campaign.save();
    return { done: true, campaign };
  }

  const settings = await getBusinessSettings();
  const maxDelay = Math.max(1000, Number(campaign.delayMs || settings.defaultCampaignDelayMs) || 20000);
  let stoppedForRateLimit = false;

  for (const item of pending) {
    const account = await Account.findOne({
      _id: item.accountId,
      ownerId: campaign.ownerId,
      status: 'connected'
    }).select('+sessionEncrypted +apiHashEncrypted +phoneEncrypted');

    if (!account) {
      await CampaignRecipient.updateOne(
        { _id: item._id, status: 'pending' },
        { $set: { status: 'skipped', lastError: 'Account unavailable' }, $inc: { attempts: 1 } }
      );
      await BusinessCampaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.skipped': 1 } });
      continue;
    }

    try {
      const client = await ensureAccountClient(account._id, encryptionKey);
      if (campaign.type === 'group' && !(await canPost(client, item.targetId))) {
        await CampaignRecipient.updateOne({ _id: item._id, status: 'pending' }, { $set: { status: 'skipped', lastError: 'Posting permission unavailable' }, $inc: { attempts: 1 } });
        await BusinessCampaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.skipped': 1 } });
      } else if (campaign.type === 'dm') {
        const eligible = await BusinessRecipient.exists({
          ownerId: campaign.ownerId,
          accountId: account._id,
          telegramUserId: item.targetId,
          authorized: true
        });
        if (!eligible) {
          await CampaignRecipient.updateOne({ _id: item._id, status: 'pending' }, { $set: { status: 'skipped', lastError: 'Recipient is no longer authorized' }, $inc: { attempts: 1 } });
          await BusinessCampaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.skipped': 1 } });
        } else {
          await sendAuthorizedMessage(client, item.targetId, campaign.message);
          await CampaignRecipient.updateOne({ _id: item._id, status: 'pending' }, { $set: { status: 'sent', sentAt: new Date() }, $inc: { attempts: 1 } });
          await BusinessCampaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.sent': 1 } });
        }
      } else {
        const entity = await client.getEntity(item.targetId);
        await client.sendMessage(entity, { message: campaign.message });
        await CampaignRecipient.updateOne({ _id: item._id, status: 'pending' }, { $set: { status: 'sent', sentAt: new Date() }, $inc: { attempts: 1 } });
        await BusinessCampaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.sent': 1 } });
      }
    } catch (error) {
      const wait = isFloodWait(error);
      await CampaignRecipient.updateOne(
        { _id: item._id, status: 'pending' },
        { $set: { status: 'failed', lastError: String(error?.message || error).slice(0, 500) }, $inc: { attempts: 1 } }
      );
      await BusinessCampaign.updateOne(
        { _id: campaign._id },
        { $inc: { 'stats.failed': 1 }, $set: wait ? { status: 'paused', lastError: 'Telegram rate limit: wait ' + wait + ' seconds' } : {} }
      );
      logger.warn('Business campaign delivery failed', { campaignId: String(campaign._id), targetId: item.targetId, error: error?.message });
      if (wait) {
        stoppedForRateLimit = true;
        break;
      }
    }

    if (!stoppedForRateLimit) await sleep(maxDelay);
  }

  const remaining = await CampaignRecipient.countDocuments({ campaignId: campaign._id, status: 'pending' });
  const fresh = await BusinessCampaign.findById(campaign._id);

  if (remaining === 0 && fresh?.status === 'running') {
    fresh.status = 'completed';
    fresh.completedAt = new Date();
    await fresh.save();
    return { done: true, campaign: fresh };
  }

  return { done: false, campaign: fresh, remaining, rateLimited: stoppedForRateLimit };
}

export async function pauseBusinessCampaign(ownerId, id) {
  return BusinessCampaign.findOneAndUpdate({ _id: id, ownerId, status: { $in: ['running', 'scheduled'] } }, { $set: { status: 'paused', pausedAt: new Date() } }, { new: true });
}

export async function resumeBusinessCampaign(ownerId, id) {
  return BusinessCampaign.findOneAndUpdate({ _id: id, ownerId, status: 'paused' }, { $set: { status: 'running', lastError: '' } }, { new: true });
}

export async function stopBusinessCampaign(ownerId, id) {
  return BusinessCampaign.findOneAndUpdate({ _id: id, ownerId, status: { $nin: ['completed', 'cancelled'] } }, { $set: { status: 'cancelled' } }, { new: true });
}
