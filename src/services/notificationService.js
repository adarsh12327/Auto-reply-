import { Notification } from '../models/notifications.js';

export async function notifyUser(bot, ownerId, type, title, message) {
  await Notification.create({ ownerId, type, title, message });
  try {
    await bot.telegram.sendMessage(ownerId, title + '\n\n' + message);
  } catch {}
}
