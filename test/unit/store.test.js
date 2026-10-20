'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pods-test-'));

test('normalizeConfig fills defaults and drops garbage', () => {
  const c = store.normalizeConfig({
    pods: [
      { name: '  Work ', style: 'nope', items: [{ path: 'C:\\a.txt' }, null, { path: '' }, { id: 'x', path: 'C:\\b.lnk' }, { id: 'x', path: 'C:\\dupe' }] },
      'junk',
    ],
  });
  assert.strictEqual(c.pods.length, 2);
  const p = c.pods[0];
  assert.strictEqual(p.name, 'Work');
  assert.strictEqual(p.style, 'folder');
  assert.strictEqual(p.items.length, 2);
  assert.strictEqual(p.items[1].name, 'b');
  assert.strictEqual(p.tint.color, 'frost');
  assert.strictEqual(p.visible, 3);
  assert.strictEqual(c.pods[1].name, 'Pod 2');
  assert.strictEqual(c.hotkey, 'Control+Alt+Space');
});

test('visible count is clamped to 2..6', () => {
  assert.strictEqual(store.normalizePod({ visible: 99 }).visible, 6);
  assert.strictEqual(store.normalizePod({ visible: 0 }).visible, 2);
});

test('displayName hides shortcut extensions only', () => {
  assert.strictEqual(store.displayName('C:\\x\\Chrome.lnk'), 'Chrome');
  assert.strictEqual(store.displayName('C:\\x\\app.EXE'), 'app');
  assert.strictEqual(store.displayName('C:\\x\\notes.txt'), 'notes.txt');
  assert.strictEqual(store.displayName('C:\\x\\Photos'), 'Photos');
});

test('save/load round-trips and keeps a backup', () => {
  const dir = tmp();
  const c = store.normalizeConfig({ pods: [{ name: 'A', items: [{ path: 'C:\\a.txt' }] }] });
  store.save(dir, c);
  c.pods[0].name = 'B';
  store.save(dir, c);
  assert.ok(fs.existsSync(path.join(dir, 'pods.json.bak')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pods.json.bak'), 'utf8')).pods[0].name, 'A');
  const { config, notice } = store.load(dir);
  assert.strictEqual(notice, null);
  assert.strictEqual(config.pods[0].name, 'B');
  assert.ok(!fs.existsSync(path.join(dir, 'pods.json.tmp')));
});

test('corrupt config is kept aside and backup restored', () => {
  const dir = tmp();
  store.save(dir, store.normalizeConfig({ pods: [{ name: 'Good' }] }));
  store.save(dir, store.normalizeConfig({ pods: [{ name: 'Good' }] }));
  fs.writeFileSync(path.join(dir, 'pods.json'), '{ broken');
  const { config, notice } = store.load(dir);
  assert.strictEqual(config.pods[0].name, 'Good');
  assert.match(notice, /restored from backup/);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('pods.corrupt-')));
});

test('corrupt config without backup starts fresh', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'pods.json'), 'nope');
  const { config, notice } = store.load(dir);
  assert.strictEqual(config.pods.length, 2);
  assert.match(notice, /started fresh/);
});

test('missing config gives a starter folder pod and strip pod', () => {
  const { config } = store.load(tmp());
  assert.deepStrictEqual(config.pods.map((p) => p.style), ['folder', 'strip']);
  assert.strictEqual(config.pods[0].name, 'My Pod');
});

test('addPaths dedupes case-insensitively and skips relative paths', () => {
  const pod = store.normalizePod({ items: [{ path: 'C:\\A.txt' }] });
  const added = store.addPaths(pod, ['c:\\a.txt', 'C:\\b.txt', 'C:\\b.txt', 'relative.txt', 42]);
  assert.strictEqual(added.length, 1);
  assert.deepStrictEqual(pod.items.map((i) => i.path), ['C:\\A.txt', 'C:\\b.txt']);
});

test('reorder moves before target, or to end', () => {
  const pod = store.normalizePod({ items: ['a', 'b', 'c', 'd'].map((n) => ({ id: n, path: `C:\\${n}` })) });
  store.reorder(pod, 'd', 'b');
  assert.deepStrictEqual(pod.items.map((i) => i.id), ['a', 'd', 'b', 'c']);
  store.reorder(pod, 'a', null);
  assert.deepStrictEqual(pod.items.map((i) => i.id), ['d', 'b', 'c', 'a']);
  assert.strictEqual(store.reorder(pod, 'zzz', 'a'), false);
  assert.strictEqual(store.reorder(pod, 'a', 'a'), false);
});

test('themes, icon style and picture names are validated', () => {
  const good = 'a'.repeat(40) + '.png';
  const p = store.normalizePod({
    theme: 'bento', iconStyle: 'mono', cover: '..\\..\\evil.jpg',
    items: [{ path: 'C:\\a', icon: good }, { path: 'C:\\b', icon: 'C:\\x.png' }],
  });
  assert.strictEqual(p.theme, 'bento');
  assert.strictEqual(p.iconStyle, 'mono');
  assert.strictEqual(p.cover, null);
  assert.strictEqual(p.items[0].icon, good);
  assert.strictEqual('icon' in p.items[1], false);
  assert.strictEqual(store.normalizePod({ theme: 'nope' }).theme, 'glass');
  const c = store.normalizeConfig({ pods: [p, { cover: 'b'.repeat(40) + '.jpg' }] });
  assert.deepStrictEqual([...store.imageRefs(c)].sort(), [good, 'b'.repeat(40) + '.jpg']);
  assert.strictEqual(c.snap, true);
});

test('folder pods stay small by default; old 176px squares get room for names once', () => {
  const old = store.normalizePod({ style: 'folder', w: 176, h: 176 });
  assert.deepStrictEqual([old.w, old.h, old.expand], [264, 232, false]);
  const kept = store.normalizePod({ style: 'folder', w: 176, h: 176, expand: false });
  assert.deepStrictEqual([kept.w, kept.h], [176, 176]);
  assert.strictEqual(store.normalizePod({ expand: true }).expand, true);
  const fresh = store.normalizePod({});
  assert.deepStrictEqual([fresh.w, fresh.h], [264, 232]);
});
