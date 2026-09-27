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
  upiId: '',
  upiQrFileId: '',
  paymentInstructions: 'Pay using the configured UPI ID and submit the transaction reference for manual verification.',
  maintenanceMode: false,
  joinRequestEnabled: false,
  joinRequestChatId: '',
  joinRequestMessage: 'Thanks for your join request. We will review it shortly.'
});

export async function getBusinessSetting(key, fallback = DEFAULTS[key]) {
  const row = await BusinessSetting.findOne({ key }).lean();
  return row ? row.value : fallback;
}

let settingsCache = null;
let settingsCacheAt = 0;
let settingsPromise = null;
const SETTINGS_TTL_MS = 10000;

export function invalidateBusinessSettingsCache() {
  settingsCache = null;
  settingsCacheAt = 0;
}

export async function getBusinessSettings() {
  const now = Date.now();
  if (settingsCache && now - settingsCacheAt < SETTINGS_TTL_MS) return settingsCache;
  if (settingsPromise) return settingsPromise;
  settingsPromise = BusinessSetting.find({}).lean().then(rows => {
    const out = { ...DEFAULTS };
    for (const row of rows) out[row.key] = row.value;
    settingsCache = out;
    settingsCacheAt = Date.now();
    return out;
  }).finally(() => { settingsPromise = null; });
  return settingsPromise;
}

export async function setBusinessSetting(key, value, updatedBy) {
  const result = await BusinessSetting.findOneAndUpdate(
    { key },
    { $set: { value, updatedBy } },
    { upsert: true, new: true }
  );
  invalidateBusinessSettingsCache();
  return result;
}
