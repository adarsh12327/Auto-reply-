import 'dotenv/config';
import { connectDb } from './db.js';
import { loadAccounts } from './userClient.js';
import { launchBot } from './bot.js';

for(const key of ['BOT_TOKEN','MONGODB_URI','API_ID','API_HASH','SESSION_ENCRYPTION_KEY']){
  if(!process.env[key]) throw new Error(`${key} is missing in .env`);
}

await connectDb();
await loadAccounts();
await launchBot();

process.once('SIGINT',()=>process.exit(0));
process.once('SIGTERM',()=>process.exit(0));
