import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const handlerDir = path.join(root, 'src', 'handlers');
const keyboardFile = path.join(root, 'src', 'bot', 'keyboards.js');

const files = fs.readdirSync(handlerDir).filter(name => name.endsWith('.js')).map(name => path.join(handlerDir, name));
const sources = [...files, keyboardFile].map(file => ({ file, text: fs.readFileSync(file, 'utf8') }));
const actions = [];
const exactCallbacks = [];

for (const { file, text } of sources) {
  for (const m of text.matchAll(/bot\.action\(\s*(['"])([^'"]+)\1/g)) actions.push({ file, pattern: m[2], kind: 'exact' });
  for (const m of text.matchAll(/bot\.action\(\s*(\/[^\n]+?\/)[,)]/g)) actions.push({ file, pattern: m[1], kind: 'regex' });
  for (const m of text.matchAll(/callback_data\s*:\s*(['"])([^'"]+)\1/g)) exactCallbacks.push({ file, value: m[2] });
  for (const m of text.matchAll(/Markup\.button\.callback\(\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]/g)) exactCallbacks.push({ file, value: m[1] });
}

function regexCovers(pattern, value) {
  const body = pattern.slice(1, pattern.lastIndexOf('/'));
  try { return new RegExp(body).test(value); } catch { return false; }
}

const staticUncovered = [];
for (const item of exactCallbacks) {
  const covered = actions.some(a =>
    (a.kind === 'exact' && a.pattern === item.value) ||
    (a.kind === 'regex' && regexCovers(a.pattern, item.value))
  );
  if (!covered && !item.value.endsWith(':')) staticUncovered.push(item);
}

console.log('BUTTON AUDIT');
console.log('============');
console.log('Handlers scanned:', sources.length);
console.log('bot.action registrations:', actions.length);
console.log('literal callback_data values:', exactCallbacks.length);

if (staticUncovered.length) {
  console.error('\nPotentially unhandled callback values:');
  for (const x of staticUncovered) console.error('-', x.value, 'in', path.relative(root, x.file));
  process.exitCode = 1;
} else {
  console.log('No statically uncovered callback values found.');
}

const bad = [];
for (const x of exactCallbacks) {
  const bytes = Buffer.byteLength(x.value, 'utf8');
  if (bytes > 64 || bytes < 1) bad.push({ ...x, bytes });
}
if (bad.length) {
  console.error('\nInvalid literal callback_data byte lengths:');
  for (const x of bad) console.error('-', x.value, x.bytes + ' bytes');
  process.exitCode = 1;
} else {
  console.log('All literal callback_data values are within Telegram 1–64 byte limit.');
}
