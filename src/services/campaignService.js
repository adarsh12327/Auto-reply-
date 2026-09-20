import { Campaign, Consent, Account } from '../db.js';
import { getClient, canPost, sendAuthorizedMessage } from './telegramClient.js';
import { logger } from '../logger.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const runningCampaigns = new Set();

function processedCount(campaign) {
  return Number(campaign?.stats?.sent || 0) +
    Number(campaign?.stats?.failed || 0) +
    Number(campaign?.stats?.skipped || 0);
}

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
  const rows = await Consent.find({
    ownerId,
    active: true
  }).select('recipientId').sort({ createdAt: 1 }).lean();

  return [...new Set(rows.map(row => String(row.recipientId)))];
}

export async function runCampaign(
  campaignId,
  { delayMs = 3000, requireConsent = true, requireGroupPermission = true, onProgress } = {}
) {
  const id = String(campaignId);
  if (runningCampaigns.has(id)) throw new Error('Campaign is already running.');

  let campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found');

  const account = await Account.findById(campaign.accountId).select('+sessionEncrypted');
  if (!account) throw new Error('Account not found');

  const client = getClient(account._id);
  if (!client) throw new Error('Telegram account is not connected');

  const effectiveDelayMs = Math.max(1000, Number(campaign.delayMs || delayMs) || 3000);

  let targets = Array.isArray(campaign.targetIds) ? campaign.targetIds.map(String) : [];

  if (campaign.type === 'dm' && requireConsent) {
    if (campaign.status === 'paused') {
      // Keep the original target order on resume so progress indexes stay stable.
      if (!targets.length) throw new Error('No authorized DM recipients are available.');
    } else {
      targets = await validateTargets({
        ownerId: campaign.ownerId,
        type: campaign.type,
        targetIds: targets,
        requireConsent
      });
    }

    if (!targets.length) {
      await Campaign.findByIdAndUpdate(campaignId, {
        $set: { status: 'failed', 'stats.total': 0 }
      });
      throw new Error('No authorized DM recipients are available.');
    }
  }

  runningCampaigns.add(id);
  try {
    const isResume = campaign.status === 'paused';
    const initialProcessed = processedCount(campaign);
    const startIndex = isResume ? Math.min(targets.length, initialProcessed) : 0;

    if (!isResume) {
      campaign = await Campaign.findByIdAndUpdate(
        campaignId,
        {
          $set: {
            status: 'running',
            targetIds: targets,
            'stats.total': targets.length,
            'stats.sent': 0,
            'stats.failed': 0,
            'stats.skipped': 0
          }
        },
        { new: true }
      );
    } else {
      campaign = await Campaign.findByIdAndUpdate(
        campaignId,
        { $set: { status: 'running', 'stats.total': targets.length } },
        { new: true }
      );
    }

    await onProgress?.(campaign, startIndex, targets.length);

    for (let index = startIndex; index < targets.length; index += 1) {
      const fresh = await Campaign.findById(campaignId);
      if (!fresh || fresh.status === 'cancelled' || fresh.status === 'paused') break;

      const target = targets[index];
      let result = 'sent';

      try {
        if (
          campaign.type === 'dm' &&
          requireConsent &&
          !(await Consent.exists({
            ownerId: campaign.ownerId,
            recipientId: target,
            active: true
          }))
        ) {
          result = 'skipped';
        } else if (
          campaign.type !== 'dm' &&
          requireGroupPermission &&
          !(await canPost(client, target))
        ) {
          result = 'skipped';
        } else {
          await sendAuthorizedMessage(client, target, campaign.message);
        }
      } catch (error) {
        result = 'failed';
        logger.warn('Campaign delivery failed', {
          campaignId: id,
          target,
          error: error?.message
        });
      }

      const inc = {};
      inc[`stats.${result}`] = 1;

      campaign = await Campaign.findByIdAndUpdate(
        campaignId,
        { $inc: inc },
        { new: true }
      );

      if (!campaign) break;

      const currentProcessed = processedCount(campaign);
      if (currentProcessed === targets.length || currentProcessed % 5 === 0) {
        await onProgress?.(campaign, currentProcessed, targets.length);
      }

      if (index < targets.length - 1) {
        await sleep(effectiveDelayMs);
      }
    }

    const finalCampaign = await Campaign.findById(campaignId);
    const finalProcessed = processedCount(finalCampaign);

    if (
      finalCampaign?.status === 'running' &&
      finalProcessed >= targets.length
    ) {
      campaign = await Campaign.findByIdAndUpdate(
        campaignId,
        { $set: { status: 'completed' } },
        { new: true }
      );
    } else {
      campaign = finalCampaign;
    }

    await onProgress?.(
      campaign,
      processedCount(campaign),
      targets.length
    );

    return campaign;
  } finally {
    runningCampaigns.delete(id);
  }
}

export async function pauseCampaign(campaignId, ownerId) {
  return Campaign.findOneAndUpdate(
    { _id: campaignId, ownerId, status: 'running' },
    { $set: { status: 'paused' } },
    { new: true }
  );
}

export async function cancelCampaign(campaignId, ownerId) {
  return Campaign.findOneAndUpdate(
    {
      _id: campaignId,
      ownerId,
      status: { $in: ['running', 'paused', 'draft'] }
    },
    { $set: { status: 'cancelled' } },
    { new: true }
  );
}
