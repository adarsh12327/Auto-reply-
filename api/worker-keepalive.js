import { loadConfig } from '../src/config.js';
import { ensureInstantAutoReplyWorker } from '../src/services/autoReplySandbox.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const config = loadConfig();
    const result = await ensureInstantAutoReplyWorker({
      mongoUri: config.mongoUri,
      encryptionKeyHex: config.encryptionKey.toString('hex')
    });

    res.status(200).json({
      ok: true,
      worker: result?.status || 'running',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Worker keepalive failed:', error);
    res.status(500).json({ ok: false, error: 'Worker keepalive failed' });
  }
}
