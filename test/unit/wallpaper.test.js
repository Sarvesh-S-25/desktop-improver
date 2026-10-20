'use strict';
const test = require('node:test');
const assert = require('node:assert');
const wp = require('../../src/wallpaper');

test('wallpaper style mapping', () => {
  assert.strictEqual(wp.styleFrom('10', '0'), 'fill');
  assert.strictEqual(wp.styleFrom('6', '0'), 'fit');
  assert.strictEqual(wp.styleFrom('2', '0'), 'stretch');
  assert.strictEqual(wp.styleFrom('22', '0'), 'span');
  assert.strictEqual(wp.styleFrom('0', '0'), 'center');
  assert.strictEqual(wp.styleFrom('0', '1'), 'tile');
  assert.strictEqual(wp.styleFrom(null, null), 'fill');
});

test('background colour parsing', () => {
  assert.deepStrictEqual(wp.parseColor('0 99 177'), [0, 99, 177]);
  assert.deepStrictEqual(wp.parseColor('bad'), [0, 0, 0]);
});

test('mime sniffing', () => {
  assert.strictEqual(wp.mimeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.strictEqual(wp.mimeOf(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg');
});

test('reads the real wallpaper settings without throwing', async () => {
  const info = await wp.info();
  assert.ok(['fill', 'fit', 'stretch', 'span', 'center', 'tile'].includes(info.style));
});
