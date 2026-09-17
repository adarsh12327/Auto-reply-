# Telegram Account Manager

A Node.js Telegram bot manager with a screenshot-inspired menu, encrypted connected-account sessions, one-time private-DM auto replies, referrals and opt-in campaign controls.

## Features

- Telegram Bot API control panel
- Connect your own Telegram account with GramJS
- AES-256-GCM encrypted session storage
- One-time auto reply per private sender
- Enable/disable/edit/delete auto reply
- Account add/remove/status
- Referral links and configurable referral percentage display
- Explicit `/subscribe` and `/unsubscribe` for campaign opt-in
- Channel promo message builder (no unsolicited bulk promotion)
- Stats, VIP, redeem-code placeholders, support and BotFather link

## Setup

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Create a Telegram bot with BotFather and set `BOT_TOKEN`.
4. Get `API_ID` and `API_HASH` from Telegram's official developer portal.
5. Create a MongoDB database and set `MONGODB_URI`.
6. Generate a random 32-byte hex value for `SESSION_ENCRYPTION_KEY`.
7. Set `BOT_USERNAME` without the `@` symbol.
8. Run `npm install` then `npm start`.

## Important security notes

- Never commit `.env` or Telegram session strings.
- Use the connected-account feature only for accounts you own or are authorized to manage.
- The auto-reply engine is limited to incoming private messages and sends at most one configured reply per sender.
- Campaign delivery is intentionally restricted to users who explicitly opt in with `/subscribe`.
- Keep Telegram API credentials and encryption keys private.
