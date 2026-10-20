'use strict';
// Builds a throwaway test environment inside <project>/sandbox:
//   sandbox/FakeDesktop  dummy files to drag into pods
//   sandbox/data         the pods config used by `npm run sandbox`
// Nothing outside the project folder is created or modified.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SANDBOX = path.join(ROOT, 'sandbox');
const FAKE = path.join(SANDBOX, 'FakeDesktop');
const DATA = path.join(SANDBOX, 'data');
const reset = process.argv.includes('--reset');

function makeFakeDesktop() {
  fs.mkdirSync(FAKE, { recursive: true });
  const files = {
    'Shopping list.txt': 'milk\neggs\nbread\n',
    'Budget 2026.csv': 'month,spent\njan,120\nfeb,95\n',
    'Project notes.md': '# Notes\n\nThis is a sandbox test file.\n',
    'Wikipedia.url': '[InternetShortcut]\r\nURL=https://www.wikipedia.org/\r\n',
    'Report draft.html': '<!doctype html><title>Draft</title><p>Sandbox test file.</p>',
  };
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(FAKE, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, body);
  }
  for (const dir of ['Photos', 'Old stuff', 'School']) fs.mkdirSync(path.join(FAKE, dir), { recursive: true });
  return fs.readdirSync(FAKE).map((n) => path.join(FAKE, n));
}

function systemApps() {
  const win = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(win, 'System32', 'notepad.exe'),
    path.join(win, 'System32', 'calc.exe'),
    path.join(win, 'explorer.exe'),
    path.join(win, 'System32', 'charmap.exe'),
    path.join(win, 'System32', 'SnippingTool.exe'),
    path.join(win, 'System32', 'mspaint.exe'),
  ];
  // A few real Start-menu shortcuts (only linked, never changed) to test .lnk icons.
  const startMenu = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  let lnks = [];
  try {
    lnks = fs.readdirSync(startMenu).filter((n) => n.toLowerCase().endsWith('.lnk')).slice(0, 3).map((n) => path.join(startMenu, n));
  } catch {}
  return [...candidates, ...lnks].filter((p) => fs.existsSync(p));
}

function main() {
  const fakeItems = makeFakeDesktop();
  fs.mkdirSync(DATA, { recursive: true });
  const cfgFile = path.join(DATA, 'pods.json');
  if (fs.existsSync(cfgFile) && !reset) {
    console.log('Sandbox already set up (use npm run sandbox:reset to start over).');
    return;
  }
  const item = (p) => ({ path: p });
  const apps = systemApps();
  const config = {
    version: 1,
    hotkey: 'Control+Alt+Space',
    pods: [
      { name: 'Test folder', style: 'folder', items: [...apps.slice(0, 4), ...fakeItems.slice(0, 5)].map(item), tint: { color: 'frost', strength: 'medium' } },
      { name: 'Test strip', style: 'strip', visible: 3, items: [...fakeItems, ...apps.slice(4)].map(item), tint: { color: 'smoke', strength: 'medium' } },
      { name: 'Small', style: 'folder', items: apps.slice(0, 2).map(item), tint: { color: 'ocean', strength: 'light' } },
    ],
  };
  for (const f of fs.readdirSync(DATA)) if (f.startsWith('pods.')) fs.rmSync(path.join(DATA, f));
  fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2));
  console.log(`Sandbox ready: ${config.pods.length} test pods, fake desktop at ${FAKE}`);
}

main();
