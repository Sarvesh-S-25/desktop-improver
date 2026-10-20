'use strict';
// Config persistence. Pods only store *links* (paths) — files are never touched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'pods.json';
const VERSION = 1;

const TINTS = {
  clear: [255, 255, 255],
  frost: [244, 246, 250],
  smoke: [18, 20, 26],
  ocean: [38, 110, 210],
  rose: [222, 78, 124],
  mint: [52, 186, 148],
  amber: [236, 158, 36],
  lavender: [146, 116, 232],
  terracotta: [201, 122, 92],
};
const STRENGTHS = { light: 0.16, medium: 0.3, strong: 0.5 };
const ICON_SIZES = ['s', 'm', 'l'];
const STYLES = ['folder', 'strip'];
// glass: frosted wallpaper. bento: black cards, one bright accent, mono type.
// nebula: deep violet with a neon glow. latte: warm cream, soft photo-widget feel.
const THEMES = ['glass', 'bento', 'nebula', 'latte'];
const ICON_STYLES = ['original', 'mono'];
// Custom pictures live in <data>/images as <sha1>.png|jpg (already shrunk on import).
const IMG_RE = /^[a-f0-9]{40}\.(png|jpg)$/;
const img = (v) => (typeof v === 'string' && IMG_RE.test(v) ? v : null);

const newId = () => crypto.randomBytes(5).toString('hex');

function displayName(p) {
  const base = path.basename(p) || p;
  return /\.(lnk|url|exe|appref-ms)$/i.test(base) ? base.replace(/\.[^.]+$/, '') : base;
}

function makeItem(p) {
  return { id: newId(), path: p, name: displayName(p) };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

function normalizeItem(it) {
  if (!it || typeof it.path !== 'string' || !it.path.trim()) return null;
  const out = {
    id: typeof it.id === 'string' && it.id ? it.id : newId(),
    path: it.path,
    name: typeof it.name === 'string' && it.name.trim() ? it.name.trim().slice(0, 120) : displayName(it.path),
  };
  if (img(it.icon)) out.icon = it.icon;
  return out;
}

function normalizePod(p, i = 0) {
  p = p && typeof p === 'object' ? p : {};
  const style = pick(p.style, STYLES, 'folder');
  // Pods saved before names were shown were 176x176 icon squares; give them room for names once.
  const oldSquare = p.expand === undefined && style === 'folder' && p.w === 176 && p.h === 176;
  const tint = p.tint && typeof p.tint === 'object' ? p.tint : {};
  const seen = new Set();
  const items = (Array.isArray(p.items) ? p.items : [])
    .map(normalizeItem)
    .filter((it) => it && !seen.has(it.id) && seen.add(it.id));
  return {
    id: typeof p.id === 'string' && p.id ? p.id : newId(),
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 60) : `Pod ${i + 1}`,
    style,
    x: num(p.x),
    y: num(p.y),
    w: oldSquare ? 264 : num(p.w) ?? (style === 'strip' ? 330 : 264),
    h: oldSquare ? 232 : num(p.h) ?? (style === 'strip' ? 128 : 232),
    openW: num(p.openW) ?? 420,
    openH: num(p.openH) ?? 340,
    visible: Math.min(Math.max(Math.round(num(p.visible) ?? 3), 2), 6),
    iconSize: pick(p.iconSize, ICON_SIZES, 'm'),
    tint: {
      color: pick(tint.color, Object.keys(TINTS), 'frost'),
      strength: pick(tint.strength, Object.keys(STRENGTHS), 'medium'),
      blur: tint.blur !== false,
    },
    locked: p.locked === true,
    expand: p.expand === true, // folder only: spring open on click instead of scrolling inside
    theme: pick(p.theme, THEMES, 'glass'),
    iconStyle: pick(p.iconStyle, ICON_STYLES, 'original'),
    cover: img(p.cover),
    items,
  };
}

function normalizeConfig(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const pods = (Array.isArray(raw.pods) ? raw.pods : [])
    .map(normalizePod)
    .filter((p) => !seen.has(p.id) && seen.add(p.id));
  return {
    version: VERSION,
    hotkey: typeof raw.hotkey === 'string' && raw.hotkey ? raw.hotkey : 'Control+Alt+Space',
    snap: raw.snap !== false,
    lowMemory: raw.lowMemory !== false,
    pods,
  };
}

function defaultConfig() {
  return normalizeConfig({ pods: [{ name: 'My Pod' }, { name: 'My Strip', style: 'strip' }] });
}

// Returns { config, notice } — notice explains any recovery that happened.
function load(dir) {
  const file = path.join(dir, FILE);
  const bak = file + '.bak';
  if (!fs.existsSync(file)) {
    if (fs.existsSync(bak)) {
      try { return { config: normalizeConfig(JSON.parse(fs.readFileSync(bak, 'utf8'))), notice: 'Restored pods from backup.' }; } catch {}
    }
    return { config: defaultConfig(), notice: null };
  }
  try {
    return { config: normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8'))), notice: null };
  } catch {
    // Keep the broken file for inspection instead of overwriting it.
    const kept = path.join(dir, `pods.corrupt-${Date.now()}.json`);
    try { fs.renameSync(file, kept); } catch {}
    try {
      return { config: normalizeConfig(JSON.parse(fs.readFileSync(bak, 'utf8'))), notice: `Settings file was damaged; restored from backup (old copy kept as ${path.basename(kept)}).` };
    } catch {
      return { config: defaultConfig(), notice: `Settings file was damaged; started fresh (old copy kept as ${path.basename(kept)}).` };
    }
  }
}

// Atomic write: tmp file -> rename, previous good copy kept as .bak
function save(dir, config) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.renameSync(tmp, file);
}

function addPaths(pod, paths) {
  const have = new Set(pod.items.map((it) => it.path.toLowerCase()));
  const added = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    const key = p.toLowerCase();
    if (have.has(key)) continue;
    have.add(key);
    const item = makeItem(p);
    pod.items.push(item);
    added.push(item);
  }
  return added;
}

// Move item `id` so it sits before `beforeId` (or at the end when beforeId is null).
function reorder(pod, id, beforeId) {
  const from = pod.items.findIndex((it) => it.id === id);
  if (from < 0 || id === beforeId) return false;
  const [it] = pod.items.splice(from, 1);
  const to = beforeId ? pod.items.findIndex((x) => x.id === beforeId) : -1;
  pod.items.splice(to < 0 ? pod.items.length : to, 0, it);
  return true;
}

// Every picture file the config still points at (anything else in images/ is garbage).
function imageRefs(config) {
  const refs = new Set();
  for (const p of config.pods) {
    if (p.cover) refs.add(p.cover);
    for (const it of p.items) if (it.icon) refs.add(it.icon);
  }
  return refs;
}

module.exports = {
  FILE, TINTS, STRENGTHS, ICON_SIZES, STYLES, THEMES, ICON_STYLES, IMG_RE,
  newId, displayName, makeItem, normalizeItem, normalizePod, normalizeConfig, defaultConfig,
  load, save, addPaths, reorder, imageRefs,
};
