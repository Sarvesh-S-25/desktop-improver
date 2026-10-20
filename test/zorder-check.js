'use strict';
// Visual check of desktop layering. Opens two test pods plus an opaque
// "other app" window, captures ONLY that small screen region, saves PNGs.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'pods-zorder');
const REGION = { x: 0, y: 0, width: 620, height: 320 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pods-z-'));
  const sys = (n) => path.join(process.env.SystemRoot, 'System32', n);
  fs.writeFileSync(path.join(data, 'pods.json'), JSON.stringify({
    pods: [
      { name: 'Z folder', x: 40, y: 40, items: [sys('notepad.exe'), sys('calc.exe')].map((p) => ({ path: p })) },
      { name: 'Z strip', style: 'strip', x: 250, y: 60, items: [sys('notepad.exe'), sys('calc.exe'), sys('charmap.exe')].map((p) => ({ path: p })) },
    ],
  }));
  const app = await electron.launch({ executablePath: require('electron'), args: [ROOT, `--data=${data}`, '--no-hotkey'] });
  const shot = async (name) => {
    await wait(700);
    const b64 = await app.evaluate(async ({ desktopCapturer, screen }, region) => {
      const d = screen.getPrimaryDisplay();
      const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
      const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
      const img = src.thumbnail;
      const k = img.getSize().width / d.size.width;
      return img.crop({ x: Math.round(region.x * k), y: Math.round(region.y * k), width: Math.round(region.width * k), height: Math.round(region.height * k) })
        .resize({ width: region.width }).toPNG().toString('base64');
    }, REGION);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(b64, 'base64'));
    console.log('saved', name);
  };
  try {
    await wait(2500);
    console.log('z-order helper available:', await app.evaluate(() => global.__podsTest.zorder));
    await shot('z1-pods-on-desktop.png');

    // An opaque window standing in for another app, focused like a user clicked it.
    await app.evaluate(({ BrowserWindow }) => {
      const w = new BrowserWindow({ x: 20, y: 20, width: 560, height: 260, backgroundColor: '#c0392b', title: 'Other app', frame: true });
      w.loadURL('data:text/html,<body style="background:%23c0392b;color:white;font:24px Segoe UI;display:grid;place-items:center;height:90vh">Other app window</body>');
      global.__other = w;
      w.focus();
    });
    await shot('z2-other-app-covers-pods.png');

    await app.evaluate(() => global.__podsTest.setFront(true));
    await shot('z3-hotkey-brings-pods-front.png');

    await app.evaluate(() => global.__other.focus());
    await wait(300);
    console.log('front mode after clicking other app:', await app.evaluate(() => global.__podsTest.isFront()));
    await shot('z4-click-away-sends-pods-back.png');

    await app.evaluate(() => global.__other.destroy());
    await shot('z5-pods-still-on-desktop.png');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
