import { Campaign, Consent, Account } from '../db.js';
import { getClient, canPost, sendAuthorizedMessage } from './telegramClient.js';
import { logger } from '../logger.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const runningCampaigns = new Set();

export async function validateTargets({ ownerId, type, targetIds, requireConsent }) {
  if (!Array.isArray(targetIds) || targetIds.length === 0) throw new Error('No targets selected.');
  if (type !== 'dm' || !requireConsent) return targetIds;

  const allowed = await Consent.find({
    ownerId,
    recipientId: { $in: targetIds },
    active: true
  }).select('recipientId').lean();

  const allowedSet = new Set(allowed.map(x => String(x.recipientId)));
  return targetIds.filter(id => allowedSet.has(String(id)));
}

export async function getAuthorizedDmTargets(ownerId) {
  const rows = await Consent.find({ ownerId, active: true })
    .select('recipientId')
    .sort({ createdAt: 1 })
    .lean();

  return [...new Set(rows.map(row => String(row.recipientId)))];
}

export async function runCampaign(
  campaignId,
  { delayMs = 3000, requireConsent = true, requireGroupPermission = true, onProgress } = {}
) {
  const id = String(campaignId);
  if (runningCampaigns.has(id)) throw new Error('Campaign is already running.');

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found');

  const account = await Account.findById(campaign.accountId).select('+sessionEncrypted');
  if (!account) throw new Error('Account not found');

  const client = getClient(account._id);
  if (!client) throw new Error('Telegram account is not connected');

  let targets = campaign.targetIds || [];

  if (campaign.type === 'dm' && requireConsent) {
    targets = await validateTargets({
      ownerId: campaign.ownerId,
      type: campaign.type,
      targetIds: targets,
      requireConsent
    });

    if (!targets.length) {
      campaign.status = 'failed';
      campaign.stats.total = 0;
      await campaign.save();
      throw new Error('No authorized DM recipients are available.');
    }
  }

  runningCampaigns.add(id);
  try {
    const isResume = campaign.status === 'paused';
    const processed = Number(campaign.stats.sent || 0) +
      Number(campaign.stats.failed || 0) +
      Number(campaign.stats.skipped || 0);
    const startIndex = isResume ? Math.min(targets.length, processed) : 0;

    campaign.status = 'running';
    campaign.stats.total = targets.length;
    if (!isResume) {
      campaign.stats.sent = 0;
      campaign.stats.failed = 0;
      campaign.stats.skipped = 0;
    }
    await campaign.save();

    await onProgress?.(campaign, startIndex, targets.length);

    for (let index = startIndex; index < targets.length; index += 1) {
      const target = targets[index];
      const fresh = await Campaign.findById(campaignId).select('status');
      if (!fresh || fresh.status === 'cancelled' || fresh.status === 'paused') break;

      try {
        if (campaign.type !== 'dm' && requireGroupPermission && !(await canPost(client, target))) {
          campaign.stats.skipped += 1;
        } else {
          await sendAuthorizedMessage(client, target, campaign.message);
          campaign.stats.sent += 1;
        }
      } catch (error) {
        campaign.stats.failed += 1;
        logger.warn('Campaign delivery failed', {
          campaignId: id,
          target,
          error: error?.message
        });
      }

      await campaign.save();

      const currentProcessed = campaign.stats.sent + campaign.stats.failed + campaign.stats.skipped;
      if (currentProcessed === targets.length || currentProcessed % 5 === 0) {
        await onProgress?.(campaign, currentProcessed, targets.length);
      }

      if (index < targets.length - 1) {
        await sleep(Math.max(1000, Number(delayMs) || 3000));
      }
    }

    const finalCampaign = await Campaign.findById(campaignId);
    const finalProcessed = finalCampaign
      ? Number(finalCampaign.stats.sent || 0) +
        Number(finalCampaign.stats.failed || 0) +
        Number(finalCampaign.stats.skipped || 0)
      : 0;

    if (finalCampaign?.status === 'running' && finalProcessed >= targets.length) {
      finalCampaign.status = 'completed';
      await finalCampaign.save();
    }

    const result = finalCampaign || campaign;
    await onProgress?.(result, finalProcessed, targets.length);
    return result;
  } finally {
    runningCampaigns.delete(id);
  }
}

export async function pauseCampaign(campaignId, ownerId) {
  return Campaign.findOneAndUpdate(
    { _id: campaignId, ownerId, status: 'running' },
    { status: 'paused' },
    { new: true }
  );
}

export async function cancelCampaign(campaignId, ownerId) {
  return Campaign.findOneAndUpdate(
    { _id: campaignId, ownerId, status: { $in: ['running', 'paused', 'draft'] } },
    { status: 'cancelled' },
    { new: true }
  );
}
