import { loadConfig } from '../src/config.js';
import { connectDb } from '../src/db.js';
import { BusinessCampaign } from '../src/models/campaigns.js';
import { processCampaignBatch } from '../src/services/businessCampaignService.js';
import { pollAutoReplies } from '../src/services/autoReplyService.js';

let ready;

async function init() {
  if (!ready) {
    ready = (async () => {
      const config = loadConfig();
      await connectDb(config.mongoUri);
      return config;
    })();
  }
  return ready;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  try {
    const config = await init();
    const campaigns = await BusinessCampaign.find({ status: 'running' }).sort({ updatedAt: 1 }).limit(4).select('_id').lean();
    const campaignResults = [];

    for (const campaign of campaigns) {
      campaignResults.push(await processCampaignBatch(campaign._id, config.encryptionKey, 8));
    }

    const autoReplyResults = await pollAutoReplies(config.encryptionKey, 10);

    res.status(200).json({
      ok: true,
      processedCampaigns: campaignResults.length,
      autoReplyAccounts: autoReplyResults.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Business cron failed:', error);
    res.status(500).json({ ok: false, error: 'Scheduled worker failed' });
  }
}
