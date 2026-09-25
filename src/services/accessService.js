import { getBusinessSettings } from './businessSettings.js';

export async function checkRequiredJoin(ctx) {
  const settings = await getBusinessSettings();
  if (!settings.requiredJoinChatId) return { allowed: true };

  try {
    const member = await ctx.telegram.getChatMember(
      settings.requiredJoinChatId,
      ctx.from.id
    );
    const allowed = ['creator', 'administrator', 'member'].includes(member.status);
    return { allowed, url: settings.requiredJoinUrl || '' };
  } catch (error) {
    return {
      allowed: false,
      url: settings.requiredJoinUrl || '',
      error: error?.message || 'Unable to verify membership'
    };
  }
}
