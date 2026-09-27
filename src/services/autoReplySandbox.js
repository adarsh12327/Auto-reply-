import { Sandbox } from '@vercel/sandbox';
import { readFile } from 'node:fs/promises';

const SANDBOX_NAME = 'auto-reply-mtproto-worker';
const WORKER_PATH = '/vercel/sandbox/auto-reply-worker.mjs';
const PID_PATH = '/vercel/sandbox/auto-reply-worker.pid';
const LOG_PATH = '/vercel/sandbox/auto-reply-worker.log';

let inFlight = null;

async function getSandbox() {
  try {
    return await Sandbox.get({ name: SANDBOX_NAME });
  } catch {
    return Sandbox.create({
      name: SANDBOX_NAME,
      timeout: 44 * 60 * 1000,
      networkPolicy: 'allow-all'
    });
  }
}

export async function ensureInstantAutoReplyWorker({ mongoUri, encryptionKeyHex }) {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const sourceUrl = new URL('../workers/autoReplySandboxWorker.mjs', import.meta.url);
    const source = await readFile(sourceUrl, 'utf8');
    const sandbox = await getSandbox();

    await sandbox.writeFiles([
      {
        path: WORKER_PATH,
        content: Buffer.from(source, 'utf8')
      }
    ]);

    const running = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', [
        'if [ -f "' + PID_PATH + '" ] && kill -0 "$(cat "' + PID_PATH + '")" 2>/dev/null; then',
        '  echo RUNNING',
        '  exit 0',
        'fi',
        'rm -f "' + PID_PATH + '"',
        'echo START',
      ].join('\n')]
    });

    const state = (await running.stdout()).trim();
    if (state === 'RUNNING') {
      return { ok: true, status: 'running', sandbox: sandbox.name };
    }

    await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', [
        'if [ -f "' + PID_PATH + '" ] && kill -0 "$(cat "' + PID_PATH + '")" 2>/dev/null; then exit 0; fi',
        'echo $$ > "' + PID_PATH + '"',
        'trap "rm -f \"' + PID_PATH + '\"" EXIT INT TERM',
        'cd /vercel/sandbox',
        'if [ ! -d node_modules/telegram ] || [ ! -d node_modules/mongoose ]; then',
        '  npm init -y >/dev/null 2>&1',
        '  npm install --no-audit --no-fund mongoose@8.19.1 telegram@2.26.22 >/tmp/auto-reply-npm-install.log 2>&1 || { cat /tmp/auto-reply-npm-install.log; exit 1; }',
        'fi',
        'node "' + WORKER_PATH + '" >> "' + LOG_PATH + '" 2>&1',
      ].join('\n')],
      env: {
        MONGODB_URI: mongoUri,
        SESSION_ENCRYPTION_KEY: encryptionKeyHex
      },
      detached: true
    });

    return { ok: true, status: 'started', sandbox: sandbox.name };
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}
