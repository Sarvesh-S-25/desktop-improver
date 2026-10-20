'use strict';
const { app, BrowserWindow, ipcMain, Menu, Tray, screen, shell, dialog, nativeImage, globalShortcut, nativeTheme, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const store = require('./store');
const images = require('./images');
const geo = require('./geometry');
const wallpaper = require('./wallpaper');
const icons = require('./icons');
const zorder = require('./zorder');

const { PAD, MIN } = geo;
const ROOT = path.join(__dirname, '..');

// ---- Where data lives -------------------------------------------------------
// --sandbox      -> <project>/sandbox/data   (safe test environment)
// --data=<dir>   -> any folder (used by automated tests)
// default        -> %APPDATA%/Desktop Pods
const argv = process.argv;
const dataArg = argv.find((a) => a.startsWith('--data='));
const SANDBOX = argv.includes('--sandbox');
const TEST_MODE = SANDBOX || !!dataArg;
const NO_HOTKEY = argv.includes('--no-hotkey');
const DATA_DIR = dataArg
  ? path.resolve(dataArg.slice('--data='.length))
  : SANDBOX
    ? path.join(ROOT, 'sandbox', 'data')
    : path.join(app.getPath('appData'), 'Desktop Pods');

fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', path.join(DATA_DIR, 'profile'));
// Low-memory mode (default): pods are simple 2D pages, so drawing them on the CPU drops the
// GPU process, the single biggest memory user (measured ~620 MB -> ~350 MB private for 4 pods + hub).
// It has to be decided before the app is ready, so switching it needs a restart.
const LOW_MEMORY = argv.includes('--low-memory') || (!argv.includes('--gpu') && readLowMemory());
function readLowMemory() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, store.FILE), 'utf8')).lowMemory !== false; } catch { return true; }
}
if (LOW_MEMORY) app.disableHardwareAcceleration();
// Pod windows load custom icons/covers straight from disk: podimg://img/<hash>.png
protocol.registerSchemesAsPrivileged([{ scheme: 'podimg', privileges: { standard: true, secure: true } }]);

// Explorer "Send to > Desktop Pods" runs us with --add-to-pod <files...>.
function pathsFromArgv(args) {
  const i = args.indexOf('--add-to-pod');
  if (i < 0) return [];
  return args.slice(i + 1).filter((a) => !a.startsWith('--') && path.isAbsolute(a) && fs.existsSync(a));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_ev, args) => {
    const paths = pathsFromArgv(args);
    if (paths.length) offerPaths(paths);
    else openHub();
  });
  app.whenReady().then(start);
}

// ---- State ------------------------------------------------------------------
let config;
const wins = new Map(); // podId -> { win, open, openRect, dragOrigin }
let tray = null;
let front = false;
let hidden = false;
let busy = 0; // native dialogs open; suppresses blur handling
let quitting = false;
let hub = null; // the control window
let hotkeyActive = false;
let hotkeyPaused = false; // true while the hub records a new shortcut
let wall = { info: null, payload: null };
let pending = null; // { paths } from "Send to", waiting for the user to pick a pod in the hub
// Where the user put each pod. Display changes (a monitor unplugged, scaling changed, RDP)
// may push a pod on screen temporarily, but never overwrite this, so it returns home later.
const home = new Map(); // podId -> { x, y }
const setHome = (pod) => home.set(pod.id, { x: pod.x, y: pod.y });

const podById = (id) => config.pods.find((p) => p.id === id);
const closedRect = (pod) => ({ x: pod.x, y: pod.y, w: pod.w, h: pod.h });
const workAreas = () => screen.getAllDisplays().map((d) => d.workArea);
const primaryIndex = () => {
  const pid = screen.getPrimaryDisplay().id;
  return Math.max(0, screen.getAllDisplays().findIndex((d) => d.id === pid));
};

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
  notifyHub();
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = { ...config, pods: config.pods.map((p) => ({ ...p, ...(home.get(p.id) || {}) })) };
  try { store.save(DATA_DIR, snapshot); } catch (e) { console.error('[pods] save failed', e); }
}

let gcTimer = null;
function gcImagesSoon() {
  clearTimeout(gcTimer);
  gcTimer = setTimeout(() => images.gc(DATA_DIR, store.imageRefs(config)), 3000);
}

function send(id, channel, payload) {
  const e = wins.get(id);
  if (e && !e.win.isDestroyed()) e.win.webContents.send(channel, payload);
}

// ---- Placement --------------------------------------------------------------
function placePod(pod, index) {
  const area = screen.getPrimaryDisplay().workArea;
  if (pod.x == null || pod.y == null) {
    pod.x = area.x + 60 + (index % 4) * 220;
    pod.y = area.y + 60 + Math.floor(index / 4) * 220;
  }
  if (!home.has(pod.id)) setHome(pod);
  const h = home.get(pod.id);
  const min = MIN[pod.style];
  const s = geo.clampSize(pod.w, pod.h, min);
  Object.assign(pod, geo.ensureVisible({ x: h.x, y: h.y, w: s.w, h: s.h }, workAreas(), primaryIndex()));
}

function posInfo(id) {
  const e = wins.get(id);
  const b = e.win.getBounds();
  const d = screen.getDisplayMatching(b);
  const all = screen.getAllDisplays().map((x) => x.bounds);
  const vx = Math.min(...all.map((r) => r.x));
  const vy = Math.min(...all.map((r) => r.y));
  const virtual = {
    x: vx, y: vy,
    width: Math.max(...all.map((r) => r.x + r.width)) - vx,
    height: Math.max(...all.map((r) => r.y + r.height)) - vy,
  };
  return { winX: b.x, winY: b.y, display: d.bounds, virtual };
}
const sendPos = (id) => send(id, 'pod:pos', posInfo(id));

// ---- Windows ----------------------------------------------------------------
// Electron pins a non-resizable window's min/max size to its current size, which
// would stop a pod from shrinking after it opens. Unlock briefly around each change.
function setWinBounds(win, b) {
  if (win.isDestroyed()) return;
  win.setResizable(true);
  win.setBounds(b);
  win.setResizable(false);
}

function createPodWindow(pod) {
  const win = new BrowserWindow({
    ...geo.windowBounds(closedRect(pod)),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    type: 'toolbar', // keeps pods out of the taskbar and Alt+Tab
    hasShadow: false,
    show: false,
    title: pod.name,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  const entry = { win, open: false, openRect: null, dragOrigin: null };
  wins.set(pod.id, entry);

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev) => ev.preventDefault());
  win.once('ready-to-show', () => {
    setWinBounds(win, geo.windowBounds(closedRect(pod)));
    sendPos(pod.id);
    if (hidden) return;
    win.showInactive();
    if (front) win.setAlwaysOnTop(true, 'floating');
    else zorder.toBottom(win);
  });
  win.on('blur', onPodBlur);
  win.on('closed', () => wins.delete(pod.id));
  win.loadFile(path.join(__dirname, 'renderer', 'pod.html'));
  return entry;
}

function isPodWindow(w) {
  for (const e of wins.values()) if (e.win === w) return true;
  return false;
}

function onPodBlur() {
  setTimeout(() => {
    if (busy || quitting) return;
    const f = BrowserWindow.getFocusedWindow();
    if (f && isPodWindow(f)) return;
    if (front) setFront(false);
    else for (const e of wins.values()) zorder.toBottom(e.win);
  }, 80);
}

// Front mode: hotkey brings every pod above all windows until you click away.
function setFront(on) {
  front = !!on;
  if (front && hidden) hidden = false;
  let first = null;
  for (const e of wins.values()) {
    if (e.win.isDestroyed()) continue;
    if (front) {
      e.win.setAlwaysOnTop(true, 'floating');
      e.win.showInactive();
      e.win.moveTop();
      first = first || e.win;
    } else {
      e.win.setAlwaysOnTop(false);
      zorder.toBottom(e.win);
    }
  }
  if (first) first.focus();
  refreshTray();
}

function setHidden(on) {
  hidden = !!on;
  if (hidden) front = false;
  for (const e of wins.values()) {
    if (hidden) e.win.hide();
    else { e.win.showInactive(); zorder.toBottom(e.win); }
  }
  refreshTray();
}

// ---- Pod mutations ----------------------------------------------------------
function pushPod(id) {
  const pod = podById(id);
  const e = wins.get(id);
  if (!pod || !e) return;
  if (!e.open) {
    setWinBounds(e.win, geo.windowBounds(closedRect(pod)));
    sendPos(id);
  }
  send(id, 'pod:update', pod);
}

function updatePod(id, fn) {
  const pod = podById(id);
  if (!pod) return;
  fn(pod);
  saveSoon();
  pushPod(id);
}

function setStyle(id, style) {
  updatePod(id, (p) => {
    if (p.style === style) return;
    p.style = style;
    const d = store.normalizePod({ style });
    p.w = d.w;
    p.h = d.h;
    Object.assign(p, geo.ensureVisible(closedRect(p), workAreas(), primaryIndex()));
    setHome(p);
  });
}

function setFolderMode(id, expand) {
  const e = wins.get(id);
  if (e && e.open && !expand) send(id, 'pod:command', { type: 'close' });
  setStyle(id, 'folder');
  updatePod(id, (p) => { p.expand = expand; });
}

function newPod(style, extra) {
  const pod = store.normalizePod({ style, name: style === 'strip' ? 'New strip' : 'New pod', theme: lastTheme(), ...extra }, config.pods.length);
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  pod.x = Math.round(area.x + (area.width - pod.w) / 2);
  pod.y = Math.round(area.y + (area.height - pod.h) / 3);
  placePod(pod, config.pods.length);
  config.pods.push(pod);
  saveSoon();
  createPodWindow(pod);
  return pod;
}
// New pods follow the look of the most recently created one.
const lastTheme = () => config.pods.at(-1)?.theme || 'glass';

// A picture-only pod (like an iPhone photo widget). Ask for the photo straight away.
async function newPhotoPod() {
  const pod = newPod('folder', { name: 'Photo' });
  const ok = await pickImage(pod.id, null, 'cover');
  if (!ok) {
    config.pods = config.pods.filter((p) => p.id !== pod.id);
    home.delete(pod.id);
    wins.get(pod.id)?.win.destroy();
    saveSoon();
  }
}

// Choose a picture and use it as the icon of itemIds, or (kind 'cover') the pod's cover photo.
async function pickImage(id, itemIds, kind) {
  const e = wins.get(id);
  const parent = e && !e.win.isDestroyed() && e.win.isVisible() ? e.win : undefined;
  busy++;
  send(id, 'pod:busy', true);
  try {
    const res = await dialog.showOpenDialog(parent, {
      title: kind === 'cover' ? 'Choose a cover photo' : 'Choose a picture for the icon',
      defaultPath: app.getPath('pictures'),
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: images.EXTS }],
    });
    if (res.canceled || !res.filePaths[0]) return false;
    return applyImage(id, itemIds, kind, res.filePaths[0]);
  } finally {
    busy--;
    send(id, 'pod:busy', false);
  }
}

function applyImage(id, itemIds, kind, file) {
  let name;
  try {
    name = images.importImage(DATA_DIR, file, kind === 'cover' ? 'cover' : 'icon');
  } catch (err) {
    send(id, 'pod:toast', err.message);
    return false;
  }
  updatePod(id, (p) => {
    if (kind === 'cover') p.cover = name;
    else for (const it of p.items) if (itemIds.includes(it.id)) it.icon = name;
  });
  gcImagesSoon();
  return name;
}

function resetIcons(id, itemIds) {
  updatePod(id, (p) => { for (const it of p.items) if (itemIds.includes(it.id)) delete it.icon; });
  gcImagesSoon();
}
function removeCover(id) {
  updatePod(id, (p) => { p.cover = null; });
  gcImagesSoon();
}

async function deletePod(id) {
  const pod = podById(id);
  const e = wins.get(id);
  if (!pod) return;
  busy++;
  try {
    const { response } = await dialog.showMessageBox(e?.win, {
      type: 'question',
      buttons: ['Delete Pod', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Delete pod',
      message: `Delete “${pod.name}”?`,
      detail: 'Only the pod and its links are removed. Your files stay exactly where they are.',
    });
    if (response !== 0) return;
    config.pods = config.pods.filter((p) => p.id !== id);
    home.delete(id);
    saveSoon();
    gcImagesSoon();
    if (e && !e.win.isDestroyed()) e.win.destroy();
  } finally {
    busy--;
  }
}

async function addDialog(id, kind) {
  const e = wins.get(id);
  busy++;
  send(id, 'pod:busy', true);
  try {
    const res = await dialog.showOpenDialog(e?.win, {
      title: kind === 'folder' ? 'Add folders to pod' : 'Add files or apps to pod',
      defaultPath: app.getPath('desktop'),
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    });
    if (!res.canceled) addPaths(id, res.filePaths);
  } finally {
    busy--;
    send(id, 'pod:busy', false);
  }
}

function addPaths(id, paths) {
  const pod = podById(id);
  if (!pod || !Array.isArray(paths)) return 0;
  const valid = paths.filter((p) => typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p));
  const added = store.addPaths(pod, valid);
  if (added.length) { saveSoon(); pushPod(id); }
  return added.length;
}

function moveItems(fromId, itemIds, toId) {
  const from = podById(fromId);
  const to = podById(toId);
  if (!from || !to || from === to) return;
  const moving = from.items.filter((x) => itemIds.includes(x.id));
  if (!moving.length) return;
  from.items = from.items.filter((x) => !itemIds.includes(x.id));
  const have = new Set(to.items.map((x) => x.path.toLowerCase()));
  for (const it of moving) {
    if (have.has(it.path.toLowerCase())) continue;
    have.add(it.path.toLowerCase());
    to.items.push(it);
  }
  saveSoon();
  gcImagesSoon();
  pushPod(fromId);
  pushPod(toId);
}

function removeItems(id, itemIds) {
  updatePod(id, (p) => { p.items = p.items.filter((x) => !itemIds.includes(x.id)); });
  gcImagesSoon();
}

async function launchItem(id, itemId) {
  const pod = podById(id);
  const it = pod && pod.items.find((x) => x.id === itemId);
  if (!it) return { ok: false, error: 'This item is no longer in the pod.' };
  if (!fs.existsSync(it.path)) return { ok: false, error: `“${it.name}” was moved or deleted. Right-click it to remove the link.` };
  const err = await shell.openPath(it.path);
  if (err) return { ok: false, error: `Windows couldn't open “${it.name}”: ${err}` };
  if (front) setFront(false);
  return { ok: true };
}

// ---- Context menu -----------------------------------------------------------
const TINT_LABELS = { clear: 'Clear', frost: 'Frost', smoke: 'Smoke', ocean: 'Ocean', rose: 'Rose', mint: 'Mint', amber: 'Amber', lavender: 'Lavender', terracotta: 'Terracotta' };
const THEME_LABELS = { glass: 'Glass (frosted wallpaper)', bento: 'Bento (black cards, bright accent)', nebula: 'Nebula (deep violet glow)', latte: 'Latte (warm cream, photo-friendly)' };
const STRENGTH_LABELS = { light: 'Light tint', medium: 'Medium tint', strong: 'Strong tint' };

function buildMenu(id, itemId, selected) {
  const pod = podById(id);
  const t = [];
  const idx = itemId ? pod.items.findIndex((x) => x.id === itemId) : -1;
  // Right-clicking one of several selected items acts on the whole selection.
  const sel = Array.isArray(selected) ? pod.items.filter((x) => selected.includes(x.id)).map((x) => x.id) : [];
  if (idx >= 0 && sel.length > 1 && sel.includes(itemId)) {
    const n = sel.length;
    const others = config.pods.filter((p) => p.id !== id);
    t.push({ label: `Open ${n} Items`, click: () => sel.forEach((x) => launchItem(id, x).then((r) => !r.ok && send(id, 'pod:toast', r.error))) });
    if (others.length) t.push({ label: `Move ${n} Items to Pod`, submenu: others.map((o) => ({ label: o.name, click: () => moveItems(id, sel, o.id) })) });
    t.push(
      { label: `Change Icon for ${n} Items…`, click: () => pickImage(id, sel, 'icon') },
      { label: 'Reset Icons', enabled: pod.items.some((x) => sel.includes(x.id) && x.icon), click: () => resetIcons(id, sel) },
      { label: `Remove ${n} Items from Pod`, click: () => removeItems(id, sel) },
      { type: 'separator' },
    );
  } else if (idx >= 0) {
    const it = pod.items[idx];
    const others = config.pods.filter((p) => p.id !== id);
    t.push(
      { label: 'Open', click: () => launchItem(id, it.id).then((r) => !r.ok && send(id, 'pod:toast', r.error)) },
      { label: 'Show in Explorer', enabled: fs.existsSync(it.path), click: () => shell.showItemInFolder(it.path) },
      { label: 'Rename…', click: () => send(id, 'pod:command', { type: 'rename-item', itemId: it.id }) },
      { label: 'Change Icon…', click: () => pickImage(id, [it.id], 'icon') },
      { label: 'Reset Icon', enabled: !!it.icon, click: () => resetIcons(id, [it.id]) },
      { label: 'Move Earlier', enabled: idx > 0, click: () => updatePod(id, (p) => store.reorder(p, it.id, p.items[idx - 1].id)) },
      { label: 'Move Later', enabled: idx < pod.items.length - 1, click: () => updatePod(id, (p) => store.reorder(p, it.id, p.items[idx + 2]?.id || null)) },
    );
    if (others.length) t.push({ label: 'Move to Pod', submenu: others.map((o) => ({ label: o.name, click: () => moveItems(id, [it.id], o.id) })) });
    t.push(
      { label: 'Remove from Pod', click: () => removeItems(id, [it.id]) },
      { type: 'separator' },
    );
  }
  t.push(
    { label: 'Add Files or Apps…', click: () => addDialog(id, 'file') },
    { label: 'Add Folders…', click: () => addDialog(id, 'folder') },
    { type: 'separator' },
    { label: 'Rename Pod…', click: () => send(id, 'pod:command', { type: 'rename-pod' }) },
    {
      label: 'Style',
      submenu: [
        { label: 'Folder (stays small, scrolls inside)', type: 'radio', checked: pod.style === 'folder' && !pod.expand, click: () => setFolderMode(id, false) },
        { label: 'Folder (springs open on click)', type: 'radio', checked: pod.style === 'folder' && pod.expand, click: () => setFolderMode(id, true) },
        { label: 'Strip (scrolls sideways)', type: 'radio', checked: pod.style === 'strip', click: () => setStyle(id, 'strip') },
      ],
    },
  );
  if (pod.style === 'strip') {
    t.push({
      label: 'Items Shown at Once',
      submenu: [2, 3, 4, 5, 6].map((n) => ({ label: String(n), type: 'radio', checked: pod.visible === n, click: () => updatePod(id, (p) => { p.visible = n; }) })),
    });
  }
  t.push(
    {
      label: 'Icon Size',
      submenu: [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']].map(([k, l]) => ({
        label: l, type: 'radio', checked: pod.iconSize === k, click: () => updatePod(id, (p) => { p.iconSize = k; }),
      })),
    },
    {
      label: 'Theme',
      submenu: store.THEMES.map((k) => ({
        label: THEME_LABELS[k], type: 'radio', checked: pod.theme === k, click: () => updatePod(id, (p) => { p.theme = k; }),
      })),
    },
    {
      label: pod.theme === 'glass' ? 'Glass Tint' : 'Accent Colour',
      submenu: [
        ...Object.keys(store.TINTS).map((k) => ({
          label: TINT_LABELS[k], type: 'radio', checked: pod.tint.color === k, click: () => updatePod(id, (p) => { p.tint.color = k; }),
        })),
        ...(pod.theme === 'glass' ? [
          { type: 'separator' },
          ...Object.keys(store.STRENGTHS).map((k) => ({
            label: STRENGTH_LABELS[k], type: 'radio', checked: pod.tint.strength === k, click: () => updatePod(id, (p) => { p.tint.strength = k; }),
          })),
          { type: 'separator' },
          { label: 'Blur Wallpaper Behind', type: 'checkbox', checked: pod.tint.blur, click: () => updatePod(id, (p) => { p.tint.blur = !p.tint.blur; }) },
        ] : []),
      ],
    },
    {
      label: 'Icon Style',
      submenu: [
        { label: 'Original Colours', type: 'radio', checked: pod.iconStyle === 'original', click: () => updatePod(id, (p) => { p.iconStyle = 'original'; }) },
        { label: 'Matching Tiles (one colour)', type: 'radio', checked: pod.iconStyle === 'mono', click: () => updatePod(id, (p) => { p.iconStyle = 'mono'; }) },
      ],
    },
    { label: pod.cover ? 'Change Cover Photo…' : 'Cover Photo…', click: () => pickImage(id, null, 'cover') },
    ...(pod.cover ? [{ label: 'Remove Cover Photo', click: () => removeCover(id) }] : []),
    { label: 'Lock Position and Size', type: 'checkbox', checked: pod.locked, click: () => updatePod(id, (p) => { p.locked = !p.locked; }) },
    { type: 'separator' },
    { label: 'New Folder Pod', click: () => newPod('folder') },
    { label: 'New Strip Pod', click: () => newPod('strip') },
    { label: 'New Photo Widget…', click: () => newPhotoPod() },
    { label: 'Delete Pod…', click: () => deletePod(id) },
  );
  return Menu.buildFromTemplate(t);
}

// ---- IPC --------------------------------------------------------------------
function ctxOf(sender) {
  for (const [id, e] of wins) {
    if (!e.win.isDestroyed() && e.win.webContents === sender) {
      const pod = podById(id);
      if (pod) return { id, e, pod };
    }
  }
  return null;
}
function handle(channel, fn) {
  ipcMain.handle(channel, (ev, ...args) => {
    const ctx = ctxOf(ev.sender);
    return ctx ? fn(ctx, ...args) : null;
  });
}
function listen(channel, fn) {
  ipcMain.on(channel, (ev, ...args) => {
    const ctx = ctxOf(ev.sender);
    if (ctx) fn(ctx, ...args);
  });
}
const finite = (...v) => v.every((n) => typeof n === 'number' && Number.isFinite(n));

function registerIpc() {
  handle('pod:init', ({ id, pod }) => ({
    pod,
    pad: PAD,
    min: MIN,
    tints: store.TINTS,
    strengths: store.STRENGTHS,
    pos: posInfo(id),
    wallpaper: wall.payload,
    testMode: TEST_MODE,
    hotkey: NO_HOTKEY ? null : config.hotkey,
  }));

  handle('pod:icons', ({ pod }) => icons.iconsFor(pod.items.map((it) => it.path)));

  // apply=false only plans, so the renderer can hide the glass first when the panel must shift.
  handle('pod:expand', ({ id, e, pod }, apply) => {
    if (pod.style !== 'folder' || !pod.expand) return null;
    const closed = closedRect(pod);
    const area = screen.getDisplayMatching(geo.windowBounds(closed)).workArea;
    const size = geo.clampSize(pod.openW, pod.openH, MIN.open);
    const open = geo.computeOpenRect(closed, size, area);
    if (apply !== false) {
      e.open = true;
      e.openRect = open;
      setWinBounds(e.win, geo.windowBounds(open));
      sendPos(id);
    }
    return {
      from: { x: PAD + closed.x - open.x, y: PAD + closed.y - open.y, w: closed.w, h: closed.h },
      to: { x: PAD, y: PAD, w: open.w, h: open.h },
      shifted: open.x !== closed.x || open.y !== closed.y,
    };
  });

  handle('pod:collapse', ({ id, e, pod }) => {
    e.open = false;
    e.openRect = null;
    setWinBounds(e.win, geo.windowBounds(closedRect(pod)));
    sendPos(id);
    return true;
  });

  listen('pod:resize', ({ id, e, pod }, w, h) => {
    if (pod.locked || !finite(w, h)) return;
    const area = screen.getDisplayMatching(e.win.getBounds()).workArea;
    if (e.open) {
      const r = e.openRect;
      const s = geo.clampSize(w, h, MIN.open);
      r.w = Math.min(s.w, area.x + area.width - geo.EDGE - r.x);
      r.h = Math.min(s.h, area.y + area.height - geo.EDGE - r.y);
      pod.openW = r.w;
      pod.openH = r.h;
      setWinBounds(e.win, geo.windowBounds(r));
    } else {
      const s = geo.clampSize(w, h, MIN[pod.style]);
      pod.w = Math.min(s.w, area.x + area.width - geo.EDGE - pod.x);
      pod.h = Math.min(s.h, area.y + area.height - geo.EDGE - pod.y);
      setWinBounds(e.win, geo.windowBounds(closedRect(pod)));
    }
    sendPos(id);
  });
  listen('pod:resize-end', () => saveSoon());

  listen('pod:drag-start', ({ e, pod }) => {
    if (!pod.locked && !e.open) e.dragOrigin = { x: pod.x, y: pod.y };
  });
  listen('pod:drag-move', ({ id, e, pod }, dx, dy) => {
    if (!e.dragOrigin || e.open || pod.locked || !finite(dx, dy)) return;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    let r = { x: e.dragOrigin.x + dx, y: e.dragOrigin.y + dy, w: pod.w, h: pod.h };
    if (config.snap) r = geo.snapRect(r, config.pods.filter((p) => p.id !== id).map(closedRect), area);
    r = geo.clampRectToArea(r, area);
    pod.x = r.x;
    pod.y = r.y;
    { const b = geo.windowBounds(closedRect(pod)); e.win.setPosition(b.x, b.y); }
    sendPos(id);
  });
  listen('pod:drag-end', ({ e, pod }) => {
    if (e.dragOrigin) { e.dragOrigin = null; setHome(pod); saveSoon(); }
  });

  handle('pod:launch', ({ id }, itemId) => launchItem(id, itemId));
  handle('pod:add-paths', ({ id }, paths) => addPaths(id, paths));
  handle('pod:add-dialog', ({ id }, kind) => addDialog(id, kind === 'folder' ? 'folder' : 'file'));
  handle('pod:reorder', ({ id }, itemId, beforeId) => {
    const pod = podById(id);
    if (store.reorder(pod, itemId, beforeId || null)) { saveSoon(); pushPod(id); }
    return true;
  });
  handle('pod:rename', ({ id }, name) => {
    if (typeof name !== 'string' || !name.trim()) return false;
    updatePod(id, (p) => { p.name = name.trim().slice(0, 60); });
    return true;
  });
  handle('pod:rename-item', ({ id }, itemId, name) => {
    if (typeof name !== 'string' || !name.trim()) return false;
    updatePod(id, (p) => {
      const it = p.items.find((x) => x.id === itemId);
      if (it) it.name = name.trim().slice(0, 120);
    });
    return true;
  });
  // A Windows menu only closes on an outside click while its owner window is in the
  // foreground, so focus the pod first and don't send it to the back until the menu is gone.
  handle('pod:context-menu', ({ id, e }, itemId, selected) => new Promise((resolve) => {
    busy++;
    e.win.focus();
    buildMenu(id, itemId, selected).popup({
      window: e.win,
      callback: () => {
        busy--;
        resolve(true);
        onPodBlur(); // menu closed: if focus went elsewhere, settle pods behind windows again
      },
    });
  }));
  listen('pod:escape', () => { if (front) setFront(false); });
}

// ---- Wallpaper --------------------------------------------------------------
async function refreshWallpaper(force) {
  let info;
  try { info = await wallpaper.info(); } catch { info = null; }
  if (!force && wall.info && info && wall.info.sig === info.sig) return;
  let payload = null;
  if (info && info.file) {
    try {
      const img = nativeImage.createFromBuffer(fs.readFileSync(info.file));
      if (!img.isEmpty()) {
        const size = img.getSize();
        const small = size.width > 1280 ? img.resize({ width: 1280, quality: 'good' }) : img;
        payload = {
          url: 'data:image/jpeg;base64,' + small.toJPEG(85).toString('base64'),
          natural: size,
          style: info.style,
          color: info.color,
          sig: info.sig,
        };
      }
    } catch (e) {
      console.warn('[pods] wallpaper read failed:', e.message);
    }
  }
  wall = { info, payload };
  for (const id of wins.keys()) send(id, 'pod:wallpaper', payload);
}

// ---- Hotkey -----------------------------------------------------------------
const hotkeyLabel = (acc) => acc.replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ');

function registerHotkey(acc) {
  try { return globalShortcut.register(acc, () => setFront(!front)); } catch { return false; }
}

// Needs at least Ctrl or Alt (or Win) so normal typing is never swallowed.
const ACCEL_RE = /^(?:(?:Control|Alt|Shift|Super)\+)+(?:[A-Z0-9]|F[1-9]|F1[0-2]|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|`|-|=|\[|\]|;|'|,|\.|\/|\\)$/;

function setHotkey(acc) {
  if (typeof acc !== 'string' || !ACCEL_RE.test(acc) || !/(Control|Alt|Super)\+/.test(acc)) {
    return { ok: false, error: 'Use Ctrl, Alt or Win together with a key, for example Ctrl + Alt + Space.' };
  }
  if (acc === config.hotkey && hotkeyActive) return { ok: true };
  if (NO_HOTKEY) { config.hotkey = acc; saveSoon(); refreshTray(); return { ok: true }; }
  if (hotkeyActive) globalShortcut.unregister(config.hotkey);
  if (registerHotkey(acc)) {
    config.hotkey = acc;
    hotkeyActive = true;
    saveSoon();
    refreshTray();
    return { ok: true };
  }
  hotkeyActive = registerHotkey(config.hotkey);
  return { ok: false, error: `${hotkeyLabel(acc)} is already used by another app. Try a different shortcut.` };
}

// ---- Hub: the small control window --------------------------------------------
function hubState() {
  return {
    pods: config.pods.map((p) => ({
      id: p.id, name: p.name, style: p.style, visible: p.visible, iconSize: p.iconSize,
      tint: p.tint, locked: p.locked, count: p.items.length,
      theme: p.theme, iconStyle: p.iconStyle, cover: p.cover, expand: p.expand,
    })),
    snap: config.snap,
    lowMemory: config.lowMemory,
    lowMemoryActive: LOW_MEMORY,
    sendTo: sendToEnabled(),
    sendToAvailable: process.platform === 'win32' && !dataArg,
    pending: pending && { count: pending.paths.length, names: pending.paths.slice(0, 3).map(store.displayName) },
    hotkey: config.hotkey,
    hotkeyLabel: hotkeyLabel(config.hotkey),
    hotkeyActive: hotkeyActive || NO_HOTKEY,
    hidden,
    testMode: TEST_MODE,
    tints: store.TINTS,
  };
}

let hubTimer = null;
function notifyHub() {
  if (!hub || hub.isDestroyed() || hubTimer) return;
  hubTimer = setTimeout(() => {
    hubTimer = null;
    if (hub && !hub.isDestroyed()) hub.webContents.send('hub:state', hubState());
  }, 30);
}

function openHub() {
  if (hub && !hub.isDestroyed()) {
    if (hub.isMinimized()) hub.restore();
    hub.show();
    hub.focus();
    return hub;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const height = Math.min(720, area.height - 40);
  hub = new BrowserWindow({
    width: 460,
    height,
    minWidth: 380,
    minHeight: 420,
    x: Math.round(area.x + area.width - 460 - 24),
    y: Math.round(area.y + (area.height - height) / 2),
    title: TEST_MODE ? 'Desktop Pods Hub (test mode)' : 'Desktop Pods Hub',
    icon: fs.existsSync(path.join(ROOT, 'assets', 'icon.png')) ? path.join(ROOT, 'assets', 'icon.png') : trayImage(),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1d21' : '#f2f3f6',
    webPreferences: {
      preload: path.join(__dirname, 'hub-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  hub.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  hub.webContents.on('will-navigate', (ev) => ev.preventDefault());
  hub.once('ready-to-show', () => hub.show());
  hub.on('closed', () => { hub = null; });
  hub.loadFile(path.join(__dirname, 'hub', 'hub.html'));
  return hub;
}

// Only the fields the hub may change, each validated by normalizePod.
function applyPatch(id, patch) {
  const pod = podById(id);
  if (!pod || !patch || typeof patch !== 'object') return false;
  if (patch.style && patch.style !== pod.style) {
    const e = wins.get(id);
    if (e && e.open) send(id, 'pod:command', { type: 'close' });
    setStyle(id, patch.style);
  }
  const draft = JSON.parse(JSON.stringify(pod));
  if (typeof patch.name === 'string') draft.name = patch.name;
  if (patch.visible != null) draft.visible = patch.visible;
  if (patch.iconSize) draft.iconSize = patch.iconSize;
  if (typeof patch.locked === 'boolean') draft.locked = patch.locked;
  if (patch.theme) draft.theme = patch.theme;
  if (typeof patch.expand === 'boolean') {
    const e = wins.get(id);
    if (e && e.open && !patch.expand) send(id, 'pod:command', { type: 'close' });
    draft.expand = patch.expand;
  }
  if (patch.iconStyle) draft.iconStyle = patch.iconStyle;
  if (patch.cover === null) draft.cover = null;
  if (patch.tint && typeof patch.tint === 'object') Object.assign(draft.tint, patch.tint);
  const clean = store.normalizePod(draft);
  updatePod(id, (p) => {
    p.name = clean.name;
    p.visible = clean.visible;
    p.iconSize = clean.iconSize;
    p.locked = clean.locked;
    p.tint = clean.tint;
    p.theme = clean.theme;
    p.expand = clean.expand;
    p.iconStyle = clean.iconStyle;
    p.cover = clean.cover;
  });
  if (patch.cover === null) gcImagesSoon();
  return true;
}

// Briefly lift one pod above everything and pulse it so you can find it.
function locatePod(id) {
  const e = wins.get(id);
  if (!e || e.win.isDestroyed()) return;
  if (hidden) setHidden(false);
  e.win.setAlwaysOnTop(true, 'floating');
  e.win.showInactive();
  e.win.moveTop();
  send(id, 'pod:command', { type: 'flash' });
  setTimeout(() => {
    if (e.win.isDestroyed() || front) return;
    e.win.setAlwaysOnTop(false);
    zorder.toBottom(e.win);
  }, 1800);
}

function registerHubIpc() {
  const fromHub = (ev) => hub && !hub.isDestroyed() && ev.sender === hub.webContents;
  const h = (channel, fn) => ipcMain.handle(channel, (ev, ...args) => (fromHub(ev) ? fn(...args) : null));
  h('hub:state', () => hubState());
  h('hub:create', (style) => {
    newPod(style === 'strip' ? 'strip' : 'folder');
    const pod = config.pods[config.pods.length - 1];
    setTimeout(() => locatePod(pod.id), 400);
    return pod.id;
  });
  h('hub:update', (id, patch) => applyPatch(id, patch));
  h('hub:delete', async (id) => {
    const pod = podById(id);
    if (!pod) return false;
    const { response } = await dialog.showMessageBox(hub, {
      type: 'question',
      buttons: ['Delete Pod', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Delete pod',
      message: `Delete “${pod.name}”?`,
      detail: 'Only the pod and its links are removed. Your files stay exactly where they are.',
    });
    if (response !== 0) return false;
    config.pods = config.pods.filter((p) => p.id !== id);
    home.delete(id);
    gcImagesSoon();
    const e = wins.get(id);
    if (e && !e.win.isDestroyed()) e.win.destroy();
    saveSoon();
    return true;
  });
  h('hub:locate', (id) => locatePod(id));
  h('hub:add-files', (id) => addDialog(id, 'file'));
  h('hub:cover', (id) => pickImage(id, null, 'cover'));
  h('hub:photo', () => newPhotoPod());
  h('hub:theme-all', (theme) => {
    if (!store.THEMES.includes(theme)) return false;
    for (const p of config.pods) updatePod(p.id, (x) => { x.theme = theme; });
    return true;
  });
  h('hub:lock-all', (on) => { for (const p of config.pods) updatePod(p.id, (x) => { x.locked = !!on; }); refreshTray(); });
  h('hub:snap', (on) => { config.snap = !!on; saveSoon(); });
  h('hub:low-memory', (on) => { config.lowMemory = !!on; saveSoon(); });
  h('hub:restart', () => {
    saveNow();
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hub').concat('--hub') });
    app.quit();
  });
  h('hub:send-to', (on) => setSendTo(!!on));
  h('hub:pending', (target) => {
    if (!pending) return false;
    const { paths } = pending;
    pending = null;
    notifyHub();
    if (target === 'cancel') return 0;
    const pod = target === 'new' ? newPod('folder', { name: 'New pod' }) : podById(target);
    if (!pod) return 0;
    const n = addPaths(pod.id, paths);
    setTimeout(() => locatePod(pod.id), target === 'new' ? 400 : 0);
    return n;
  });
  h('hub:hotkey', (acc) => setHotkey(acc));
  h('hub:hotkey-pause', (paused) => {
    // While recording a new shortcut, release the current one so it can be pressed.
    if (NO_HOTKEY) return;
    hotkeyPaused = !!paused;
    if (paused && hotkeyActive) { globalShortcut.unregister(config.hotkey); hotkeyActive = false; }
    if (!paused && !hotkeyActive) hotkeyActive = registerHotkey(config.hotkey);
  });
  h('hub:hidden', (on) => setHidden(!!on));
  h('hub:front', () => setFront(true));
  h('hub:open-folder', () => shell.openPath(DATA_DIR));
}

// ---- Explorer "Send to" -------------------------------------------------------
// Opt-in from the hub: a shortcut in the user's SendTo folder, so you can select many
// files in Explorer, right-click > Send to > Desktop Pods, and pick the pod.
const SEND_TO_NAME = TEST_MODE ? 'Desktop Pods (test).lnk' : 'Desktop Pods.lnk';
const sendToFile = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', SEND_TO_NAME);
const sendToEnabled = () => process.platform === 'win32' && fs.existsSync(sendToFile());

function setSendTo(on) {
  if (process.platform !== 'win32' || dataArg) return false; // automated tests never touch the real SendTo folder
  const file = sendToFile();
  if (!on) {
    try { fs.unlinkSync(file); } catch {}
    notifyHub();
    return true;
  }
  const ico = path.join(ROOT, 'assets', 'icon.ico');
  const ok = shell.writeShortcutLink(file, 'create', {
    target: process.execPath,
    args: `"${ROOT}"${SANDBOX ? ' --sandbox' : ''} --add-to-pod`,
    description: 'Add the selected files to a Desktop Pod (links only, files stay put)',
    icon: fs.existsSync(ico) ? ico : process.execPath,
    iconIndex: 0,
  });
  notifyHub();
  return ok;
}

function offerPaths(paths) {
  pending = { paths };
  openHub();
  notifyHub();
}

// ---- Tray -------------------------------------------------------------------
function trayImage() {
  // 32x32 rounded glass square with a 2x2 grid of dots, drawn in code (BGRA).
  const S = 32;
  const buf = Buffer.alloc(S * S * 4);
  const rr = (x, y, cx, cy, hw, hh, r) => {
    const qx = Math.abs(x - cx) - hw + r;
    const qy = Math.abs(y - cy) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
  const dots = [[11, 11], [21, 11], [11, 21], [21, 21]];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const body = Math.min(Math.max(0.5 - rr(px, py, 16, 16, 14, 14, 8), 0), 1);
      let dot = 0;
      for (const [dx, dy] of dots) dot = Math.max(dot, Math.min(Math.max(0.5 - (Math.hypot(px - dx, py - dy) - 3.6), 0), 1));
      const i = (y * S + x) * 4;
      // body: soft white glass; dots: deep blue
      const r = 245 * (1 - dot) + 40 * dot;
      const g = 247 * (1 - dot) + 96 * dot;
      const b = 252 * (1 - dot) + 214 * dot;
      const a = body * (0.92 * (1 - dot) + dot);
      buf[i] = Math.round(b * a);
      buf[i + 1] = Math.round(g * a);
      buf[i + 2] = Math.round(r * a);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

function refreshTray() {
  if (!tray) return;
  const hk = NO_HOTKEY ? undefined : config.hotkey.replace(/Control/g, 'Ctrl');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: TEST_MODE ? 'Desktop Pods (test mode)' : 'Desktop Pods', enabled: false },
    { type: 'separator' },
    { label: 'Open Hub', click: () => openHub() },
    { label: hk ? `Bring Pods to Front    ${hk}` : 'Bring Pods to Front', click: () => setFront(true) },
    { label: hidden ? 'Show Pods' : 'Hide Pods', click: () => setHidden(!hidden) },
    { type: 'separator' },
    { label: 'New Folder Pod', click: () => newPod('folder') },
    { label: 'New Strip Pod', click: () => newPod('strip') },
    { label: 'New Photo Widget…', click: () => newPhotoPod() },
    { type: 'separator' },
    {
      label: 'Lock All Pods in Place',
      type: 'checkbox',
      checked: config.pods.length > 0 && config.pods.every((p) => p.locked),
      click: (mi) => { for (const p of config.pods) updatePod(p.id, (x) => { x.locked = mi.checked; }); refreshTray(); },
    },
    { type: 'separator' },
    { label: 'Open Settings Folder', click: () => shell.openPath(DATA_DIR) },
    { label: 'Quit Desktop Pods', click: () => app.quit() },
  ]));
  notifyHub();
}

function notify(content) {
  if (tray && process.platform === 'win32') tray.displayBalloon({ title: 'Desktop Pods', content, iconType: 'info' });
  console.log('[pods]', content);
}

// ---- Startup ----------------------------------------------------------------
async function start() {
  Menu.setApplicationMenu(null);
  const firstRun = !fs.existsSync(path.join(DATA_DIR, store.FILE));
  const loaded = store.load(DATA_DIR);
  config = loaded.config;
  config.pods.forEach(placePod);
  saveNow();
  images.gc(DATA_DIR, store.imageRefs(config));
  protocol.handle('podimg', (req) => {
    const file = images.fileFor(DATA_DIR, decodeURIComponent(new URL(req.url).pathname.slice(1)));
    if (!file || !fs.existsSync(file)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  registerIpc();
  await refreshWallpaper(true);

  tray = new Tray(trayImage());
  tray.setToolTip(TEST_MODE ? 'Desktop Pods (test mode)' : 'Desktop Pods');
  tray.on('click', () => openHub());
  refreshTray();

  for (const pod of config.pods) createPodWindow(pod);

  if (!NO_HOTKEY) {
    hotkeyActive = registerHotkey(config.hotkey);
    if (!hotkeyActive) notify(`The shortcut ${hotkeyLabel(config.hotkey)} is used by another app. Change it in the Hub.`);
    // If another app (or a test-mode copy) held the shortcut, claim it once it's released.
    setInterval(() => {
      if (hotkeyActive || hotkeyPaused) return;
      hotkeyActive = registerHotkey(config.hotkey);
      if (hotkeyActive) notifyHub();
    }, 5000);
  }
  registerHubIpc();
  const sent = pathsFromArgv(argv);
  if (sent.length) offerPaths(sent);
  else if (firstRun || argv.includes('--hub')) openHub();
  if (loaded.notice) notify(loaded.notice);
  if (dataArg) global.__podsTest = { setFront, setHidden, openHub, offerPaths, applyImage, resetIcons, moveItems, isFront: () => front, zorder: zorder.available() };

  // Pull pods on screen for the current monitors, starting from where the user put them,
  // so a temporary display change never permanently shoves pods into a corner.
  const onDisplays = () => {
    for (const pod of config.pods) {
      const h = home.get(pod.id) || pod;
      Object.assign(pod, geo.ensureVisible({ x: h.x, y: h.y, w: pod.w, h: pod.h }, workAreas(), primaryIndex()));
      if (!wins.get(pod.id)?.open) pushPod(pod.id);
    }
  };
  screen.on('display-added', onDisplays);
  screen.on('display-removed', onDisplays);
  screen.on('display-metrics-changed', onDisplays);
  setInterval(() => refreshWallpaper(false), 30000);
}

app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => {
  quitting = true;
  if (saveTimer && config) saveNow();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
