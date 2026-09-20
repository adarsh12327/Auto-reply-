# Telegram Manager

A user-controlled Telegram account manager with:

- Telegram user-account connection through MTProto.
- Per-account Telegram API ID/API Hash entry; no global Telegram API credentials are required.
- One-time private-message auto-reply.
- Authorized DM campaigns with a saved-message -> send -> pause/resume/stop flow.
- Consent/authorization-aware recipient management.
- Authorized group/channel posting checks.
- Referral and statistics foundations.
- Admin controls and audit logging.

## Telegram API credentials

When a user adds a Telegram account, the bot asks that user for their own:

1. Telegram API ID
2. Telegram API Hash
3. Phone number
4. Telegram login code and, when required, 2-step verification password

The API hash, phone number and authenticated session are encrypted before storage. Never paste these secrets into public chats or commit them to Git.

## DM campaign safety

DM campaigns are limited to recipients who are authorized for messaging.

A recipient can become eligible when they explicitly authorize contact through the bot's recipient controls, or when they initiate a private conversation with a connected Telegram account and the application records that interaction as the authorization source.

The project does not implement scraped recipient lists, unsolicited mass-DM, spam, permission bypass or ban-evasion.

## Setup

1. Copy .env.example to .env.
2. Fill the environment variables.
3. Run npm install.
4. Run npm run check.
5. Run npm start.

Never commit .env, Telegram sessions, API secrets, bot tokens or the session encryption key.

## Main UI flow

- Auto Reply -> set text -> turn ON/OFF -> clear.
- Accounts -> add and view connected Telegram accounts.
- DM Campaign -> New Message -> Recipients -> Send DM -> Pause/Resume/Stop.
- Refer & Earn -> referral link and current referral rate.
- Statistics -> account, campaign and delivery totals.
- Support -> configured support destination.

Button-based screens edit the existing bot message where Telegram allows it, with a single Back to Home button.

## Project structure

src/
  bot/           Telegram bot UI, keyboards and callbacks
  handlers/      User/admin handlers
  services/      MTProto accounts and campaign engine
  config.js
  crypto.js
  db.js
  logger.js
  index.js
