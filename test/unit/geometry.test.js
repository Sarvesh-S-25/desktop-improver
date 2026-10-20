'use strict';
const test = require('node:test');
const assert = require('node:assert');
const geo = require('../../src/geometry');

const area = { x: 0, y: 0, width: 1920, height: 1040 };

test('windowBounds adds padding for the shadow', () => {
  assert.deepStrictEqual(geo.windowBounds({ x: 100, y: 50, w: 176, h: 176 }), { x: 82, y: 32, width: 212, height: 212 });
});

test('open rect grows from the top-left when there is room', () => {
  const r = geo.computeOpenRect({ x: 100, y: 100, w: 176, h: 176 }, { w: 420, h: 340 }, area);
  assert.deepStrictEqual(r, { x: 100, y: 100, w: 420, h: 340 });
});

test('open rect slides back on screen near the bottom-right edge', () => {
  const r = geo.computeOpenRect({ x: 1800, y: 900, w: 100, h: 100 }, { w: 420, h: 340 }, area);
  assert.strictEqual(r.x + r.w, 1920 - geo.EDGE);
  assert.strictEqual(r.y + r.h, 1040 - geo.EDGE);
});

test('open rect shrinks when larger than the screen', () => {
  const r = geo.computeOpenRect({ x: 0, y: 0, w: 100, h: 100 }, { w: 5000, h: 5000 }, area);
  assert.deepStrictEqual(r, { x: geo.EDGE, y: geo.EDGE, w: 1920 - 2 * geo.EDGE, h: 1040 - 2 * geo.EDGE });
});

test('ensureVisible rescues a pod from a removed monitor', () => {
  const r = geo.ensureVisible({ x: 3000, y: 200, w: 176, h: 176 }, [area], 0);
  assert.ok(r.x + r.w <= 1920 && r.x >= 0);
});

test('ensureVisible keeps a pod on the monitor it mostly sits on', () => {
  const second = { x: 1920, y: 0, width: 1280, height: 1000 };
  const r = geo.ensureVisible({ x: 2000, y: 100, w: 176, h: 176 }, [area, second], 0);
  assert.deepStrictEqual(r, { x: 2000, y: 100, w: 176, h: 176 });
});

test('clampSize respects minimums', () => {
  assert.deepStrictEqual(geo.clampSize(10, 10, geo.MIN.folder), { w: geo.MIN.folder.w, h: geo.MIN.folder.h });
});

test('snapRect lines a dragged pod up with a neighbour and the screen edge', () => {
  const other = { x: 100, y: 100, w: 176, h: 176 };
  const r = geo.snapRect({ x: 100 + 176 + 15, y: 104, w: 176, h: 176 }, [other], area);
  assert.deepStrictEqual([r.x, r.y], [100 + 176 + geo.GAP, 100]);
  const e = geo.snapRect({ x: 14, y: 500, w: 176, h: 176 }, [], area);
  assert.strictEqual(e.x, geo.EDGE);
  const far = geo.snapRect({ x: 600, y: 500, w: 176, h: 176 }, [other], area);
  assert.deepStrictEqual([far.x, far.y], [600, 500]);
});
