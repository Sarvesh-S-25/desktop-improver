'use strict';
// Custom icons and cover photos. Each picture is shrunk once on import and stored as a
// small file named by its hash, so identical pictures are shared and nothing big stays in RAM.
// Pod windows load them through podimg:// straight from disk (no base64 copies in memory).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nativeImage } = require('electron');
const { IMG_RE } = require('./store');

const DIR = 'images';
const EXTS = ['png', 'jpg', 'jpeg', 'bmp', 'ico'];
const ICON_MAX = 256;
const COVER_MAX = 1000;

const dirOf = (dataDir) => path.join(dataDir, DIR);

// Centre-crop to a square (for photos used as icons).
function squareCrop(img) {
  const { width: w, height: h } = img.getSize();
  const s = Math.min(w, h);
  return s === w && s === h ? img : img.crop({ x: Math.floor((w - s) / 2), y: Math.floor((h - s) / 2), width: s, height: s });
}

function shrink(img, max) {
  const { width: w, height: h } = img.getSize();
  if (Math.max(w, h) <= max) return img;
  const k = max / Math.max(w, h);
  return img.resize({ width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), quality: 'best' });
}

// Photos (no transparency) become rounded square JPEG tiles; logos with transparency stay PNG.
function hasAlpha(img) {
  const bmp = img.toBitmap(); // BGRA
  for (let i = 3; i < bmp.length; i += 4 * 7) if (bmp[i] < 250) return true;
  return false;
}

// kind: 'icon' | 'cover'. Returns the stored file name, or throws with a friendly message.
function importImage(dataDir, src, kind) {
  let img = nativeImage.createFromPath(src);
  if (img.isEmpty()) throw new Error('That picture could not be read. Use a PNG, JPG, BMP or ICO file.');
  let buf;
  let ext;
  if (kind === 'icon') {
    const alpha = hasAlpha(img);
    if (!alpha) img = squareCrop(img);
    img = shrink(img, ICON_MAX);
    [buf, ext] = alpha ? [img.toPNG(), 'png'] : [img.toJPEG(88), 'jpg'];
  } else {
    img = shrink(img, COVER_MAX);
    [buf, ext] = [img.toJPEG(84), 'jpg'];
  }
  const name = `${crypto.createHash('sha1').update(buf).digest('hex')}.${ext}`;
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  const file = path.join(dirOf(dataDir), name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return name;
}

// File behind a podimg://img/<name> URL, or null if the name isn't one of ours.
function fileFor(dataDir, name) {
  return IMG_RE.test(name) ? path.join(dirOf(dataDir), name) : null;
}

// Delete stored pictures nothing points at any more. Only touches our own hash-named files.
function gc(dataDir, keep) {
  let names;
  try { names = fs.readdirSync(dirOf(dataDir)); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    if (!IMG_RE.test(f) || keep.has(f)) continue;
    try { fs.unlinkSync(path.join(dirOf(dataDir), f)); n++; } catch {}
  }
  return n;
}

module.exports = { EXTS, importImage, fileFor, gc };
