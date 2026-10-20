'use strict';
/* global pods */
const api = window.pods;
const $ = (sel, root = document) => root.querySelector(sel);
const glass = $('#glass');
const closedEl = $('#closed');
const openEl = $('#open');
const toastEl = $('#toast');
const resizeEl = $('#resize');
const mqMotion = matchMedia('(prefers-reduced-motion: reduce)');
const mqTransp = matchMedia('(prefers-reduced-transparency: reduce)');

const ICON_PX = { s: 40, m: 52, l: 68 };
const OPEN_MS = 520;
const CLOSE_MS = 340;
const INTERNAL = 'application/x-pod-item';
const WALL_SCALE = 0.25;
// Accent each theme falls back to when the chosen colour would vanish on it.
const THEME_ACCENT = { bento: [255, 158, 199], nebula: [157, 120, 255], latte: [201, 122, 92] };
const FADED = { bento: ['clear', 'frost', 'smoke'], nebula: ['clear', 'frost', 'smoke'], latte: ['clear', 'frost'] };
const imgUrl = (name) => `podimg://img/${encodeURIComponent(name)}`;

const S = {
  pod: null,
  pad: 18,
  tints: {},
  strengths: {},
  pos: null,
  icons: {},          // path -> dataURL | null (missing) ; undefined = loading
  open: false,
  anim: false,
  busy: false,
  editing: false,
  pendingRender: false,
  plan: null,         // expand plan while open
  wall: null,         // payload from main
  wallImg: null,
  wallCanvas: null,
  wallDisp: null,
  wallUrl: null,
  sel: new Set(),     // selected item ids (Ctrl/Shift+click)
  anchor: null,       // last plainly clicked/selected item, for Shift ranges
};
window.__podState = S; // read by automated tests

// ---- small helpers ------------------------------------------------------------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const SVG = {
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  more: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/></svg>',
  left: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.6" fill="currentColor"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
};
function iconButton(cls, svg, label, action) {
  const b = el('button', `btn ${cls}`);
  b.innerHTML = svg; // static markup only
  b.title = label;
  b.setAttribute('aria-label', label);
  b.dataset.action = action;
  return b;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

// ---- rendering ------------------------------------------------------------------
function iconEl(it) {
  // A picture the user chose wins over the Windows icon, and keeps its own colours.
  if (it.icon) {
    const img = el('img', `ic custom${it.icon.endsWith('.jpg') ? ' photo' : ''}`);
    img.src = imgUrl(it.icon);
    img.alt = '';
    img.draggable = false;
    return img;
  }
  const src = S.icons[it.path];
  if (!src) return el('div', 'ic ph');
  const img = el('img', 'ic');
  img.src = src;
  img.alt = '';
  img.draggable = false;
  if (S.pod.iconStyle !== 'mono') return img;
  // "Matching tiles": the icon becomes a one-colour glyph on an accent tile.
  img.className = 'glyph';
  const chip = el('span', 'ic chip');
  chip.append(img);
  return chip;
}

function tile(it, { label = true, draggable = false } = {}) {
  const t = el('div', 'tile');
  const missing = S.icons[it.path] === null;
  t.dataset.item = it.id;
  t.tabIndex = 0;
  t.setAttribute('role', 'button');
  t.setAttribute('aria-label', missing ? `${it.name} (missing)` : it.name);
  t.title = missing ? `${it.name}\nFile was moved or deleted` : it.name;
  if (missing) t.classList.add('missing');
  t.append(iconEl(it));
  if (label) t.append(el('span', 'nm', it.name));
  if (draggable) t.draggable = true;
  return t;
}

function emptyState(text) {
  const box = el('div', 'empty');
  box.append(el('span', null, text));
  const add = iconButton('', SVG.plus, 'Add files or apps', 'add');
  box.append(add);
  return box;
}

const isPhotoOnly = () => !!S.pod.cover && !S.pod.items.length;
// Folder pods stay their size and scroll inside unless "springs open" is chosen.
const springs = () => S.pod.style === 'folder' && S.pod.expand;

// Every item with its name, in a grid that scrolls inside the pod.
function renderFolderList(prevScroll) {
  const p = S.pod;
  const wrap = el('div', 'folder list');
  const head = el('div', 'shead');
  const n = p.items.length;
  head.append(el('span', 'nm', p.name), el('span', 'scount', n ? String(n) : ''));
  wrap.append(head);
  if (isPhotoOnly()) return wrap;
  if (!n) {
    wrap.append(emptyState('Drop files or apps here'));
    return wrap;
  }
  const grid = el('div', 'sgrid');
  for (const it of p.items) grid.append(tile(it));
  wrap.append(grid);
  const sync = () => grid.classList.toggle('more', grid.scrollTop + grid.clientHeight < grid.scrollHeight - 2);
  grid.addEventListener('scroll', sync, { passive: true });
  requestAnimationFrame(() => {
    if (prevScroll) grid.scrollTop = prevScroll;
    sync();
  });
  return wrap;
}

function renderFolderClosed() {
  const p = S.pod;
  const wrap = el('div', 'folder');
  if (isPhotoOnly()) {
    wrap.append(el('div', 'spacer'));
  } else if (!p.items.length) {
    wrap.append(emptyState('Drop files or apps here'));
  } else {
    const grid = el('div', 'cgrid');
    const cluster = p.items.length > 4;
    const direct = cluster ? p.items.slice(0, 3) : p.items.slice(0, 4);
    for (const it of direct) {
      const c = el('div', 'cell');
      c.append(tile(it, { label: false }));
      grid.append(c);
    }
    if (cluster) {
      const c = el('div', 'cell');
      const b = el('div', 'cluster');
      b.dataset.action = 'open';
      b.tabIndex = 0;
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', `Show all ${p.items.length} items`);
      b.title = `Show all ${p.items.length}`;
      for (const it of p.items.slice(3, 7)) b.append(iconEl(it));
      c.append(b);
      grid.append(c);
    }
    wrap.append(grid);
  }
  wrap.append(el('div', 'label', p.name));
  if (p.items.length) wrap.append(el('span', 'badge', String(p.items.length).padStart(2, '0')));
  return wrap;
}

function renderStrip(prevScroll) {
  const p = S.pod;
  const wrap = el('div', 'strip');
  const head = el('div', 'shead');
  const name = el('span', 'nm', p.name);
  const dots = el('div', 'dots');
  head.append(name, dots);
  wrap.append(head);
  if (isPhotoOnly()) return wrap;
  if (!p.items.length) {
    wrap.append(emptyState('Drop files or apps here'));
    return wrap;
  }
  const track = el('div', 'track');
  track.style.setProperty('--n', p.visible);
  for (const it of p.items) track.append(tile(it));
  const prev = iconButton('arrow prev', SVG.left, 'Previous', 'prev');
  const next = iconButton('arrow next', SVG.right, 'Next', 'next');
  wrap.append(track, prev, next);
  const sync = () => syncStrip(track, dots, prev, next);
  track.addEventListener('scroll', sync, { passive: true });
  track.addEventListener('wheel', onStripWheel, { passive: false });
  requestAnimationFrame(() => {
    if (prevScroll) track.scrollLeft = prevScroll;
    sync();
  });
  return wrap;
}

function syncStrip(track, dots, prev, next) {
  const w = track.clientWidth || 1;
  const pages = Math.ceil(S.pod.items.length / S.pod.visible);
  const max = track.scrollWidth - w;
  const page = track.scrollLeft >= max - 2 ? pages - 1 : Math.round(track.scrollLeft / w);
  if (dots.childElementCount !== (pages > 1 ? pages : 0)) {
    dots.replaceChildren(...(pages > 1 ? Array.from({ length: pages }, () => el('span', 'dot')) : []));
  }
  [...dots.children].forEach((d, i) => d.classList.toggle('on', i === page));
  prev.disabled = track.scrollLeft <= 2;
  next.disabled = track.scrollLeft >= max - 2;
}

function pageStrip(dir) {
  const track = $('.track', closedEl);
  if (!track) return;
  track.scrollBy({ left: dir * track.clientWidth, behavior: mqMotion.matches ? 'auto' : 'smooth' });
}

let wheelLock = 0;
function onStripWheel(e) {
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // touchpad sideways: native scrolling
  e.preventDefault();
  const now = performance.now();
  if (now < wheelLock || Math.abs(e.deltaY) < 4) return;
  wheelLock = now + 380;
  pageStrip(e.deltaY > 0 ? 1 : -1);
}

function renderOpen() {
  const p = S.pod;
  const head = el('div', 'ohead');
  const name = el('div', 'oname', p.name);
  name.title = 'Double-click to rename';
  name.addEventListener('dblclick', () => startPodRename());
  const n = p.items.length;
  head.append(
    name,
    el('span', 'ocount', `${n} item${n === 1 ? '' : 's'}`),
    iconButton('', SVG.plus, 'Add files or apps', 'add'),
    iconButton('', SVG.more, 'Pod options', 'more'),
  );
  const grid = el('div', 'ogrid');
  if (!n) grid.append(emptyState('Drop files or apps here'));
  for (const it of p.items) grid.append(tile(it, { draggable: true }));
  return [head, grid];
}

function closedRadius() {
  const m = Math.min(S.pod.w, S.pod.h);
  return Math.round(Math.min(30, Math.max(16, m * 0.16)));
}

function render() {
  S.pendingRender = false;
  const p = S.pod;
  document.title = p.name;
  glass.classList.toggle('locked', p.locked);
  glass.setAttribute('aria-label', p.name);
  document.documentElement.style.setProperty('--icon', `${ICON_PX[p.iconSize]}px`);
  document.documentElement.style.setProperty('--r-closed', `${closedRadius()}px`);
  const root = document.documentElement;
  for (const c of [...root.classList]) if (c.startsWith('theme-')) root.classList.remove(c);
  root.classList.add(`theme-${p.theme}`);
  root.classList.toggle('icons-mono', p.iconStyle === 'mono');
  root.classList.toggle('has-cover', !!p.cover);
  root.classList.toggle('photo-only', isPhotoOnly());
  const cover = $('.cover', glass);
  if (p.cover) cover.style.setProperty('background-image', `url("${imgUrl(p.cover)}")`);
  else cover.style.removeProperty('background-image');
  for (const id of [...S.sel]) if (!p.items.some((x) => x.id === id)) S.sel.delete(id);

  const prevScroll = $('.track', closedEl)?.scrollLeft || 0;
  const prevGridScroll = $('.ogrid', openEl)?.scrollTop || 0;
  const prevListScroll = $('.sgrid', closedEl)?.scrollTop || 0;
  closedEl.replaceChildren(p.style === 'strip' ? renderStrip(prevScroll) : springs() ? renderFolderClosed() : renderFolderList(prevListScroll));
  openEl.replaceChildren(...(springs() ? renderOpen() : []));
  const g = $('.ogrid', openEl);
  if (g) g.scrollTop = prevGridScroll;
  if (document.documentElement.classList.contains('test-mode')) closedEl.append(el('span', 'test-badge', 'Test'));
  if (p.locked) {
    const m = el('span', 'lockmark');
    m.innerHTML = SVG.lock; // static markup only
    m.title = 'Locked in place (right-click to unlock)';
    closedEl.append(m);
  }
  paintSel();
  applyLook();
}

function paintSel() {
  document.querySelectorAll('[data-item]').forEach((t) => {
    const on = S.sel.has(t.dataset.item);
    t.classList.toggle('selected', on);
    t.setAttribute('aria-pressed', String(on));
  });
}

function requestRender() {
  if (S.editing || S.anim) S.pendingRender = true;
  else render();
}
function flushRender() {
  if (S.pendingRender && !S.editing && !S.anim) render();
}

// ---- glass look: blurred wallpaper + tint + adaptive label colour ---------------
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function setWallpaper(payload) {
  S.wall = payload;
  S.wallImg = null;
  S.wallCanvas = null;
  S.wallUrl = null;
  if (!payload) return applyLook();
  const img = new Image();
  img.onload = () => {
    if (S.wall !== payload) return;
    S.wallImg = img;
    buildWall();
  };
  img.onerror = () => applyLook();
  img.src = payload.url;
}

// Recreate the desktop as Windows lays it out, small and blurred.
function buildWall() {
  const w = S.wall;
  if (!S.wallImg || !S.pos || !w) return applyLook();
  const disp = w.style === 'span' ? S.pos.virtual : S.pos.display;
  const k = WALL_SCALE;
  const W = Math.max(8, Math.round(disp.width * k));
  const H = Math.max(8, Math.round(disp.height * k));
  const base = canvas(W, H);
  const c = base.getContext('2d');
  c.fillStyle = `rgb(${w.color.join(',')})`;
  c.fillRect(0, 0, W, H);
  const iw = w.natural.width;
  const ih = w.natural.height;
  const draw = (x, y, dw, dh) => c.drawImage(S.wallImg, x, y, dw, dh);
  switch (w.style) {
    case 'stretch': draw(0, 0, W, H); break;
    case 'fit': { const s = Math.min(W / iw, H / ih); draw((W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s); break; }
    case 'center': draw((W - iw * k) / 2, (H - ih * k) / 2, iw * k, ih * k); break;
    case 'tile': for (let y = 0; y < H; y += ih * k) for (let x = 0; x < W; x += iw * k) draw(x, y, iw * k, ih * k); break;
    default: { const s = Math.max(W / iw, H / ih); draw((W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s); }
  }
  // Pad before blurring so screen edges don't fade to transparent.
  const p = 16;
  const big = canvas(W + 2 * p, H + 2 * p);
  big.getContext('2d').drawImage(base, 0, 0, W + 2 * p, H + 2 * p);
  const out = canvas(W, H);
  const o = out.getContext('2d', { willReadFrequently: true });
  o.filter = 'blur(7px) saturate(1.45)';
  o.drawImage(big, -p, -p);
  S.wallCanvas = out;
  S.wallDisp = disp;
  S.wallUrl = out.toDataURL('image/jpeg', 0.9);
  applyLook();
}

function placeWall() {
  if (!S.pos || !S.wallDisp) return;
  const d = S.wallDisp;
  glass.style.setProperty('--wall-size', `${d.width}px ${d.height}px`);
  glass.style.setProperty('--wall-pos', `${d.x - S.pos.winX}px ${d.y - S.pos.winY}px`);
}

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));

// Average colour of the wallpaper right behind this pod.
function colourBehind() {
  if (!S.wallCanvas || !S.pos || !S.wallDisp) return null;
  const d = S.wallDisp;
  const k = WALL_SCALE;
  const x = Math.floor((S.pos.winX + S.pad - d.x) * k);
  const y = Math.floor((S.pos.winY + S.pad - d.y) * k);
  const w = Math.max(1, Math.floor(glass.offsetWidth * k));
  const h = Math.max(1, Math.floor(glass.offsetHeight * k));
  const cx = Math.max(0, Math.min(x, S.wallCanvas.width - 1));
  const cy = Math.max(0, Math.min(y, S.wallCanvas.height - 1));
  const cw = Math.max(1, Math.min(w, S.wallCanvas.width - cx));
  const ch = Math.max(1, Math.min(h, S.wallCanvas.height - cy));
  const data = S.wallCanvas.getContext('2d', { willReadFrequently: true }).getImageData(cx, cy, cw, ch).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 16) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  return n ? [r / n, g / n, b / n] : null;
}

function applyLook() {
  if (!S.pod) return;
  const t = S.pod.tint;
  const rgb = S.tints[t.color] || [244, 246, 250];
  const theme = S.pod.theme;
  if (theme !== 'glass' || S.pod.cover) {
    // Solid themes (and any pod with a cover photo) don't need the wallpaper copy.
    glass.classList.remove('solid');
    glass.style.removeProperty('--wall');
    const accent = theme === 'glass' || FADED[theme].includes(t.color) ? (THEME_ACCENT[theme] || [255, 255, 255]) : rgb;
    // On the root, so theme variables built from it (--chip, --focus) resolve to this accent.
    const rs = document.documentElement.style;
    rs.setProperty('--accent', `rgb(${accent.join(',')})`);
    rs.setProperty('--accent-soft', `rgba(${accent.join(',')},0.16)`);
    rs.setProperty('--accent-glow', `rgba(${accent.join(',')},0.3)`);
    // A cover photo gets a dark scrim, so labels are light; latte is the one light theme.
    document.documentElement.classList.toggle('ink-dark', theme === 'latte' && !S.pod.cover);
    return;
  }
  const alpha = t.color === 'clear' ? 0.05 : S.strengths[t.strength] ?? 0.3;
  let surface;
  if (mqTransp.matches) {
    // Windows "Transparency effects" off: solid surface, no blur.
    const light = luminance(rgb) > 0.6;
    surface = light ? mix([233, 235, 240], rgb, 0.25) : mix([40, 43, 51], rgb, 0.55);
    glass.classList.add('solid');
    glass.style.setProperty('--solid', `rgb(${surface.join(',')})`);
    glass.style.removeProperty('--wall');
  } else {
    glass.classList.remove('solid');
    const useWall = S.wallUrl && t.blur;
    if (useWall) {
      glass.style.setProperty('--wall', `url("${S.wallUrl}")`);
      placeWall();
    } else {
      glass.style.removeProperty('--wall');
    }
    glass.style.setProperty('--tint', `rgba(${rgb.join(',')},${alpha})`);
    // Without the blurred wallpaper the desktop shows through, so use a stronger veil.
    glass.style.setProperty('--veil', useWall ? 'rgba(10,12,18,0.1)' : 'rgba(10,12,18,0.22)');
    const behind = colourBehind() || [60, 64, 72];
    const veiled = mix(behind, [10, 12, 18], useWall ? 0.1 : 0.22);
    surface = mix(veiled, rgb, alpha);
  }
  // Pick whichever label colour has the better contrast (crossover ~0.2 luminance).
  document.documentElement.classList.toggle('ink-dark', luminance(surface) > 0.2);
}

let lookQueued = false;
function queueLook() {
  if (lookQueued) return;
  lookQueued = true;
  requestAnimationFrame(() => { lookQueued = false; applyLook(); });
}

// ---- open / close -------------------------------------------------------------
function setRect(r) {
  glass.style.left = `${r.x}px`;
  glass.style.top = `${r.y}px`;
  glass.style.width = `${r.w}px`;
  glass.style.height = `${r.h}px`;
}
function clearRect() {
  for (const k of ['left', 'top', 'width', 'height']) glass.style.removeProperty(k);
}
function waitTransition(ms) {
  if (mqMotion.matches) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      glass.removeEventListener('transitionend', onEnd);
      resolve();
    };
    const onEnd = (e) => { if (e.target === glass && e.propertyName === 'width') finish(); };
    glass.addEventListener('transitionend', onEnd);
    setTimeout(finish, ms + 150);
  });
}

async function openPod() {
  if (S.open || S.anim || !springs()) return;
  S.anim = true;
  const cw = glass.offsetWidth;
  const ch = glass.offsetHeight;
  setRect({ x: S.pad, y: S.pad, w: cw, h: ch });
  closedEl.style.setProperty('--cw', `${cw}px`);
  closedEl.style.setProperty('--ch', `${ch}px`);
  const plan = await api.expand(false);
  if (!plan) { clearRect(); S.anim = false; return; }
  if (plan.shifted) { glass.style.opacity = '0'; await nextFrame(); }
  await api.expand(true);
  S.plan = plan;
  setRect(plan.from);
  openEl.style.setProperty('--ow', `${plan.to.w}px`);
  openEl.style.setProperty('--oh', `${plan.to.h}px`);
  glass.style.opacity = '';
  void glass.offsetWidth; // commit the start frame before animating
  glass.classList.add('anim', 'opening', 'is-open');
  openEl.setAttribute('aria-hidden', 'false');
  closedEl.setAttribute('aria-hidden', 'true');
  setRect(plan.to);
  S.open = true;
  await waitTransition(OPEN_MS);
  glass.classList.remove('anim', 'opening');
  clearRect();
  openEl.style.removeProperty('--ow');
  openEl.style.removeProperty('--oh');
  S.anim = false;
  glass.focus({ preventScroll: true });
  queueLook();
  flushRender();
}

async function closePod() {
  if (!S.open || S.anim) return;
  S.anim = true;
  const plan = S.plan;
  const cur = { x: S.pad, y: S.pad, w: glass.offsetWidth, h: glass.offsetHeight };
  openEl.style.setProperty('--ow', `${cur.w}px`);
  openEl.style.setProperty('--oh', `${cur.h}px`);
  setRect(cur);
  void glass.offsetWidth;
  glass.classList.add('anim', 'closing');
  glass.classList.remove('is-open');
  openEl.setAttribute('aria-hidden', 'true');
  closedEl.setAttribute('aria-hidden', 'false');
  setRect(plan.from);
  await waitTransition(CLOSE_MS);
  if (plan.shifted) { glass.style.opacity = '0'; await nextFrame(); }
  glass.classList.remove('anim', 'closing');
  await api.collapse();
  clearRect();
  glass.style.opacity = '';
  closedEl.style.removeProperty('--cw');
  closedEl.style.removeProperty('--ch');
  openEl.style.removeProperty('--ow');
  openEl.style.removeProperty('--oh');
  S.open = false;
  S.plan = null;
  S.anim = false;
  queueLook();
  flushRender();
}

// ---- actions ------------------------------------------------------------------------
async function launch(itemId) {
  const r = await api.launch(itemId);
  if (!r) return;
  if (!r.ok) return toast(r.error);
  if (S.open) closePod();
}

async function menu(itemId) {
  // Right-clicking outside the selection starts fresh, like Explorer.
  if (itemId && !S.sel.has(itemId)) clearSel();
  S.busy = true;
  try { await api.contextMenu(itemId, itemId ? [...S.sel] : []); } finally { S.busy = false; }
}

// ---- selection: Ctrl+click toggles, Shift+click selects a range ----------------
function select(itemId, e) {
  const ids = S.pod.items.map((x) => x.id);
  if (e.shiftKey && S.anchor && ids.includes(S.anchor)) {
    const [a, b] = [ids.indexOf(S.anchor), ids.indexOf(itemId)].sort((x, y) => x - y);
    if (!e.ctrlKey) S.sel.clear();
    for (const id of ids.slice(a, b + 1)) S.sel.add(id);
  } else {
    if (S.sel.has(itemId)) S.sel.delete(itemId);
    else S.sel.add(itemId);
    S.anchor = itemId;
  }
  paintSel();
}
function clearSel() {
  if (!S.sel.size) return false;
  S.sel.clear();
  paintSel();
  return true;
}
const wantsSelect = (e) => e.ctrlKey || e.shiftKey || e.metaKey;

function doAction(action) {
  switch (action) {
    case 'open': return openPod();
    case 'add': return api.addDialog('file');
    case 'more': return menu(null);
    case 'prev': return pageStrip(-1);
    case 'next': return pageStrip(1);
  }
}

function inlineEdit(target, value, onCommit) {
  S.editing = true;
  const input = el('input', 'inline-edit');
  input.value = value;
  input.spellcheck = false;
  input.maxLength = 120;
  input.setAttribute('aria-label', 'New name');
  target.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (commit && v && v !== value) await onCommit(v);
    input.replaceWith(target);
    S.editing = false;
    flushRender();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
}

async function startPodRename() {
  if (S.editing) return;
  if (springs()) {
    if (!S.open) await openPod();
    const t = $('.oname', openEl);
    if (t) inlineEdit(t, S.pod.name, (v) => api.rename(v));
  } else {
    const t = $('.shead .nm', closedEl);
    if (t) inlineEdit(t, S.pod.name, (v) => api.rename(v));
  }
}

async function startItemRename(itemId) {
  if (S.editing) return;
  const it = S.pod.items.find((x) => x.id === itemId);
  if (!it) return;
  let scope = closedEl;
  if (springs()) {
    if (!S.open) await openPod();
    scope = openEl;
  }
  const t = $(`[data-item="${CSS.escape(itemId)}"] .nm`, scope);
  if (t) {
    t.closest('.tile').scrollIntoView({ block: 'nearest', inline: 'nearest' });
    inlineEdit(t, it.name, (v) => api.renameItem(itemId, v));
  }
}

// ---- pointer: click to open/launch, drag to move, corner to resize ---------------
let press = null;
let moveQueued = null;

function queueMove(dx, dy) {
  const first = !moveQueued;
  moveQueued = [dx, dy];
  if (first) requestAnimationFrame(() => { if (moveQueued) { api.dragMove(...moveQueued); moveQueued = null; } });
}

glass.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || S.anim || S.editing || S.open) return;
  if (e.target.closest('#resize, button, input')) return;
  // Grabbing the list's scrollbar scrolls it instead of moving the pod.
  const sc = e.target.closest('.sgrid');
  if (sc && e.target === sc && e.offsetX >= sc.clientWidth) return;
  press = { id: e.pointerId, sx: e.screenX, sy: e.screenY, moved: false, target: e.target };
  glass.setPointerCapture(e.pointerId);
});

glass.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  const dx = e.screenX - press.sx;
  const dy = e.screenY - press.sy;
  if (!press.moved) {
    if (Math.hypot(dx, dy) < 5) return;
    // A locked pod ignores the drag, and releasing it must not count as a click either.
    if (S.pod.locked) { press.dead = true; return; }
    press.moved = true;
    glass.classList.add('dragging');
    api.dragStart();
  }
  queueMove(dx, dy);
});

function endPress(e, cancelled) {
  if (!press || e.pointerId !== press.id) return;
  const p = press;
  press = null;
  if (p.moved) {
    if (moveQueued) { api.dragMove(...moveQueued); moveQueued = null; }
    api.dragEnd();
    glass.classList.remove('dragging');
    queueLook();
    return;
  }
  if (cancelled || p.dead) return;
  const t = p.target.closest('[data-item], [data-action]');
  if (t?.dataset.item && wantsSelect(e)) return select(t.dataset.item, e);
  clearSel();
  if (t?.dataset.item) { S.anchor = t.dataset.item; return launch(t.dataset.item); }
  if (t?.dataset.action) return doAction(t.dataset.action);
  if (springs() && !isPhotoOnly()) openPod();
}
glass.addEventListener('pointerup', (e) => endPress(e, false));
glass.addEventListener('pointercancel', (e) => endPress(e, true));

glass.addEventListener('click', (e) => {
  const a = e.target.closest('button[data-action]');
  if (a) return doAction(a.dataset.action);
  if (!S.open || S.anim) return;
  const t = e.target.closest('[data-item]');
  if (t && wantsSelect(e)) return select(t.dataset.item, e);
  clearSel();
  if (t) { S.anchor = t.dataset.item; launch(t.dataset.item); }
});

let rs = null;
let resizeQueued = null;
resizeEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || S.pod.locked || S.anim) return;
  e.stopPropagation();
  rs = { id: e.pointerId, sx: e.screenX, sy: e.screenY, w: glass.offsetWidth, h: glass.offsetHeight };
  resizeEl.setPointerCapture(e.pointerId);
});
resizeEl.addEventListener('pointermove', (e) => {
  if (!rs || e.pointerId !== rs.id) return;
  const first = !resizeQueued;
  resizeQueued = [Math.round(rs.w + e.screenX - rs.sx), Math.round(rs.h + e.screenY - rs.sy)];
  if (first) requestAnimationFrame(() => { if (resizeQueued) { api.resize(...resizeQueued); resizeQueued = null; } });
});
const endResize = (e) => {
  if (!rs || e.pointerId !== rs.id) return;
  rs = null;
  if (resizeQueued) { api.resize(...resizeQueued); resizeQueued = null; }
  api.resizeEnd();
  queueLook();
};
resizeEl.addEventListener('pointerup', endResize);
resizeEl.addEventListener('pointercancel', endResize);

glass.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (S.anim || S.editing) return;
  menu(e.target.closest('[data-item]')?.dataset.item);
});

document.addEventListener('keydown', (e) => {
  if (S.editing) return;
  if (e.key === 'Escape') {
    if (clearSel()) return;
    if (S.open) closePod();
    else api.escape();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && (S.open || !springs())) {
    e.preventDefault();
    S.pod.items.forEach((x) => S.sel.add(x.id));
    paintSel();
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    const t = document.activeElement?.closest?.('[data-item], [data-action]');
    if (!t || t.tagName === 'BUTTON') return;
    e.preventDefault();
    if (t.dataset.item && e.key === ' ' && e.ctrlKey) select(t.dataset.item, e);
    else if (t.dataset.item) launch(t.dataset.item);
    else doAction(t.dataset.action);
  }
  if (e.key === 'F2') {
    const t = document.activeElement?.closest?.('[data-item]');
    if (t) startItemRename(t.dataset.item);
    else startPodRename();
  }
});

window.addEventListener('blur', () => {
  setTimeout(() => {
    if (S.open && !S.busy && !S.editing && !document.hasFocus()) closePod();
  }, 60);
});

// ---- drag & drop: files from Explorer add links; tiles reorder ------------------
const isInternal = (e) => [...e.dataTransfer.types].includes(INTERNAL);
const isFiles = (e) => !isInternal(e) && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

let dragDepth = 0;
let dragItem = null;
function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
}
glass.addEventListener('dragenter', (e) => {
  if (!isFiles(e)) return;
  dragDepth++;
  glass.classList.add('dropping');
});
glass.addEventListener('dragleave', (e) => {
  if (!isFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; glass.classList.remove('dropping'); }
});
glass.addEventListener('dragover', (e) => {
  if (isFiles(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
  } else if (isInternal(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    const t = e.target.closest('.ogrid [data-item]');
    if (t && t.dataset.item !== dragItem) {
      const r = t.getBoundingClientRect();
      t.classList.add(e.clientX > r.left + r.width / 2 ? 'drop-after' : 'drop-before');
    }
  }
});
glass.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  glass.classList.remove('dropping');
  if (isInternal(e)) {
    const id = e.dataTransfer.getData(INTERNAL);
    const t = e.target.closest('.ogrid [data-item]');
    clearDropMarks();
    if (!id || !t) return;
    let before = t.dataset.item;
    const r = t.getBoundingClientRect();
    if (e.clientX > r.left + r.width / 2) before = t.nextElementSibling?.dataset.item || null;
    if (before !== id) api.reorder(id, before);
    return;
  }
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return toast('Only files, folders and shortcuts can be added.');
  const n = await api.addPaths(paths);
  toast(n ? `Added ${n} link${n === 1 ? '' : 's'}` : 'Already in this pod');
});
openEl.addEventListener('dragstart', (e) => {
  const t = e.target.closest?.('[data-item]');
  if (!t) return;
  dragItem = t.dataset.item;
  e.dataTransfer.setData(INTERNAL, dragItem);
  e.dataTransfer.effectAllowed = 'move';
  t.classList.add('lifting');
});
openEl.addEventListener('dragend', (e) => {
  e.target.closest?.('[data-item]')?.classList.remove('lifting');
  dragItem = null;
  clearDropMarks();
});

// ---- wiring --------------------------------------------------------------------------
async function loadIcons() {
  const map = (await api.icons()) || {};
  let changed = false;
  for (const [k, v] of Object.entries(map)) {
    if (S.icons[k] !== v) { S.icons[k] = v; changed = true; }
  }
  if (changed) requestRender();
}

(async function init() {
  const d = await api.init();
  Object.assign(S, { pod: d.pod, pad: d.pad, tints: d.tints, strengths: d.strengths, pos: d.pos });
  document.documentElement.style.setProperty('--pad', `${d.pad}px`);
  if (d.testMode) document.documentElement.classList.add('test-mode');
  render();
  setWallpaper(d.wallpaper);
  loadIcons();

  api.onUpdate((pod) => {
    const known = new Set(Object.keys(S.icons));
    S.pod = pod;
    if (S.open && !(pod.style === 'folder' && pod.expand)) {
      S.pendingRender = true;
      closePod();
    } else {
      requestRender();
    }
    if (pod.items.some((it) => !known.has(it.path))) loadIcons();
  });
  api.onPos((pos) => {
    const prev = S.pos;
    S.pos = pos;
    const disp = S.wall?.style === 'span' ? pos.virtual : pos.display;
    const sameDisplay = prev && S.wallDisp && disp.x === S.wallDisp.x && disp.y === S.wallDisp.y
      && disp.width === S.wallDisp.width && disp.height === S.wallDisp.height;
    if (S.wallImg && !sameDisplay) buildWall();
    else { placeWall(); queueLook(); }
  });
  api.onWallpaper(setWallpaper);
  api.onCommand((cmd) => {
    if (cmd.type === 'rename-pod') startPodRename();
    if (cmd.type === 'rename-item') startItemRename(cmd.itemId);
    if (cmd.type === 'close') closePod();
    if (cmd.type === 'flash') {
      glass.classList.remove('flash');
      void glass.offsetWidth;
      glass.classList.add('flash');
      setTimeout(() => glass.classList.remove('flash'), 1700);
    }
  });
  api.onToast(toast);
  api.onBusy((b) => { S.busy = b; });
  mqTransp.addEventListener('change', applyLook);
  document.documentElement.dataset.ready = '1';
})();
