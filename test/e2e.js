'use strict';
// End-to-end test: launches the real app against a throwaway data folder,
// drives it like a user would and checks the result. Never touches real pods.
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'pods-e2e-shots');
const PAD = 18;
const results = [];

async function step(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
    console.log('  ✔', name);
  } catch (e) {
    results.push(['FAIL', name, e]);
    console.log('  ✖', name, '\n     ', e.message.split('\n')[0]);
  }
}
// Windows rounds window sizes at fractional display scaling (e.g. 270%), so allow a few px.
function near(b, want, tol = 3) {
  for (const k of Object.keys(want)) assert.ok(Math.abs(b[k] - want[k]) <= tol, `${k}: got ${b[k]}, want ${want[k]}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await wait(50);
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-e2e-'));
  const files = path.join(data, 'files');
  fs.mkdirSync(files);
  const mk = (n) => { const p = path.join(files, n); fs.writeFileSync(p, n); return p; };
  const sys = (n) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', n);
  const folderItems = [sys('notepad.exe'), sys('calc.exe'), sys('charmap.exe'), mk('a.txt'), mk('b.txt'), mk('c.csv')];
  const stripItems = Array.from({ length: 7 }, (_, i) => mk(`strip-${i + 1}.txt`));
  const listItems = Array.from({ length: 14 }, (_, i) => mk(`Quarterly report ${i + 1}.txt`));
  fs.writeFileSync(path.join(data, 'pods.json'), JSON.stringify({
    pods: [
      { id: 'fold', name: 'E2E folder', style: 'folder', expand: true, x: 300, y: 260, w: 176, h: 176, openW: 440, openH: 340, items: folderItems.map((p) => ({ path: p })) },
      { id: 'strp', name: 'E2E strip', style: 'strip', x: 700, y: 260, w: 330, h: 128, visible: 3, items: stripItems.map((p) => ({ path: p })), tint: { color: 'smoke' } },
      // saved before names were shown: no "expand" field and the old 176px square
      { id: 'list', name: 'E2E list', style: 'folder', x: 60, y: 120, w: 176, h: 176, items: listItems.map((p) => ({ path: p })) },
    ],
  }));

  console.log('Launching app with test data in', data);
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT, `--data=${data}`, '--no-hotkey', ...(process.env.E2E_ARGS ? process.env.E2E_ARGS.split(' ') : [])],
  });
  const logs = [];
  app.process().stdout.on('data', (d) => logs.push(String(d)));
  app.process().stderr.on('data', (d) => logs.push(String(d)));

  const bounds = () => app.evaluate(({ BrowserWindow }) =>
    Object.fromEntries(BrowserWindow.getAllWindows().map((w) => [w.getTitle(), w.getBounds()])));
  const readCfg = () => JSON.parse(fs.readFileSync(path.join(data, 'pods.json'), 'utf8'));

  try {
    await until(() => app.windows().length >= 3, 15000, 'three pod windows');
    const pages = app.windows();
    for (const p of pages) await p.waitForSelector('html[data-ready="1"]', { timeout: 15000 });
    const byTitle = async (t) => { for (const p of app.windows()) if ((await p.title()) === t) return p; return null; };
    const folder = await until(() => byTitle('E2E folder'), 5000, 'folder page');
    const strip = await until(() => byTitle('E2E strip'), 5000, 'strip page');
    const list = await until(() => byTitle('E2E list'), 5000, 'list page');
    const state = (p) => p.evaluate(() => ({ open: window.__podState.open, anim: window.__podState.anim, n: window.__podState.pod.items.length }));

    await step('stay-small folder: old square pod got room for names', async () => {
      const b = (await bounds())['E2E list'];
      near(b, { width: 264 + 2 * PAD, height: 232 + 2 * PAD }, 6); // 270% scaling rounds the window
      const cfg = readCfg().pods[2];
      assert.deepStrictEqual([cfg.w, cfg.h, cfg.expand], [264, 232, false]);
    });

    await step('stay-small folder shows every file name', async () => {
      const names = await list.locator('.sgrid .tile .nm').allTextContents();
      assert.strictEqual(names.length, 14);
      assert.strictEqual(names[0], 'Quarterly report 1.txt');
      // the name is actually visible (not clipped to nothing) and the full name is in the tooltip
      const h = await list.locator('.sgrid .tile .nm').first().evaluate((n) => n.getBoundingClientRect().height);
      assert.ok(h >= 12, `label height ${h}`);
      assert.strictEqual(await list.locator('.sgrid .tile').first().getAttribute('title'), 'Quarterly report 1.txt');
      assert.match(await list.locator('.shead').textContent(), /E2E list\s*14/);
    });

    await step('clicking the stay-small folder never makes it bigger', async () => {
      const b0 = (await bounds())['E2E list'];
      await list.click('.shead .nm');
      await list.mouse.click(5 + PAD, 0 + PAD + 200);
      await wait(700);
      assert.strictEqual((await state(list)).open, false);
      near((await bounds())['E2E list'], b0, 1);
    });

    await step('mouse wheel scrolls through the items inside the pod', async () => {
      await until(() => list.locator('.sgrid img.ic').count().then((n) => n >= 3), 8000, 'list icons');
      const m0 = await list.evaluate(() => { const g = document.querySelector('.sgrid'); return { top: g.scrollTop, more: g.scrollHeight > g.clientHeight, fade: g.classList.contains('more') }; });
      assert.ok(m0.more, 'more items than fit, so it scrolls');
      assert.ok(m0.fade, 'fade hints there is more');
      await list.screenshot({ path: path.join(SHOTS, '0-list-top.png') });
      const box = await list.locator('.sgrid').boundingBox();
      await list.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await list.mouse.wheel(0, 2000);
      await until(() => list.evaluate(() => document.querySelector('.sgrid').scrollTop > 0), 3000, 'scrolled');
      await wait(300);
      const m1 = await list.evaluate(() => { const g = document.querySelector('.sgrid'); return { atEnd: g.scrollTop + g.clientHeight >= g.scrollHeight - 2, fade: g.classList.contains('more') }; });
      assert.ok(m1.atEnd && !m1.fade, 'reached the end, fade gone');
      await list.screenshot({ path: path.join(SHOTS, '0-list-scrolled.png') });
      assert.strictEqual((await state(list)).open, false);
    });

    await step('Ctrl+click selects inside the stay-small folder without launching', async () => {
      await list.locator('.sgrid .tile').nth(12).click({ modifiers: ['Control'] });
      await list.locator('.sgrid .tile').nth(13).click({ modifiers: ['Control'] });
      assert.strictEqual(await list.locator('.sgrid .tile.selected').count(), 2);
      await list.keyboard.press('Escape');
      assert.strictEqual(await list.locator('.sgrid .tile.selected').count(), 0);
    });

    await step('closed folder shows 3 icons plus a cluster tile', async () => {
      assert.strictEqual(await folder.locator('.cgrid .cell').count(), 4);
      assert.strictEqual(await folder.locator('.cgrid .cell .tile').count(), 3);
      assert.strictEqual(await folder.locator('.cluster .ic').count(), 3);
      assert.strictEqual(await folder.locator('.label').textContent(), 'E2E folder');
    });

    await step('real shell icons load', async () => {
      await until(() => folder.locator('.cgrid img.ic').count().then((n) => n >= 3), 8000, 'icons');
    });

    await step('window sits at the saved position with shadow padding', async () => {
      const b = (await bounds())['E2E folder'];
      near(b, { x: 300 - PAD, y: 260 - PAD, width: 176 + 2 * PAD, height: 176 + 2 * PAD });
    });

    await folder.screenshot({ path: path.join(SHOTS, '1-folder-closed.png') });
    await strip.screenshot({ path: path.join(SHOTS, '2-strip.png') });

    await step('clicking the pod springs it open to the saved open size', async () => {
      await folder.click('.label');
      await wait(120);
      await folder.screenshot({ path: path.join(SHOTS, '3-folder-mid-open.png') });
      await until(async () => { const s = await state(folder); return s.open && !s.anim; }, 3000, 'open');
      const b = (await bounds())['E2E folder'];
      near(b, { x: 300 - PAD, y: 260 - PAD, width: 440 + 2 * PAD, height: 340 + 2 * PAD });
      assert.strictEqual(await folder.locator('.ogrid .tile').count(), 6);
      await folder.screenshot({ path: path.join(SHOTS, '4-folder-open.png') });
    });

    await step('Escape closes it back to the closed size', async () => {
      await folder.keyboard.press('Escape');
      await until(async () => { const s = await state(folder); return !s.open && !s.anim; }, 3000, 'closed');
      const b = (await bounds())['E2E folder'];
      near(b, { width: 176 + 2 * PAD, height: 176 + 2 * PAD });
    });

    await step('reorder by API persists to disk', async () => {
      const ids = await folder.evaluate(() => window.__podState.pod.items.map((i) => i.id));
      await folder.evaluate(([a, b]) => window.pods.reorder(a, b), [ids[5], ids[0]]);
      await wait(500);
      assert.strictEqual(readCfg().pods[0].items[0].id, ids[5]);
    });

    await step('adding links dedupes and saves; files are untouched', async () => {
      const extra = mk('extra.txt');
      const before = fs.statSync(extra).mtimeMs;
      const n1 = await folder.evaluate((p) => window.pods.addPaths([p, p]), extra);
      const n2 = await folder.evaluate((p) => window.pods.addPaths([p]), extra);
      assert.strictEqual(n1, 1);
      assert.strictEqual(n2, 0);
      await wait(500);
      assert.strictEqual(readCfg().pods[0].items.length, 7);
      assert.strictEqual(fs.statSync(extra).mtimeMs, before);
    });

    await step('non-existent or relative paths are rejected', async () => {
      const n = await folder.evaluate(() => window.pods.addPaths(['C:\\definitely\\not\\here.txt', 'relative.txt', 5]));
      assert.strictEqual(n, 0);
    });

    await step('a deleted file shows a clear message instead of failing silently', async () => {
      const gone = mk('gone.txt');
      await folder.evaluate((p) => window.pods.addPaths([p]), gone);
      fs.rmSync(gone);
      const id = await folder.evaluate(() => window.__podState.pod.items.at(-1).id);
      const r = await folder.evaluate((i) => window.pods.launch(i), id);
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /moved or deleted/);
    });

    await step('dragging the pod moves the window and saves the position', async () => {
      const b0 = (await bounds())['E2E folder'];
      const box = await folder.locator('.label').boundingBox();
      const sx = box.x + box.width / 2;
      const sy = box.y + box.height / 2;
      await folder.mouse.move(sx, sy);
      await folder.mouse.down();
      for (let i = 1; i <= 10; i++) { await folder.mouse.move(sx + i * 6, sy + i * 4); await wait(20); }
      await folder.mouse.up();
      await wait(500);
      const b1 = (await bounds())['E2E folder'];
      assert.ok(b1.x - b0.x >= 40 && b1.y - b0.y >= 25, `moved by ${b1.x - b0.x},${b1.y - b0.y}`);
      near({ x: readCfg().pods[0].x }, { x: b1.x + PAD });
      assert.strictEqual(await state(folder).then((s) => s.open), false, 'drag must not open the pod');
    });

    await step('corner handle resizes the pod (with a minimum size)', async () => {
      const b0 = (await bounds())['E2E folder'];
      const box = await folder.locator('#resize').boundingBox();
      const sx = box.x + box.width / 2;
      const sy = box.y + box.height / 2;
      await folder.mouse.move(sx, sy);
      await folder.mouse.down();
      for (let i = 1; i <= 8; i++) { await folder.mouse.move(sx + i * 5, sy + i * 5); await wait(20); }
      await folder.mouse.up();
      await wait(300);
      const b1 = (await bounds())['E2E folder'];
      assert.ok(b1.width > b0.width && b1.height > b0.height, 'grew');
      await folder.evaluate(() => window.pods.resize(10, 10));
      await wait(200);
      const b2 = (await bounds())['E2E folder'];
      near(b2, { width: 136 + 2 * PAD, height: 136 + 2 * PAD });
    });

    await step('strip shows 3 at a time with page dots', async () => {
      const m = await strip.evaluate(() => {
        const t = document.querySelector('.track');
        const tile = t.querySelector('.tile');
        return { tw: tile.getBoundingClientRect().width, cw: t.clientWidth, dots: document.querySelectorAll('.dot').length };
      });
      assert.ok(Math.abs(m.tw - m.cw / 3) < 1.5, `tile ${m.tw} vs ${m.cw / 3}`);
      assert.strictEqual(m.dots, 3);
    });

    await step('mouse wheel pages the strip by 3 items', async () => {
      const box = await strip.locator('.track').boundingBox();
      await strip.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await strip.mouse.wheel(0, 120);
      await until(() => strip.evaluate(() => {
        const t = document.querySelector('.track');
        return Math.abs(t.scrollLeft - t.clientWidth) < 2;
      }), 3000, 'one page scrolled');
      await wait(200);
      assert.strictEqual(await strip.locator('.dot.on').count(), 1);
      const onIdx = await strip.evaluate(() => [...document.querySelectorAll('.dot')].findIndex((d) => d.classList.contains('on')));
      assert.strictEqual(onIdx, 1);
      await strip.screenshot({ path: path.join(SHOTS, '5-strip-page2.png') });
    });

    await step('strip cannot be "opened" (clicking empty space does nothing)', async () => {
      await strip.click('.shead');
      await wait(300);
      assert.strictEqual((await state(strip)).open, false);
    });

    await step('renaming a pod persists', async () => {
      await strip.evaluate(() => window.pods.rename('Renamed strip'));
      await wait(500);
      assert.strictEqual(readCfg().pods[1].name, 'Renamed strip');
    });

    let hubPage = null;
    await step('hub opens and lists every pod', async () => {
      await app.evaluate(() => global.__podsTest.openHub());
      hubPage = await until(() => byTitle('Desktop Pods Hub (test mode)'), 8000, 'hub window');
      await hubPage.waitForSelector('html[data-ready="1"]');
      assert.strictEqual(await hubPage.locator('.pod').count(), 3);
      assert.deepStrictEqual(await hubPage.locator('#hkKeys kbd').allTextContents(), ['Ctrl', 'Alt', 'Space']);
      await hubPage.screenshot({ path: path.join(SHOTS, '6-hub.png') });
    });

    await step('hub creates a new strip pod window', async () => {
      const before = app.windows().length;
      await hubPage.click('#newStrip');
      await until(() => app.windows().length === before + 1, 5000, 'new pod window');
      await until(() => hubPage.locator('.pod').count().then((n) => n === 4), 3000, 'hub list updated');
      await wait(500);
      assert.strictEqual(readCfg().pods.at(-1).style, 'strip');
    });

    await step('hub changes the strip to 4 at a time and the strip follows', async () => {
      const row = hubPage.locator('.pod', { hasText: 'Renamed strip' });
      await row.locator('.pod-head').click();
      await row.getByRole('radio', { name: '4' }).click();
      await row.getByRole('radio', { name: 'Ocean' }).click();
      await wait(500);
      const cfg = readCfg().pods.find((p) => p.name === 'Renamed strip');
      assert.strictEqual(cfg.visible, 4);
      assert.strictEqual(cfg.tint.color, 'ocean');
      const m = await strip.evaluate(() => {
        const t = document.querySelector('.track');
        return { tw: t.querySelector('.tile').getBoundingClientRect().width, cw: t.clientWidth, dots: document.querySelectorAll('.dot').length };
      });
      assert.ok(Math.abs(m.tw - m.cw / 4) < 1.5, `tile ${m.tw} vs ${m.cw / 4}`);
      assert.strictEqual(m.dots, 2);
      await hubPage.screenshot({ path: path.join(SHOTS, '7-hub-expanded.png') });
      await strip.screenshot({ path: path.join(SHOTS, '8-strip-4-ocean.png') });
    });

    await step('hub switches a pod between folder and strip', async () => {
      const row = hubPage.locator('.pod', { hasText: 'Renamed strip' });
      await row.getByRole('radio', { name: 'Folder' }).click();
      await wait(500);
      assert.strictEqual(readCfg().pods.find((p) => p.name === 'Renamed strip').style, 'folder');
      await until(() => strip.locator('.cgrid, .folder').count().then((n) => n > 0), 3000, 'strip re-rendered as folder');
      await row.getByRole('radio', { name: 'Strip' }).click();
      await wait(400);
    });

    await step('hub switches a folder between "stay small" and "spring open"', async () => {
      const row = hubPage.locator('.pod', { hasText: 'E2E list' });
      await row.locator('.pod-head').click();
      await row.getByRole('radio', { name: 'Spring open' }).click();
      await wait(400);
      assert.strictEqual(readCfg().pods[2].expand, true);
      await until(() => list.locator('.cgrid').count().then((n) => n === 1), 3000, 'icon square');
      await row.getByRole('radio', { name: 'Stay small, scroll' }).click();
      await wait(400);
      assert.strictEqual(readCfg().pods[2].expand, false);
      await until(() => list.locator('.sgrid').count().then((n) => n === 1), 3000, 'list back');
      await row.locator('.pod-head').click();
    });

    await step('hub records a new shortcut (needs Ctrl/Alt)', async () => {
      await hubPage.click('#hkChange');
      await hubPage.keyboard.press('P');
      assert.ok(await hubPage.locator('#hkError').isVisible());
      await hubPage.keyboard.press('Control+Alt+P');
      await until(() => hubPage.locator('#hkKeys kbd').allTextContents().then((k) => k.join('+') === 'Ctrl+Alt+P'), 3000, 'new keys shown');
      await wait(400);
      assert.strictEqual(readCfg().hotkey, 'Control+Alt+P');
    });

    await step('Ctrl+click selects several items, Shift+click a range, Esc clears', async () => {
      await folder.click('.label');
      await until(async () => { const s = await state(folder); return s.open && !s.anim; }, 3000, 'open');
      const tiles = folder.locator('.ogrid .tile');
      await tiles.nth(0).click({ modifiers: ['Control'] });
      await tiles.nth(2).click({ modifiers: ['Control'] });
      assert.strictEqual(await folder.locator('.ogrid .tile.selected').count(), 2);
      await tiles.nth(4).click({ modifiers: ['Shift'] });
      assert.strictEqual(await folder.locator('.ogrid .tile.selected').count(), 3, 'range 2..4');
      assert.strictEqual((await state(folder)).open, true, 'selecting must not launch or close');
      await folder.keyboard.press('Control+A');
      assert.strictEqual(await folder.locator('.ogrid .tile.selected').count(), await tiles.count());
      await folder.screenshot({ path: path.join(SHOTS, '9-multi-select.png') });
      await folder.keyboard.press('Escape');
      assert.strictEqual(await folder.locator('.ogrid .tile.selected').count(), 0);
      assert.strictEqual((await state(folder)).open, true, 'first Esc only clears the selection');
      await folder.keyboard.press('Escape');
      await until(async () => { const s = await state(folder); return !s.open && !s.anim; }, 3000, 'closed');
    });

    await step('several selected items move to another pod together', async () => {
      const ids = await folder.evaluate(() => window.__podState.pod.items.slice(0, 2).map((i) => i.id));
      const before = readCfg().pods[1].items.length;
      await app.evaluate((_e, a) => global.__podsTest.moveItems('fold', a, 'strp'), ids);
      await wait(500);
      const cfg = readCfg();
      assert.strictEqual(cfg.pods[1].items.length, before + 2);
      assert.ok(!cfg.pods[0].items.some((i) => ids.includes(i.id)));
      await app.evaluate((_e, a) => global.__podsTest.moveItems('strp', a, 'fold'), ids);
      await wait(400);
    });

    const pic = path.join(ROOT, 'assets', 'icon.png');
    let iconName = null;
    await step('a custom picture replaces an icon, shrunk and stored once', async () => {
      const id = await folder.evaluate(() => window.__podState.pod.items[0].id);
      iconName = await app.evaluate((_e, a) => global.__podsTest.applyImage('fold', [a.id], 'icon', a.pic), { id, pic });
      assert.match(iconName, /^[a-f0-9]{40}\.png$/);
      const file = path.join(data, 'images', iconName);
      assert.ok(fs.existsSync(file));
      assert.ok(fs.statSync(file).size < fs.statSync(pic).size * 4, 'stored picture is small');
      await wait(400);
      assert.strictEqual(readCfg().pods[0].items[0].icon, iconName);
      // the pod window actually loads it from disk through podimg://
      await until(() => folder.evaluate(() => {
        const img = document.querySelector('.cgrid img.custom');
        return img && img.complete && img.naturalWidth > 0 && img.naturalWidth <= 256;
      }), 4000, 'custom icon rendered');
      await folder.screenshot({ path: path.join(SHOTS, '10-custom-icon.png') });
    });

    await step('the same picture on another item reuses the same file', async () => {
      const id = await folder.evaluate(() => window.__podState.pod.items[1].id);
      const n2 = await app.evaluate((_e, a) => global.__podsTest.applyImage('fold', [a.id], 'icon', a.pic), { id, pic });
      assert.strictEqual(n2, iconName);
      assert.strictEqual(fs.readdirSync(path.join(data, 'images')).length, 1);
    });

    await step('a non-picture is refused with a clear message', async () => {
      const r = await app.evaluate((_e, f) => global.__podsTest.applyImage('fold', [], 'icon', f), path.join(files, 'a.txt'));
      assert.strictEqual(r, false);
    });

    await step('resetting icons deletes the unused picture file', async () => {
      const ids = await folder.evaluate(() => window.__podState.pod.items.slice(0, 2).map((i) => i.id));
      await app.evaluate((_e, a) => global.__podsTest.resetIcons('fold', a), ids);
      await until(() => !fs.existsSync(path.join(data, 'images', iconName)), 6000, 'garbage collected');
      assert.strictEqual(await folder.locator('img.custom').count(), 0);
    });

    await step('cover photo shows behind the pod', async () => {
      const name = await app.evaluate((_e, f) => global.__podsTest.applyImage('fold', null, 'cover', f), pic);
      assert.match(name, /^[a-f0-9]{40}\.jpg$/);
      await until(() => folder.evaluate(() => document.documentElement.classList.contains('has-cover')), 3000, 'cover class');
      const ok = await folder.evaluate((n) => new Promise((res) => {
        const i = new Image();
        i.onload = () => res(i.naturalWidth > 0);
        i.onerror = () => res(false);
        i.src = `podimg://img/${n}`;
      }), name);
      assert.ok(ok, 'cover loads through podimg://');
      const bad = await folder.evaluate(() => new Promise((res) => {
        const i = new Image();
        i.onload = () => res(true);
        i.onerror = () => res(false);
        i.src = 'podimg://img/..%2F..%2Fpods.json';
      }));
      assert.strictEqual(bad, false, 'podimg:// only serves our own picture files');
      await folder.screenshot({ path: path.join(SHOTS, '11-cover.png') });
    });

    await step('removing the cover from the hub works', async () => {
      const row = hubPage.locator('.pod', { hasText: 'E2E folder' });
      await row.locator('.pod-head').click();
      await row.getByRole('button', { name: 'Remove' }).click();
      await until(() => folder.evaluate(() => !document.documentElement.classList.contains('has-cover')), 3000, 'cover gone');
      await row.locator('.pod-head').click();
    });

    for (const theme of ['bento', 'nebula', 'latte', 'glass']) {
      await step(`theme ${theme} applies to the pod`, async () => {
        await hubPage.locator('.pod', { hasText: 'E2E folder' }).locator('.pod-head').click();
        const row = hubPage.locator('.pod', { hasText: 'E2E folder' });
        await row.getByRole('radio', { name: theme[0].toUpperCase() + theme.slice(1) }).click();
        await until(() => folder.evaluate((t) => document.documentElement.classList.contains(`theme-${t}`), theme), 3000, 'theme class');
        await row.locator('.pod-head').click();
        await wait(250);
        await folder.screenshot({ path: path.join(SHOTS, `12-theme-${theme}.png`) });
        await strip.screenshot({ path: path.join(SHOTS, `12-strip-${theme}.png`) });
        assert.strictEqual(readCfg().pods[0].theme, theme);
      });
    }

    await step('"Look" applies one theme to every pod', async () => {
      await hubPage.getByRole('button', { name: 'Bento theme for every pod' }).click();
      await wait(500);
      assert.ok(readCfg().pods.every((p) => p.theme === 'bento'));
      await until(() => strip.evaluate(() => document.documentElement.classList.contains('theme-bento')), 3000, 'strip bento');
      await strip.screenshot({ path: path.join(SHOTS, '13-strip-bento.png') });
    });

    await step('matching-tile icons render on accent chips', async () => {
      const row = hubPage.locator('.pod', { hasText: 'E2E folder' });
      await row.locator('.pod-head').click();
      await row.getByRole('radio', { name: 'Matching tiles' }).click();
      await until(() => folder.locator('.ic.chip .glyph').count().then((n) => n >= 3), 3000, 'chips');
      await folder.screenshot({ path: path.join(SHOTS, '14-bento-mono.png') });
      await row.getByRole('radio', { name: 'Original' }).click();
      await row.locator('.pod-head').click();
    });

    await step('files sent from Explorer are added to the pod the user picks', async () => {
      const sent = [mk('sent-1.txt'), mk('sent-2.txt'), mk('sent-3.txt')];
      await app.evaluate((_e, a) => global.__podsTest.offerPaths(a), sent);
      await until(() => hubPage.locator('#pending').isVisible(), 3000, 'picker shown');
      assert.match(await hubPage.locator('#pendingText').textContent(), /^3 items/);
      await hubPage.screenshot({ path: path.join(SHOTS, '15-send-to-picker.png') });
      const before = readCfg().pods[0].items.length;
      await hubPage.locator('#pendingPods .pick-pod', { hasText: 'E2E folder' }).click();
      await until(() => hubPage.locator('#pending').isHidden(), 3000, 'picker closed');
      await wait(500);
      assert.strictEqual(readCfg().pods[0].items.length, before + 3);
    });

    await step('lock all pins every pod in place', async () => {
      await hubPage.locator('#lockAll').check();
      await wait(400);
      assert.ok(readCfg().pods.every((p) => p.locked));
      const b0 = (await bounds())['E2E folder'];
      const box = await folder.locator('.label').boundingBox();
      await folder.mouse.move(box.x + 5, box.y + 5);
      await folder.mouse.down();
      for (let i = 1; i <= 8; i++) { await folder.mouse.move(box.x + 5 + i * 8, box.y + 5 + i * 6); await wait(20); }
      await folder.mouse.up();
      await wait(300);
      const b1 = (await bounds())['E2E folder'];
      near(b1, { x: b0.x, y: b0.y, width: b0.width, height: b0.height }, 1);
      assert.strictEqual((await state(folder)).open, false, 'dragging a locked pod must not open it');
      await hubPage.locator('#lockAll').uncheck();
      await wait(300);
      if ((await state(folder)).open) { await folder.keyboard.press('Escape'); await wait(500); }
    });

    await step('memory stays reasonable', async () => {
      // Private bytes = memory only this app holds (working set double-counts shared DLLs).
      const m = await app.evaluate(({ app: a }) => a.getAppMetrics().map((x) => [x.type, x.memory.privateBytes ?? x.memory.workingSetSize, x.memory.workingSetSize]));
      const mb = (k) => Math.round(k / 1024);
      const priv = m.reduce((n, x) => n + x[1], 0);
      console.log(`      private: ${mb(priv)} MB; per process: ${m.map((x) => `${x[0]} ${mb(x[1])}/${mb(x[2])}`).join(', ')}`);
      assert.ok(mb(priv) < 900, `${mb(priv)} MB`);
    });

    await step('z-order helper loaded', async () => {
      assert.ok(!logs.join('').includes('z-order helper unavailable'), logs.join(''));
    });

    await step('no errors logged by the app', async () => {
      const errs = logs.join('').split('\n').filter((l) => /error|uncaught|failed/i.test(l));
      assert.deepStrictEqual(errs, []);
    });
  } finally {
    await app.close().catch(() => {});
  }

  await step('config survives restart', async () => {
    const cfg = readCfg();
    assert.strictEqual(cfg.pods.length, 4);
    assert.strictEqual(cfg.pods[1].name, 'Renamed strip');
  });

  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`);
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
