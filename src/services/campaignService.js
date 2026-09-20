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

  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found');

  const account = await Account.findById(campaign.accountId).select('+sessionEncrypted');
  if (!account) throw new Error('Account not found');

  const client = getClient(account._id);
  if (!client) throw new Error('Telegram account is not connected');

  let targets = campaign.targetIds || [];

  if (campaign.type === 'dm') {
    if (requireConsent) {
      targets = await validateTargets({
        ownerId: campaign.ownerId,
        type: campaign.type,
        targetIds: targets,
        requireConsent
      });
    }

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
    const startIndex = isResume
      ? Math.min(
          targets.length,
          Number(campaign.stats.sent || 0) +
          Number(campaign.stats.failed || 0) +
          Number(campaign.stats.skipped || 0)
        )
      : 0;

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

      if (
        campaign.stats.sent + campaign.stats.failed + campaign.stats.skipped === targets.length ||
        (campaign.stats.sent + campaign.stats.failed + campaign.stats.skipped) % 5 === 0
      ) {
        await onProgress?.(campaign, index + 1, targets.length);
      }

      if (index < targets.length - 1) {
        await sleep(Math.max(1000, Number(delayMs) || 3000));
      }
    }

    const finalCampaign = await Campaign.findById(campaignId);
    if (finalCampaign?.status === 'running') {
      finalCampaign.status = 'completed';
      await finalCampaign.save();
    }

    const result = finalCampaign || campaign;
    await onProgress?.(result, targets.length, targets.length);
    return result;
  } finally {
    runningCampaigns.delete(id);
  }
}

export async function pauseCampaign(campaignId) {
  return Campaign.findByIdAndUpdate(
    campaignId,
    { status: 'paused' },
    { new: true }
  );
}

export async function cancelCampaign(campaignId) {
  return Campaign.findByIdAndUpdate(
    campaignId,
    { status: 'cancelled' },
    { new: true }
  );
}
