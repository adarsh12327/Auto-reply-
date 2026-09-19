# Telegram Account Manager — Professional Build

Production-oriented Node.js Telegram account manager with encrypted user sessions, one-time private-DM auto replies, multi-account management, referrals, opt-in broadcasts, structured logging and graceful shutdown.

## Architecture

src/
  bot.js
  config.js
  crypto.js
  db.js
  logger.js
  userClient.js
  index.js

## Setup

1. Install Node.js 20+.
2. Copy .env.example to .env.
3. Create a Telegram bot with BotFather and set BOT_TOKEN.
4. Get Telegram API_ID and API_HASH for the user-account feature.
5. Create a MongoDB Atlas database user and set MONGODB_URI.
6. Generate the session encryption key with: openssl rand -hex 32
7. Set ADMIN_IDS to comma-separated numeric Telegram IDs.
8. Set BOT_USERNAME without @.
9. Run npm install.
10. Run npm run check.
11. Run npm start.

## Core behavior

- Auto Reply listens only to incoming private messages on connected accounts you own or are authorized to manage.
- A unique MongoDB index on accountId + peerId prevents concurrent duplicate replies.
- If sending fails, the reply claim is removed so a later message can retry.
- Telegram sessions are encrypted at rest with AES-256-GCM.
- OTPs and 2-step passwords are never written to logs.

## Opt-in broadcast

Broadcast is admin-only and targets only users who explicitly used /subscribe. /unsubscribe immediately disables future broadcasts. The sender uses a configurable delay and marks blocked or unreachable recipients as inactive.

The implementation deliberately does not provide unsolicited bulk messaging.

## Security

Never commit .env, session strings, bot tokens, API credentials, MongoDB credentials or the encryption key. If a credential has been exposed, rotate it.

Use the connected-account feature only for accounts you own or are authorized to manage.

## Feature status

Implemented:
- one-time private-DM auto reply
- encrypted account sessions
- multi-account add/remove
- referral tracking/link generation
- configurable referral rate
- explicit notification opt-in/out
- admin opt-in broadcast
- admin statistics
- graceful shutdown
- environment validation
- structured logs
- MongoDB indexes and connection tuning

Intentionally not faked:
- VIP billing
- redeem-code crediting
- ad-provider accounting

Those features need a real payment/provider integration before they should modify balances or entitlements.
