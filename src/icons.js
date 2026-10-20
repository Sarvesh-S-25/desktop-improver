'use strict';
const fs = require('fs');
const path = require('path');
const { app, nativeImage, shell } = require('electron');
const shellimage = require('./shellimage');

// Small LRU: shell icons are ~5-15 KB each; capping the cache keeps memory flat
// even after many files come and go (keys include mtime, so stale ones pile up otherwise).
const cache = new Map();
const CACHE_MAX = 400;
function remember(key, url) {
  cache.delete(key);
  cache.set(key, url);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
const expand = (p) => (p || '').replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m).replace(/^"|"$/g, '');

// What a shortcut really looks like. Windows' thumbnail of a .lnk/.url file is a blank page
// with an arrow, so read the picture the shortcut names (e.g. Gmail.ico for a web app),
// or else the program it opens. Returns { icon, index, target }.
function resolveShortcut(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.lnk' && process.platform === 'win32') {
    try {
      const l = shell.readShortcutLink(p);
      return { icon: expand(l.icon), index: l.iconIndex || 0, target: expand(l.target) };
    } catch { return null; }
  }
  if (ext === '.url') {
    try {
      const ini = fs.readFileSync(p, 'utf8');
      const icon = /^\s*IconFile\s*=\s*(.+?)\s*$/im.exec(ini)?.[1];
      const index = Number(/^\s*IconIndex\s*=\s*(-?\d+)/im.exec(ini)?.[1] || 0);
      return { icon: expand(icon), index, target: null };
    } catch { return null; }
  }
  return null;
}

// Windows thumbnail (128 px, sharp on high-DPI screens) of a real file: an .ico shows its
// picture, an .exe its own icon, a photo the photo.
async function thumb(p) {
  try {
    const img = await withTimeout(nativeImage.createThumbnailFromPath(p, { width: 128, height: 128 }), 4000);
    if (!img.isEmpty()) return img.toDataURL();
  } catch {}
  return null;
}
// Classic shell icon (32 px, but it honours a shortcut's icon index).
async function shellIcon(p) {
  try {
    const img = await withTimeout(app.getFileIcon(p, { size: 'large' }), 4000);
    if (!img.isEmpty()) return img.toDataURL();
  } catch {}
  return null;
}

async function shortcutIcon(p, s) {
  const iconExt = path.extname(s.icon || '').toLowerCase();
  if (exists(s.icon)) {
    if (iconExt === '.ico' || /\.(png|jpe?g|bmp)$/.test(iconExt)) {
      const url = await thumb(s.icon);
      if (url) return url;
      const img = nativeImage.createFromPath(s.icon);
      if (!img.isEmpty()) return img.resize({ width: 128, height: 128, quality: 'best' }).toDataURL();
    } else if (s.index === 0) {
      const url = await thumb(s.icon); // first icon inside an .exe/.dll
      if (url) return url;
    } else {
      // A specific icon deeper inside a .dll: only the shell lookup picks the right one.
      const url = await shellIcon(p);
      if (url) return url;
    }
  }
  if (exists(s.target)) {
    const url = await thumb(s.target);
    if (url) return url;
  }
  return shellIcon(p);
}

const PICTURE = /\.(png|jpe?g|gif|bmp|webp|heic|tiff?)$/i;

// The icon Explorer shows, as a data URL. Order matters:
// 1. photos get a real thumbnail;
// 2. Explorer's own icon (handles every kind of shortcut, sharp at high DPI);
// 3. icons without transparency come back on a black square, so prefer a shortcut's own
//    .ico/.png picture over those when it has one.
async function bestIcon(p) {
  if (PICTURE.test(p)) {
    const url = await thumb(p);
    if (url) return url;
  }
  await new Promise(setImmediate); // the native call is synchronous; let other work run between icons
  const sh = shellimage.shellIcon(p, 160);
  const shUrl = sh && nativeImage.createFromBitmap(sh.bgra, { width: sh.width, height: sh.height }).toDataURL();
  if (sh && sh.alpha) return shUrl;
  const s = resolveShortcut(p);
  if (s) {
    if (/\.(ico|png|jpe?g|bmp)$/i.test(s.icon || '') && exists(s.icon)) {
      const url = await shortcutIcon(p, s);
      if (url) return url;
    }
    return shUrl || shortcutIcon(p, s);
  }
  return shUrl || (await thumb(p)) || shellIcon(p);
}

// Large icon (or image thumbnail) as a data URL; null when the file is gone.
async function iconFor(p) {
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  const key = `${p}|${st.mtimeMs}`;
  if (cache.has(key)) { const v = cache.get(key); remember(key, v); return v; }
  const url = await bestIcon(p);
  remember(key, url);
  return url;
}

async function iconsFor(paths) {
  const out = {};
  await Promise.all(paths.map(async (p) => { out[p] = await iconFor(p); }));
  return out;
}

module.exports = { iconFor, iconsFor, resolveShortcut };
