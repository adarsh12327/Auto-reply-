import { Campaign, Consent, Account } from '../db.js';
import { getClient, canPost, sendAuthorizedMessage } from './telegramClient.js';
import { logger } from '../logger.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function validateTargets({ ownerId, type, targetIds, requireConsent }) {
  if (!Array.isArray(targetIds) || targetIds.length === 0) throw new Error('No targets selected.');
  if (type !== 'dm' || !requireConsent) return targetIds;

  const allowed = await Consent.find({
    ownerId,
    recipientId: { $in: targetIds },
    active: true
  }).select('recipientId').lean();

  const allowedSet = new Set(allowed.map(x => x.recipientId));
  return targetIds.filter(id => allowedSet.has(String(id)));
}

export async function runCampaign(campaignId, { delayMs, requireConsent, requireGroupPermission }) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error('Campaign not found');

  const account = await Account.findById(campaign.accountId).select('+sessionEncrypted');
  if (!account) throw new Error('Account not found');

  const client = getClient(account._id);
  if (!client) throw new Error('Telegram account is not connected');

  let targets = campaign.targetIds || [];
  if (campaign.type === 'dm') {
    targets = await validateTargets({
      ownerId: campaign.ownerId,
      type: campaign.type,
      targetIds: targets,
      requireConsent
    });
  }

  campaign.status = 'running';
  campaign.stats.total = targets.length;
  await campaign.save();

  for (const target of targets) {
    if (campaign.status === 'paused' || campaign.status === 'cancelled') break;

    try {
      if (campaign.type !== 'dm' && requireGroupPermission && !(await canPost(client, target))) {
        campaign.stats.skipped += 1;
        await campaign.save();
        continue;
      }

      await sendAuthorizedMessage(client, target, campaign.message);
      campaign.stats.sent += 1;
    } catch (error) {
      campaign.stats.failed += 1;
      logger.warn('Campaign delivery failed', { campaignId: String(campaign._id), target, error: error.message });
    }

    await campaign.save();
    await sleep(delayMs);
  }

  if (campaign.status === 'running') campaign.status = 'completed';
  await campaign.save();
  return campaign;
}
