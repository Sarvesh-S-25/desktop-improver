'use strict';
// Keeps pods behind normal windows like desktop widgets. Only ever moves *our own*
// windows. If the native call is unavailable this silently does nothing.
let SetWindowPos = null;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)');
} catch (e) {
  console.warn('[pods] z-order helper unavailable:', e.message);
}

const HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf.readInt32LE(0));
}

function toBottom(win) {
  if (!SetWindowPos || !win || win.isDestroyed()) return false;
  try {
    return SetWindowPos(hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  } catch (e) {
    console.warn('[pods] toBottom failed:', e.message);
    return false;
  }
}

module.exports = { toBottom, available: () => !!SetWindowPos };
