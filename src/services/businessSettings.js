import { BusinessSetting } from '../models/settings.js';

export const DEFAULTS = Object.freeze({
  freeDmLimit: 20,
  premiumDmLimit: 200,
  maxAccountsFree: 2,
  maxAccountsPremium: 10,
  maxGroupsPerCampaign: 100,
  defaultCampaignDelayMs: 20000,
  autoReplyCooldownMs: 60 * 60 * 1000,
  maxAutoReplyCooldownMs: 24 * 60 * 60 * 1000,
  adEarningPercent: 20,
  adPricing: [
    { target: 100, price: 60 },
    { target: 500, price: 250 },
    { target: 1000, price: 500 }
  ],
  referralReward: 10,
  referralCondition: 'start',
  requiredJoinChatId: '',
  requiredJoinUrl: '',
  howToUrl: '',
  supportUrl: '',
  createBotOwner: '',
  createBotMessage: 'Hello, I want to create my own bot.',
  maintenanceMode: false
});

export async function getBusinessSetting(key, fallback = DEFAULTS[key]) {
  const row = await BusinessSetting.findOne({ key }).lean();
  return row ? row.value : fallback;
}

export async function getBusinessSettings() {
  const rows = await BusinessSetting.find({}).lean();
  const out = { ...DEFAULTS };
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export async function setBusinessSetting(key, value, updatedBy) {
  return BusinessSetting.findOneAndUpdate(
    { key },
    { $set: { value, updatedBy } },
    { upsert: true, new: true }
  );
}
