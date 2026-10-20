'use strict';
// The icon Explorer itself draws for any path (IShellItemImageFactory): works for shortcuts
// to programs, Store apps and installer shortcuts that have no readable target, at full size.
// Returns { width, height, bgra } with premultiplied pixels, or null. If the native calls
// are unavailable this module simply returns null and callers fall back.
let api = null;
try {
  if (process.platform === 'win32') {
    const koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    const user32 = koffi.load('user32.dll');
    const GUID = koffi.struct('PODS_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: koffi.array('uint8', 8) });
    const SIZE = koffi.struct('PODS_SIZE', { cx: 'int32', cy: 'int32' });
    const BITMAP = koffi.struct('PODS_BITMAP', {
      bmType: 'int32', bmWidth: 'int32', bmHeight: 'int32', bmWidthBytes: 'int32',
      bmPlanes: 'uint16', bmBitsPixel: 'uint16', bmBits: 'void *',
    });
    const BMI = koffi.struct('PODS_BITMAPINFO', {
      biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
      biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
      biClrUsed: 'uint32', biClrImportant: 'uint32', colors: koffi.array('uint32', 4),
    });
    api = {
      koffi,
      create: shell32.func('int __stdcall SHCreateItemFromParsingName(str16 path, void *pbc, PODS_GUID *riid, _Out_ void **ppv)'),
      getObject: gdi32.func('int __stdcall GetObjectW(void *h, int c, _Out_ PODS_BITMAP *pv)'),
      getDIBits: gdi32.func('int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ PODS_BITMAPINFO *bmi, uint32 usage)'),
      deleteObject: gdi32.func('bool __stdcall DeleteObject(void *h)'),
      getDC: user32.func('void * __stdcall GetDC(void *hwnd)'),
      releaseDC: user32.func('int __stdcall ReleaseDC(void *hwnd, void *hdc)'),
      GetImage: koffi.proto('int __stdcall PODS_GetImage(void *self, PODS_SIZE size, int flags, _Out_ void **phbm)'),
      Release: koffi.proto('uint32 __stdcall PODS_Release(void *self)'),
      sizeofBitmap: koffi.sizeof(BITMAP),
      sizeofHeader: 40,
      IID: { d1: 0xbcc18b79, d2: 0xba16, d3: 0x442f, d4: [0x80, 0xc4, 0x8a, 0x59, 0xc3, 0x0c, 0x46, 0x3b] }, // IShellItemImageFactory
      SIZE,
    };
  }
} catch (e) {
  console.warn('[pods] shell icon helper unavailable:', e.message);
  api = null;
}

const SIIGBF_BIGGERSIZEOK = 0x1;
const SIIGBF_ICONONLY = 0x4;

function method(obj, index, proto) {
  const vtbl = api.koffi.decode(obj, 'void *');
  return (...args) => api.koffi.call(api.koffi.decode(vtbl, index * 8, 'void *'), proto, obj, ...args);
}

function bitmapPixels(hbm) {
  const info = {};
  if (!api.getObject(hbm, api.sizeofBitmap, info)) return null;
  const w = info.bmWidth;
  const h = Math.abs(info.bmHeight);
  if (!w || !h || w > 1024 || h > 1024) return null;
  const bgra = Buffer.alloc(w * h * 4);
  const bmi = {
    biSize: api.sizeofHeader, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0,
    biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0, colors: [0, 0, 0, 0],
  };
  const dc = api.getDC(null);
  try {
    if (api.getDIBits(dc, hbm, 0, h, bgra, bmi, 0) !== h) return null;
  } finally {
    api.releaseDC(null, dc);
  }
  // Icons without an alpha channel come back fully transparent; make them opaque.
  let anyAlpha = false;
  for (let i = 3; i < bgra.length; i += 4) if (bgra[i]) { anyAlpha = true; break; }
  if (!anyAlpha) for (let i = 3; i < bgra.length; i += 4) bgra[i] = 255;
  return { width: w, height: h, bgra, alpha: anyAlpha };
}

// size: square pixel size wanted (the shell picks the closest real icon and scales it).
function shellIcon(p, size = 160) {
  if (!api) return null;
  const out = [null];
  if (api.create(p, null, api.IID, out) < 0 || !out[0]) return null;
  const factory = out[0];
  try {
    const hbm = [null];
    const hr = method(factory, 3, api.GetImage)({ cx: size, cy: size }, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK, hbm);
    if (hr < 0 || !hbm[0]) return null;
    try { return bitmapPixels(hbm[0]); } finally { api.deleteObject(hbm[0]); }
  } catch (e) {
    console.warn('[pods] shell icon failed:', e.message);
    return null;
  } finally {
    method(factory, 2, api.Release)();
  }
}

module.exports = { shellIcon, available: () => !!api };
