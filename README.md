# Telegram Manager

A user-controlled Telegram account manager with:

- Telegram user-account connection through MTProto.
- One-time private-message auto-reply.
- Consent/authorization-aware campaigns.
- Authorized group/channel posting.
- Scheduling and campaign status tracking.
- Referral, premium and redeem-code foundations.
- Admin controls and audit logging.

## Important Telegram API model

The Telegram `api_id` and `api_hash` are application credentials obtained from Telegram's API development tools. They are normally configured for the application in the server environment; a connected user's account is then authorized with that application using the user's phone/OTP/2FA. Telegram documents this flow at https://core.telegram.org/api/obtaining_api_id and https://core.telegram.org/api/auth.

## Safety model

This project intentionally does not implement unsolicited mass-DM, scraped recipient lists, spam, permission bypass, or ban-evasion. DM campaigns require an eligible recipient relationship/consent record. Group/channel campaigns require the connected account to have permission to post.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill the environment variables.
3. Run `npm install`.
4. Run `npm run check`.
5. Run `npm start`.

Never commit `.env`, Telegram sessions, API secrets, bot tokens or the session encryption key.

## Project structure

```
src/
  bot/           Telegram bot UI, keyboards and callbacks
  handlers/      User/admin command handlers
  services/      MTProto accounts and campaign engine
  models/        Database models (inside db.js for now)
  config.js
  crypto.js
  db.js
  logger.js
  index.js
```
