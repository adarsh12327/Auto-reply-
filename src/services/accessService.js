import { getBusinessSettings } from './businessSettings.js';

const joinCache = new Map();
const JOIN_CACHE_TTL_MS = 30000;

export async function checkRequiredJoin(ctx) {
  const settings = await getBusinessSettings();
  if (!settings.requiredJoinChatId) return { allowed: true };

  const cacheKey = String(ctx.from.id) + ':' + String(settings.requiredJoinChatId);
  const cached = joinCache.get(cacheKey);
  if (cached && Date.now() - cached.at < JOIN_CACHE_TTL_MS) return cached.value;

  try {
    const member = await ctx.telegram.getChatMember(
      settings.requiredJoinChatId,
      ctx.from.id
    );
    const value = { allowed: ['creator', 'administrator', 'member'].includes(member.status), url: settings.requiredJoinUrl || '' };
    joinCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (error) {
    const value = { allowed: false, url: settings.requiredJoinUrl || '', error: error?.message || 'Unable to verify membership' };
    joinCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
}
