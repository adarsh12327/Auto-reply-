import { execFileSync } from 'node:child_process';

const files = [
  'src/index.js','src/config.js','src/db.js','src/crypto.js','src/logger.js',
  'src/bot/bot.js','src/bot/keyboards.js',
  'src/handlers/start.js','src/handlers/account.js','src/handlers/webLogin.js',
  'src/handlers/dashboard.js','src/handlers/adminV2.js','src/handlers/campaignsV2.js',
  'src/handlers/autoReplyV2.js','src/handlers/joinRequest.js','src/handlers/ads.js',
  'src/handlers/walletV2.js','src/handlers/supportV2.js',
  'src/services/telegramClient.js','src/services/businessCampaignService.js',
  'src/services/businessSettings.js','src/services/accountService.js','src/services/accessService.js',
  'src/services/notificationService.js','src/services/walletService.js','src/services/uiState.js',
  'src/services/recipientService.js','src/services/autoReplyService.js','src/services/referralService.js',
  'api/health.js','api/setup.js','api/webhook.js','api/login.js','api/cron.js',
  'src/models/settings.js','src/models/groups.js','src/models/messages.js','src/models/campaigns.js',
  'src/models/autoReply.js','src/models/ads.js','src/models/adParticipants.js','src/models/wallet.js',
  'src/models/referrals.js','src/models/support.js','src/models/admin.js','src/models/notifications.js',
  'src/models/redeem.js','src/models/uiState.js','src/models/recipients.js'
];

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log('OK', file);
  } catch (error) {
    console.error('FAIL', file);
    console.error(String(error.stdout || ''));
    console.error(String(error.stderr || ''));
    process.exit(1);
  }
}
