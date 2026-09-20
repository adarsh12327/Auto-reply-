import { Campaign, Account, Consent } from '../db.js';
import { mainKeyboard } from '../bot/keyboards.js';
import { runCampaign } from '../services/campaignService.js';

export function registerCampaignHandlers(bot, config) {
  for (const type of ['dm', 'group', 'channel']) {
    bot.action(`campaign_${type}`, async ctx => {
      await ctx.answerCbQuery();
      await ctx.reply(
        `📢 ${type.toUpperCase()} campaign\n\nThis module supports authorized/consent-based recipients only.\n\nCreate via:\n/campaign ${type} TARGET_ID MESSAGE`,
        mainKeyboard()
      );
    });
  }

  bot.command('consent_add', async ctx => {
    const target = ctx.message.text.replace(/^\/consent_add\s*/i, '').trim();
    if (!target) return ctx.reply('Usage: /consent_add TARGET_ID');
    await Consent.findOneAndUpdate(
      { ownerId: ctx.from.id, recipientId: target },
      { $set: { active: true, source: 'user_added', revokedAt: null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await ctx.reply('✅ Recipient added to your authorized DM audience.');
  });

  bot.command('consent_remove', async ctx => {
    const target = ctx.message.text.replace(/^\/consent_remove\s*/i, '').trim();
    if (!target) return ctx.reply('Usage: /consent_remove TARGET_ID');
    await Consent.updateOne({ ownerId: ctx.from.id, recipientId: target }, { active: false, revokedAt: new Date() });
    await ctx.reply('✅ Recipient removed from your authorized DM audience.');
  });

  bot.command('campaign', async ctx => {
    const parts = ctx.message.text.split(/\s+/);
    const type = parts[1];
    const target = parts[2];
    const message = parts.slice(3).join(' ').trim();

    if (!['dm', 'group', 'channel'].includes(type) || !target || !message) {
      return ctx.reply('Usage: /campaign dm|group|channel TARGET_ID MESSAGE');
    }

    const account = await Account.findOne({ ownerId: ctx.from.id, status: 'connected' });
    if (!account) return ctx.reply('❌ Connect your Telegram account first.');

    if (message.length > config.maxMessageLength) {
      return ctx.reply('❌ Message is too long.');
    }

    if (type === 'dm' && config.requireConsent) {
      const consent = await Consent.findOne({ ownerId: ctx.from.id, recipientId: target, active: true });
      if (!consent) return ctx.reply('❌ This DM target is not authorized. Add explicit consent first.');
    }

    const campaign = await Campaign.create({
      ownerId: ctx.from.id,
      accountId: account._id,
      type,
      targetIds: [target],
      message
    });

    await ctx.reply(`📝 Campaign created: ${campaign._id}\nUse /campaign_start ${campaign._id}`);
  });

  bot.command('campaign_start', async ctx => {
    const id = ctx.message.text.replace(/^\/campaign_start\s*/i, '').trim();
    if (!id) return ctx.reply('Usage: /campaign_start CAMPAIGN_ID');

    const campaign = await Campaign.findOne({ _id: id, ownerId: ctx.from.id });
    if (!campaign) return ctx.reply('❌ Campaign not found.');

    await ctx.reply('▶️ Campaign started.');
    try {
      await runCampaign(campaign._id, {
        delayMs: config.sendDelayMs,
        requireConsent: config.requireConsent,
        requireGroupPermission: config.requireGroupPermission
      });
      await ctx.reply('✅ Campaign finished. Use Statistics to view the result.');
    } catch (error) {
      await ctx.reply(`❌ Campaign failed: ${error.message}`);
    }
  });
}
