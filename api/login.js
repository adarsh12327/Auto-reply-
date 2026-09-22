import { handleWebLogin } from '../src/handlers/account.js';
import { loadConfig } from '../src/config.js';
import { connectDb } from '../src/db.js';

let readyPromise;

async function getConfig() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const config = loadConfig();
      await connectDb(config.mongoUri);
      return config;
    })();
  }
  return readyPromise;
}

export default async function handler(req, res) {
  try {
    const config = await getConfig();
    await handleWebLogin(req, res, config);
  } catch (error) {
    console.error('Web login error:', error);
    res.status(500).json({
      ok: false,
      error: error?.message || 'Web login failed'
    });
  }
}
