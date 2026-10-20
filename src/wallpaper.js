'use strict';
// Reads (never writes) the current Windows wallpaper so pods can blur it behind themselves.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function regQuery(key, name) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', name], { windowsHide: true, timeout: 4000 }, (err, out) => {
      if (err) return resolve(null);
      const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(name));
      if (!line) return resolve(null);
      const m = line.trim().match(/^\S+\s+REG_\w+\s+(.*)$/);
      resolve(m ? m[1].trim() : '');
    });
  });
}

// WallpaperStyle / TileWallpaper -> how Windows lays the image out
function styleFrom(styleVal, tileVal) {
  if (tileVal === '1') return 'tile';
  switch (String(styleVal)) {
    case '2': return 'stretch';
    case '6': return 'fit';
    case '10': return 'fill';
    case '22': return 'span';
    case '0': return 'center';
    default: return 'fill';
  }
}

function parseColor(v) {
  const parts = String(v || '').split(/\s+/).map(Number);
  return parts.length === 3 && parts.every((n) => n >= 0 && n <= 255) ? parts : [0, 0, 0];
}

async function info() {
  const desk = 'HKCU\\Control Panel\\Desktop';
  const [regFile, styleVal, tileVal, bg] = await Promise.all([
    regQuery(desk, 'WallPaper'),
    regQuery(desk, 'WallpaperStyle'),
    regQuery(desk, 'TileWallpaper'),
    regQuery('HKCU\\Control Panel\\Colors', 'Background'),
  ]);
  // TranscodedWallpaper is the image Windows actually shows (also covers slideshows).
  const transcoded = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
  let file = null;
  for (const f of [transcoded, regFile]) {
    try { if (f && fs.statSync(f).isFile()) { file = f; break; } } catch {}
  }
  let sig = 'none';
  if (file) {
    const st = fs.statSync(file);
    sig = `${st.mtimeMs}-${st.size}`;
  }
  const style = styleFrom(styleVal, tileVal);
  return { file, style, color: parseColor(bg), sig: `${sig}-${style}` };
}

function mimeOf(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

module.exports = { info, styleFrom, parseColor, mimeOf };
