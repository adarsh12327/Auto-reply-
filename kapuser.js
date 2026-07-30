#!/usr/bin/env node
/**
 * ============================================================================
 *  kapuser.js — Single-file Telegram Userbot (GramJS)
 * ============================================================================
 *
 *  A self-contained Telegram userbot for broadcasting messages, photos,
 *  videos, and documents to groups you already belong to and are allowed
 *  to post in. Built for Termux/Android and any Node.js 20+ environment.
 *
 *  IMPORTANT / COMPLIANCE NOTE:
 *  This tool is intended ONLY for sending messages to groups/channels where
 *  you (the account owner) already have permission to post. Do not use it
 *  to spam, mass-message strangers, or contact users/groups without consent.
 *  Respect Telegram's Terms of Service (https://telegram.org/tos) and rate
 *  limits at all times — use sensible delays between sends.
 *
 *  SETUP:
 *    npm install telegram dotenv input
 *    node kapuser.js
 *
 *  On first run you'll be asked for API_ID / API_HASH (from
 *  https://my.telegram.org) and your phone number. These are cached in a
 *  local .env file and session.txt so you won't need to log in again.
 *
 *  DATA FILES (auto-created in the same folder as this script):
 *    session.txt    - your Telegram login session (string session)
 *    groups.json    - list of groups/channels you've saved for broadcasting
 *    logs.json      - history of logins/broadcasts/errors
 *    schedules.json - pending scheduled broadcasts (survive restarts)
 *
 *  COMMANDS (type these at the "kapuser>" prompt):
 *    /login        - log in to your Telegram account
 *    /addgroup     - save a group/channel for broadcasting
 *    /removegroup  - remove a saved group
 *    /groups       - list saved groups
 *    /broadcast    - send a text/photo/video/document to all saved groups
 *    /schedule     - schedule a broadcast for a future date/time
 *    /stats        - show broadcast statistics
 *    /logout       - log out and clear the local session
 *    /help         - show this command list
 *    /exit         - quit the program
 *
 * ============================================================================
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const input = require('input');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

// ----------------------------------------------------------------------------
// Paths & constants
// ----------------------------------------------------------------------------

const BASE_DIR = __dirname;
const ENV_FILE = path.join(BASE_DIR, '.env');
const SESSION_FILE = path.join(BASE_DIR, 'session.txt');
const GROUPS_FILE = path.join(BASE_DIR, 'groups.json');
const LOGS_FILE = path.join(BASE_DIR, 'logs.json');
const SCHEDULES_FILE = path.join(BASE_DIR, 'schedules.json');

const DEFAULT_DELAY_SEC = 3;   // default delay between sends, in seconds
const MAX_RETRIES = 3;         // retry attempts per group on failure
const RETRY_BACKOFF_MS = 2000; // wait between retries
const MAX_LOG_ENTRIES = 2000;  // cap logs.json size

let API_ID = process.env.API_ID ? parseInt(process.env.API_ID, 10) : null;
let API_HASH = process.env.API_HASH || null;

let client = null;             // active TelegramClient instance
const activeTimers = [];       // handles for scheduled broadcasts (in-memory)

// ----------------------------------------------------------------------------
// Small utilities
// ----------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a file with default content if it doesn't already exist. */
function ensureFile(file, defaultContent) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, defaultContent, 'utf-8');
  }
}

/** Make sure every data file this bot needs actually exists on disk. */
function ensureFiles() {
  ensureFile(SESSION_FILE, '');
  ensureFile(GROUPS_FILE, '[]');
  ensureFile(LOGS_FILE, '[]');
  ensureFile(SCHEDULES_FILE, '[]');
}

/** Safely read + parse a JSON array file, self-healing if corrupted. */
function loadJSON(file) {
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`⚠️  Could not parse ${path.basename(file)} (${err.message}). Resetting it.`);
    fs.writeFileSync(file, '[]', 'utf-8');
    return [];
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function readSession() {
  try {
    return fs.readFileSync(SESSION_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}

function writeSession(sessionString) {
  fs.writeFileSync(SESSION_FILE, sessionString || '', 'utf-8');
}

/** Append an entry to logs.json (auto-trimmed to MAX_LOG_ENTRIES). */
function addLog(entry) {
  const logs = loadJSON(LOGS_FILE);
  logs.push({ timestamp: new Date().toISOString(), ...entry });
  saveJSON(LOGS_FILE, logs.slice(-MAX_LOG_ENTRIES));
}

// ----------------------------------------------------------------------------
// Client / authentication
// ----------------------------------------------------------------------------

/** Prompt for API_ID/API_HASH once, then cache them in .env for next time. */
async function ensureApiCredentials() {
  if (API_ID && API_HASH) return;

  console.log('\n🔑 No API credentials found (get them free at https://my.telegram.org).');
  while (!API_ID) {
    const raw = await input.text('Enter your API_ID: ');
    const parsed = parseInt(raw.trim(), 10);
    if (!isNaN(parsed)) API_ID = parsed;
    else console.log('❌ API_ID must be a number.');
  }
  while (!API_HASH) {
    const raw = (await input.text('Enter your API_HASH: ')).trim();
    if (raw) API_HASH = raw;
  }

  try {
    fs.writeFileSync(ENV_FILE, `API_ID=${API_ID}\nAPI_HASH=${API_HASH}\n`, 'utf-8');
    console.log('✅ Saved API credentials to .env for future runs.');
  } catch (err) {
    console.error('⚠️  Could not write .env file:', err.message);
  }
}

/**
 * Get (or lazily create/reconnect) the TelegramClient.
 * GramJS is configured with connectionRetries so it will auto-reconnect
 * on transient network drops; this function also re-connects if a
 * previous instance became disconnected between commands.
 */
async function getClient() {
  if (client) {
    if (!client.connected) {
      try {
        await client.connect();
      } catch (err) {
        console.error('⚠️  Reconnect failed, creating a fresh client:', err.message);
        client = null;
      }
    }
    if (client) return client;
  }

  await ensureApiCredentials();
  const sessionString = readSession();
  const stringSession = new StringSession(sessionString);

  client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 10,   // auto-reconnect attempts on drop
    retryDelay: 2000,
    autoReconnect: true,
    floodSleepThreshold: 60,
  });

  await client.connect();

  // Keep session.txt in sync with whatever GramJS is currently using.
  const currentSession = client.session.save();
  if (currentSession && currentSession !== sessionString) {
    writeSession(currentSession);
  }

  return client;
}

/** Interactive first-time (or repeat) login flow. */
async function login() {
  const c = await getClient();

  if (await c.isUserAuthorized()) {
    console.log('✅ Already logged in.');
    return;
  }

  try {
    await c.start({
      phoneNumber: async () => (await input.text('📱 Phone number (with country code): ')).trim(),
      password: async () => await input.text('🔒 2FA password (leave blank if none): '),
      phoneCode: async () => (await input.text('💬 Code you received: ')).trim(),
      onError: (err) => console.error('Login error:', err.message),
    });

    writeSession(c.session.save());
    console.log('✅ Logged in successfully! Session saved to session.txt.');
    addLog({ action: 'login', success: true });
  } catch (err) {
    console.error('❌ Login failed:', err.message);
    addLog({ action: 'login', success: false, error: err.message });
  }
}

/** Log out of Telegram and wipe the local session. */
async function logout() {
  try {
    const c = await getClient();
    if (await c.isUserAuthorized()) {
      await c.invoke(new Api.auth.LogOut());
    }
    await c.disconnect();
  } catch (err) {
    console.error('⚠️  Logout warning:', err.message);
  } finally {
    client = null;
    writeSession('');
    addLog({ action: 'logout', success: true });
    console.log('✅ Logged out. Local session cleared.');
  }
}

// ----------------------------------------------------------------------------
// Group management
// ----------------------------------------------------------------------------

/** Resolve and save a group/channel by username, invite link, or ID. */
async function addGroup() {
  const c = await getClient();
  const identifier = (await input.text('Enter group username, invite link, or numeric ID: ')).trim();
  if (!identifier) {
    console.log('❌ Nothing entered.');
    return;
  }

  try {
    const entity = await c.getEntity(identifier);
    const groups = loadJSON(GROUPS_FILE);
    const id = entity.id.toString();

    if (groups.some((g) => g.id === id)) {
      console.log('⚠️  That group is already saved.');
      return;
    }

    groups.push({
      id,
      title: entity.title || entity.username || identifier,
      username: entity.username || null,
      type: entity.className || 'Unknown', // e.g. 'Channel', 'Chat'
      addedAt: new Date().toISOString(),
    });

    saveJSON(GROUPS_FILE, groups);
    console.log(`✅ Added group: ${entity.title || identifier}`);
    addLog({ action: 'addgroup', target: identifier, success: true });
  } catch (err) {
    console.error('❌ Failed to add group:', err.message);
    addLog({ action: 'addgroup', target: identifier, success: false, error: err.message });
  }
}

/** Show saved groups with index numbers, and let the user remove one. */
async function removeGroup() {
  const groups = loadJSON(GROUPS_FILE);
  if (!groups.length) {
    console.log('⚠️  No groups saved yet.');
    return;
  }

  listGroups();
  const raw = await input.text('Enter the number of the group to remove (0 to cancel): ');
  const idx = parseInt(raw.trim(), 10);

  if (idx === 0) {
    console.log('Cancelled.');
    return;
  }
  if (isNaN(idx) || idx < 1 || idx > groups.length) {
    console.log('❌ Invalid selection.');
    return;
  }

  const [removed] = groups.splice(idx - 1, 1);
  saveJSON(GROUPS_FILE, groups);
  console.log(`🗑️  Removed group: ${removed.title}`);
  addLog({ action: 'removegroup', target: removed.title, success: true });
}

function listGroups() {
  const groups = loadJSON(GROUPS_FILE);
  if (!groups.length) {
    console.log('📭 No groups saved yet. Use /addgroup to add one.');
    return;
  }
  console.log('\n📋 Saved Groups:');
  groups.forEach((g, i) => {
    const label = g.username ? `@${g.username}` : `id:${g.id}`;
    console.log(`  ${i + 1}. ${g.title}  (${label})`);
  });
  console.log('');
}

// ----------------------------------------------------------------------------
// Broadcasting
// ----------------------------------------------------------------------------

/**
 * Pick the best target reference for a saved group.
 * Prefer the public @username when available (always resolvable). For
 * private groups without a username we fall back to the numeric ID —
 * priming the client's dialog cache beforehand (see runBroadcast) lets
 * GramJS resolve those IDs to full peers.
 */
function resolveGroupTarget(group) {
  return group.username || group.id;
}

/** Core broadcast loop shared by /broadcast and /schedule. */
async function runBroadcast(groups, type, message, filePath, delayMs) {
  if (!groups.length) {
    console.log('⚠️  No groups to send to.');
    return;
  }

  const c = await getClient();

  // Prime the entity cache so numeric IDs of private groups resolve correctly.
  try {
    await c.getDialogs({ limit: 200 });
  } catch (err) {
    console.error('⚠️  Could not refresh dialog cache:', err.message);
  }

  let success = 0;
  let failed = 0;
  const failedGroups = [];

  for (const group of groups) {
    const target = resolveGroupTarget(group);
    let attempt = 0;
    let sent = false;

    while (attempt < MAX_RETRIES && !sent) {
      try {
        if (type === 'Text') {
          await c.sendMessage(target, { message });
        } else {
          await c.sendFile(target, { file: filePath, caption: message || '' });
        }
        sent = true;
        success++;
        console.log(`✅ Sent to ${group.title}`);
        addLog({ action: 'broadcast', type, target: group.title, success: true });
      } catch (err) {
        attempt++;
        if (attempt >= MAX_RETRIES) {
          failed++;
          failedGroups.push(group.title);
          console.error(`❌ Giving up on ${group.title}: ${err.message}`);
          addLog({ action: 'broadcast', type, target: group.title, success: false, error: err.message });
        } else {
          console.error(`⚠️  Attempt ${attempt} failed for ${group.title} (${err.message}), retrying...`);
          await sleep(RETRY_BACKOFF_MS);
        }
      }
    }

    await sleep(delayMs); // configurable delay between groups (rate-limit friendly)
  }

  console.log(`\n📊 Broadcast finished: ${success} succeeded, ${failed} failed.`);
  if (failedGroups.length) console.log('   Failed groups:', failedGroups.join(', '));
}

/** Interactive /broadcast command: gather inputs then send immediately. */
async function broadcast() {
  const groups = loadJSON(GROUPS_FILE);
  if (!groups.length) {
    console.log('⚠️  No groups saved. Use /addgroup first.');
    return;
  }

  const type = await input.select('What do you want to broadcast?', ['Text', 'Photo', 'Video', 'Document']);

  let filePath = null;
  if (type !== 'Text') {
    filePath = (await input.text('Enter the full path to the file: ')).trim();
    if (!fs.existsSync(filePath)) {
      console.log('❌ File not found at that path.');
      return;
    }
  }

  const message = await input.text(type === 'Text' ? 'Message text: ' : 'Caption (optional, press Enter to skip): ');

  const delayRaw = (await input.text(`Delay between groups in seconds [default ${DEFAULT_DELAY_SEC}]: `)).trim();
  const delaySec = delayRaw ? parseInt(delayRaw, 10) : DEFAULT_DELAY_SEC;
  const delayMs = (isNaN(delaySec) ? DEFAULT_DELAY_SEC : delaySec) * 1000;

  console.log(`\n📤 Broadcasting to ${groups.length} group(s)...`);
  await runBroadcast(groups, type, message, filePath, delayMs);
}

// ----------------------------------------------------------------------------
// Scheduling
// ----------------------------------------------------------------------------

/** Arm a single scheduled broadcast with setTimeout and track its handle. */
function armSchedule(entry) {
  const delay = new Date(entry.time).getTime() - Date.now();
  if (delay <= 0) return; // already elapsed, skip arming (cleaned up elsewhere)

  const timer = setTimeout(async () => {
    console.log(`\n⏰ Running scheduled broadcast (${entry.id})...`);
    const groups = loadJSON(GROUPS_FILE);
    await runBroadcast(groups, entry.type, entry.message, entry.filePath, entry.delayMs);

    // Remove from persisted schedule list once it has run.
    const remaining = loadJSON(SCHEDULES_FILE).filter((s) => s.id !== entry.id);
    saveJSON(SCHEDULES_FILE, remaining);
  }, delay);

  activeTimers.push(timer);
}

/** On startup, re-arm any schedules that are still in the future. */
function loadPendingSchedules() {
  const schedules = loadJSON(SCHEDULES_FILE);
  const now = Date.now();
  const pending = schedules.filter((s) => new Date(s.time).getTime() > now);

  pending.forEach(armSchedule);

  if (pending.length !== schedules.length) {
    saveJSON(SCHEDULES_FILE, pending); // drop stale/expired entries
  }
  if (pending.length) {
    console.log(`🔁 Restored ${pending.length} pending scheduled broadcast(s).`);
  }
}

/** Interactive /schedule command: pick a future time and queue a broadcast. */
async function schedule() {
  const groups = loadJSON(GROUPS_FILE);
  if (!groups.length) {
    console.log('⚠️  No groups saved. Use /addgroup first.');
    return;
  }

  const when = (await input.text('Date & time to send (YYYY-MM-DD HH:mm, local time): ')).trim();
  const targetTime = new Date(when.replace(' ', 'T'));

  if (isNaN(targetTime.getTime()) || targetTime.getTime() <= Date.now()) {
    console.log('❌ That date/time is invalid or already in the past.');
    return;
  }

  const type = await input.select('What do you want to send?', ['Text', 'Photo', 'Video', 'Document']);

  let filePath = null;
  if (type !== 'Text') {
    filePath = (await input.text('Enter the full path to the file: ')).trim();
    if (!fs.existsSync(filePath)) {
      console.log('❌ File not found at that path.');
      return;
    }
  }

  const message = await input.text(type === 'Text' ? 'Message text: ' : 'Caption (optional): ');
  const delayRaw = (await input.text(`Delay between groups in seconds [default ${DEFAULT_DELAY_SEC}]: `)).trim();
  const delaySec = delayRaw ? parseInt(delayRaw, 10) : DEFAULT_DELAY_SEC;
  const delayMs = (isNaN(delaySec) ? DEFAULT_DELAY_SEC : delaySec) * 1000;

  const entry = {
    id: Date.now().toString(),
    time: targetTime.toISOString(),
    type,
    message,
    filePath,
    delayMs,
  };

  const schedules = loadJSON(SCHEDULES_FILE);
  schedules.push(entry);
  saveJSON(SCHEDULES_FILE, schedules);
  armSchedule(entry);

  console.log(`✅ Broadcast scheduled for ${targetTime.toLocaleString()}.`);
  addLog({ action: 'schedule', target: `${groups.length} group(s)`, success: true });
}

// ----------------------------------------------------------------------------
// Statistics
// ----------------------------------------------------------------------------

function stats() {
  const logs = loadJSON(LOGS_FILE);
  const groups = loadJSON(GROUPS_FILE);
  const schedules = loadJSON(SCHEDULES_FILE);
  const broadcasts = logs.filter((l) => l.action === 'broadcast');
  const successCount = broadcasts.filter((b) => b.success).length;
  const failCount = broadcasts.filter((b) => !b.success).length;
  const last = broadcasts[broadcasts.length - 1];

  console.log('\n📊 Broadcast Statistics');
  console.log('------------------------------------');
  console.log(`Saved groups:            ${groups.length}`);
  console.log(`Pending schedules:       ${schedules.length}`);
  console.log(`Total send attempts:     ${broadcasts.length}`);
  console.log(`Successful sends:        ${successCount}`);
  console.log(`Failed sends:            ${failCount}`);
  if (last) {
    console.log(`Last broadcast:          ${last.timestamp} → ${last.target} (${last.success ? 'success' : 'failed'})`);
  }
  console.log('------------------------------------\n');
}

// ----------------------------------------------------------------------------
// Console menu
// ----------------------------------------------------------------------------

function printHelp() {
  console.log(`
📖 Available commands:
  /login        Log in to your Telegram account
  /addgroup     Save a group/channel for broadcasting
  /removegroup  Remove a saved group
  /groups       List saved groups
  /broadcast    Send a text/photo/video/document to all saved groups
  /schedule     Schedule a broadcast for a future date/time
  /stats        Show broadcast statistics
  /logout       Log out and clear the local session
  /help         Show this list again
  /exit         Quit the program
`);
}

async function mainMenu() {
  ensureFiles();
  loadPendingSchedules();

  console.log('============================================');
  console.log('  kapuser.js — Telegram Userbot (GramJS)');
  console.log('============================================');
  printHelp();

  // Auto-connect (but don't force login) if a session already exists.
  if (readSession()) {
    try {
      const c = await getClient();
      if (await c.isUserAuthorized()) {
        console.log('✅ Restored existing session.\n');
      }
    } catch (err) {
      console.error('⚠️  Could not restore session automatically:', err.message);
    }
  }

  // Main command loop — everything goes through `input` to avoid clashing
  // readline interfaces (input.text/select creates its own each call).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let cmd;
    try {
      cmd = (await input.text('kapuser> ')).trim();
    } catch {
      cmd = '/exit';
    }

    try {
      switch (cmd) {
        case '/login':
          await login();
          break;
        case '/logout':
          await logout();
          break;
        case '/addgroup':
          await addGroup();
          break;
        case '/removegroup':
          await removeGroup();
          break;
        case '/groups':
          listGroups();
          break;
        case '/broadcast':
          await broadcast();
          break;
        case '/schedule':
          await schedule();
          break;
        case '/stats':
          stats();
          break;
        case '/help':
          printHelp();
          break;
        case '/exit':
        case '/quit':
          console.log('👋 Goodbye!');
          await gracefulShutdown(0);
          break;
        case '':
          break; // ignore blank input
        default:
          console.log('❓ Unknown command. Type /help to see the list of commands.');
      }
    } catch (err) {
      console.error('❌ Unexpected error:', err.message);
      addLog({ action: 'error', success: false, error: err.message });
    }
  }
}

// ----------------------------------------------------------------------------
// Shutdown & global error handling
// ----------------------------------------------------------------------------

async function gracefulShutdown(code) {
  activeTimers.forEach(clearTimeout);
  try {
    if (client && client.connected) await client.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down gracefully...');
  await gracefulShutdown(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled promise rejection:', reason && reason.message ? reason.message : reason);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught exception:', err.message);
});

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

mainMenu().catch((err) => {
  console.error('💥 Fatal error:', err.message);
  process.exit(1);
});
