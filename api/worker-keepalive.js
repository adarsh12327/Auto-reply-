import { loadConfig } from '../src/config.js';
import { connectDb } from '../src/db.js';
import { pollAutoReplies } from '../src/services/autoReplyService.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const config = loadConfig();
    await connectDb(config.mongoUri);
    const results = await pollAutoReplies(config.encryptionKey, 10);

    res.status(200).json({
      ok: true,
      worker: 'polling',
      processedAccounts: results.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Worker keepalive failed:', error);
    res.status(500).json({ ok: false, error: 'Worker keepalive failed' });
  }
}
