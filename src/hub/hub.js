'use strict';
/* global hub */
const api = window.hub;
const $ = (s) => document.querySelector(s);

const TINT_NAMES = { clear: 'Clear', frost: 'Frost', smoke: 'Smoke', ocean: 'Ocean', rose: 'Rose', mint: 'Mint', amber: 'Amber', lavender: 'Lavender', terracotta: 'Terracotta' };
const THEMES = [
  ['glass', 'Glass', 'Frosted, shows your wallpaper'],
  ['bento', 'Bento', 'Black cards, bright accent'],
  ['nebula', 'Nebula', 'Deep violet with a glow'],
  ['latte', 'Latte', 'Warm cream, photo-friendly'],
];
const STRENGTH_ALPHA = { light: 0.16, medium: 0.3, strong: 0.5 };
const CHEVRON = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let S = null;
const expanded = new Set();
let recording = false;
let renderQueued = false;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function miniPod(p) {
  const photo = p.cover && !p.count;
  const m = el('span', `mini mini-${photo ? 'photo' : p.style} t-${p.theme}`);
  m.setAttribute('aria-hidden', 'true');
  const rgb = S.tints[p.tint.color] || [244, 246, 250];
  const a = p.tint.color === 'clear' ? 0.05 : STRENGTH_ALPHA[p.tint.strength];
  m.style.setProperty('--t', `rgba(${rgb.join(',')},${a})`);
  m.style.setProperty('--a', `rgb(${rgb.join(',')})`);
  if (p.cover) {
    m.classList.add('with-cover');
    m.style.setProperty('background-image', `url("podimg://img/${encodeURIComponent(p.cover)}")`);
  }
  if (photo) {
    m.append(el('s'));
  } else if (p.style === 'folder') {
    m.append(el('i'), el('i'), el('i'));
    const b = el('b');
    for (let k = 0; k < 4; k++) b.append(el('i'));
    m.append(b);
  } else {
    m.append(el('i'), el('i'), el('i'));
    const dots = el('em');
    for (let k = 0; k < 3; k++) dots.append(el('u'));
    m.append(dots);
  }
  return m;
}

// A segmented control built as a radio group.
function seg(label, options, current, onPick) {
  const g = el('div', 'seg');
  g.setAttribute('role', 'radiogroup');
  g.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const b = el('button', null, text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(value === current));
    b.addEventListener('click', () => onPick(value));
    g.append(b);
  }
  return g;
}

function settingRow(label, control) {
  const r = el('div', 'row');
  r.append(el('span', 'row-label', label), control);
  return r;
}

function podBody(p) {
  const body = el('div', 'pod-body');
  const id = p.id;

  const name = el('input', 'name-input');
  name.value = p.name;
  name.maxLength = 60;
  name.setAttribute('aria-label', 'Pod name');
  const commitName = () => {
    const v = name.value.trim();
    if (v && v !== p.name) api.update(id, { name: v });
    else name.value = p.name;
  };
  name.addEventListener('change', commitName);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  body.append(settingRow('Name', name));

  body.append(settingRow('Style', seg('Style', [['folder', 'Folder'], ['strip', 'Strip']], p.style, (v) => api.update(id, { style: v }))));
  if (p.style === 'folder') {
    body.append(settingRow('When clicked', seg('When clicked', [[false, 'Stay small, scroll'], [true, 'Spring open']], p.expand, (v) => api.update(id, { expand: v }))));
  }
  if (p.style === 'strip') {
    body.append(settingRow('Items shown at once', seg('Items shown at once', [2, 3, 4, 5, 6].map((n) => [n, String(n)]), p.visible, (v) => api.update(id, { visible: v }))));
  }
  body.append(settingRow('Icon size', seg('Icon size', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], p.iconSize, (v) => api.update(id, { iconSize: v }))));
  body.append(settingRow('Theme', seg('Theme', THEMES.map(([k, n]) => [k, n]), p.theme, (v) => api.update(id, { theme: v }))));
  body.append(settingRow('Icons', seg('Icons', [['original', 'Original'], ['mono', 'Matching tiles']], p.iconStyle, (v) => api.update(id, { iconStyle: v }))));

  const sw = el('div', 'swatches');
  sw.setAttribute('role', 'radiogroup');
  sw.setAttribute('aria-label', 'Glass tint');
  for (const [key, rgb] of Object.entries(S.tints)) {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.title = TINT_NAMES[key] || key;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', TINT_NAMES[key] || key);
    b.setAttribute('aria-checked', String(p.tint.color === key));
    b.style.background = key === 'clear'
      ? 'linear-gradient(135deg, rgba(255,255,255,.9), rgba(255,255,255,.2))'
      : `rgb(${rgb.join(',')})`;
    b.addEventListener('click', () => api.update(id, { tint: { color: key } }));
    sw.append(b);
  }
  const glassy = p.theme === 'glass' && !p.cover;
  body.append(settingRow(p.theme === 'glass' ? 'Glass tint' : 'Accent colour', sw));
  if (glassy) body.append(settingRow('Tint strength', seg('Tint strength', [['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']], p.tint.strength, (v) => api.update(id, { tint: { strength: v } }))));

  const cov = el('div', 'cover-ctl');
  const pick = el('button', 'btn', p.cover ? 'Change…' : 'Choose Photo…');
  pick.type = 'button';
  pick.addEventListener('click', () => api.cover(id));
  cov.append(pick);
  if (p.cover) {
    const rm = el('button', 'btn', 'Remove');
    rm.type = 'button';
    rm.addEventListener('click', () => api.update(id, { cover: null }));
    cov.append(rm);
  }
  body.append(settingRow('Cover photo', cov));

  const toggle = (label, checked, onChange) => {
    const r = el('label', 'row switch-row');
    const box = el('input', 'switch');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    r.append(el('span', 'row-label', label), box);
    return r;
  };
  if (glassy) body.append(toggle('Blur the wallpaper behind it', p.tint.blur, (v) => api.update(id, { tint: { blur: v } })));
  body.append(toggle('Lock position and size', p.locked, (v) => api.update(id, { locked: v })));

  const acts = el('div', 'row actions');
  const add = el('button', 'btn primary', 'Add Files or Apps…');
  add.type = 'button';
  add.addEventListener('click', () => api.addFiles(id));
  const show = el('button', 'btn', 'Show Me');
  show.type = 'button';
  show.title = 'Lifts this pod above your windows for a moment';
  show.addEventListener('click', () => api.locate(id));
  const del = el('button', 'btn danger', 'Delete Pod…');
  del.type = 'button';
  del.addEventListener('click', () => api.remove(id));
  acts.append(add, show, del);
  body.append(acts);
  return body;
}

function podItem(p) {
  const li = el('li', 'pod');
  li.dataset.id = p.id;
  const open = expanded.has(p.id);
  li.classList.toggle('expanded', open);

  const head = el('button', 'pod-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  const title = el('span', 'pod-title');
  title.append(
    el('span', 'pod-name', p.name),
    el('span', 'pod-meta', `${THEMES.find((t) => t[0] === p.theme)[1]} · ${p.style === 'folder' ? (p.expand ? 'Folder, springs open' : 'Folder') : `Strip, ${p.visible} at a time`}, ${p.count} item${p.count === 1 ? '' : 's'}${p.locked ? ', locked' : ''}`),
  );
  head.append(miniPod(p), title);
  head.insertAdjacentHTML('beforeend', CHEVRON);
  head.addEventListener('click', () => {
    if (expanded.has(p.id)) expanded.delete(p.id);
    else expanded.add(p.id);
    render();
  });
  li.append(head);
  if (open) li.append(podBody(p));
  return li;
}

function renderKeys() {
  const box = $('#hkKeys');
  box.classList.toggle('recording', recording);
  if (recording) {
    box.replaceChildren(el('span', 'waiting', 'Press the new shortcut…'));
    return;
  }
  box.replaceChildren(...S.hotkeyLabel.split(' + ').map((k) => el('kbd', null, k)));
}

function render() {
  if (!S) return;
  // Don't rebuild while someone is typing a name; do it when they leave the field.
  if (document.activeElement?.classList.contains('name-input')) {
    renderQueued = true;
    return;
  }
  renderQueued = false;
  $('#testNote').hidden = !S.testMode;
  document.title = S.testMode ? 'Desktop Pods Hub (test mode)' : 'Desktop Pods Hub';
  renderKeys();
  $('#hkHint').textContent = S.hotkeyActive
    ? 'Press it again, or click anywhere else, to send them back.'
    : 'This shortcut is taken by another app right now. Choose a different one.';
  $('#visible').checked = !S.hidden;
  $('#lockAll').checked = S.pods.length > 0 && S.pods.every((p) => p.locked);
  $('#snap').checked = S.snap;
  $('#lowMemory').checked = S.lowMemory;
  $('#restartRow').hidden = S.lowMemory === S.lowMemoryActive;
  $('#sendTo').checked = S.sendTo;
  $('#sendToRow').hidden = !S.sendToAvailable;
  renderPending();
  renderThemes();

  const list = $('#pods');
  const focusedId = document.activeElement?.closest?.('.pod')?.dataset.id;
  const focusedHead = document.activeElement?.classList.contains('pod-head');
  if (!S.pods.length) {
    const empty = el('li', 'empty-list', 'No pods yet. Create one above.');
    list.replaceChildren(empty);
  } else {
    list.replaceChildren(...S.pods.map(podItem));
  }
  if (focusedId && focusedHead) list.querySelector(`.pod[data-id="${CSS.escape(focusedId)}"] .pod-head`)?.focus();
  for (const id of [...expanded]) if (!S.pods.some((p) => p.id === id)) expanded.delete(id);
}

// "Send to" from Explorer: choose which pod gets the files.
function renderPending() {
  const box = $('#pending');
  box.hidden = !S.pending;
  if (!S.pending) return;
  const { count, names } = S.pending;
  $('#pendingText').textContent = `${count} item${count === 1 ? '' : 's'}: ${names.join(', ')}${count > names.length ? ', …' : ''}. Only links are added; the files stay where they are.`;
  const btn = (label, cls, target) => {
    const b = el('button', `btn ${cls}`, label);
    b.type = 'button';
    b.addEventListener('click', () => api.pending(target));
    return b;
  };
  $('#pendingPods').replaceChildren(
    ...S.pods.map((p) => {
      const b = btn('', 'pick-pod', p.id);
      b.append(miniPod(p), el('span', null, p.name));
      return b;
    }),
    btn('New Pod', 'primary', 'new'),
    btn('Cancel', '', 'cancel'),
  );
  box.scrollIntoView({ block: 'nearest' });
}

function renderThemes() {
  const box = $('#themes');
  const all = (k) => S.pods.length > 0 && S.pods.every((p) => p.theme === k);
  box.replaceChildren(...THEMES.map(([k, name, sub]) => {
    const b = el('button', 'theme-card');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(all(k)));
    b.setAttribute('aria-label', `${name} theme for every pod`);
    const prev = el('span', `mini mini-folder t-${k}`);
    prev.setAttribute('aria-hidden', 'true');
    prev.append(el('i'), el('i'), el('i'));
    const cl = el('b');
    for (let n = 0; n < 4; n++) cl.append(el('i'));
    prev.append(cl);
    b.append(prev, el('span', 'maker-name', name), el('span', 'maker-sub', sub));
    b.addEventListener('click', () => api.themeAll(k));
    return b;
  }));
}

document.addEventListener('focusout', (e) => {
  if (e.target.classList?.contains('name-input')) setTimeout(() => { if (renderQueued) render(); }, 0);
});

// ---- shortcut recording ----
const KEY_NAMES = { Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\' };
function accelFrom(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(e.code)) key = e.code;
  else key = KEY_NAMES[e.code] || null;
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return mods.length ? [...mods, key].join('+') : `+${key}`;
}

function stopRecording() {
  recording = false;
  $('#hkChange').textContent = 'Change Shortcut';
  api.pauseHotkey(false);
  renderKeys();
}

$('#hkChange').addEventListener('click', () => {
  if (recording) return stopRecording();
  recording = true;
  $('#hkError').hidden = true;
  $('#hkChange').textContent = 'Cancel';
  api.pauseHotkey(true);
  renderKeys();
});

document.addEventListener('keydown', async (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') return stopRecording();
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // wait for the real key
  const acc = accelFrom(e);
  const err = $('#hkError');
  if (!acc || acc.startsWith('+')) {
    err.textContent = 'Hold Ctrl, Alt or Win and then press a key.';
    err.hidden = false;
    return;
  }
  const r = await api.setHotkey(acc);
  if (r && r.ok) {
    err.hidden = true;
    stopRecording();
  } else {
    err.textContent = r?.error || 'That shortcut could not be used.';
    err.hidden = false;
  }
}, true);
window.addEventListener('blur', () => { if (recording) stopRecording(); });

// ---- other controls ----
async function create(style) {
  const id = await api.create(style);
  if (!id) return;
  expanded.add(id);
  S = await api.state();
  render();
}
$('#newFolder').addEventListener('click', () => create('folder'));
$('#newStrip').addEventListener('click', () => create('strip'));
$('#front').addEventListener('click', () => api.front());
$('#visible').addEventListener('change', (e) => api.setHidden(!e.target.checked));
$('#openFolder').addEventListener('click', () => api.openFolder());
$('#newPhoto').addEventListener('click', () => api.photo());
$('#lockAll').addEventListener('change', (e) => api.lockAll(e.target.checked));
$('#snap').addEventListener('change', (e) => api.setSnap(e.target.checked));
$('#lowMemory').addEventListener('change', (e) => api.setLowMemory(e.target.checked));
$('#restart').addEventListener('click', () => api.restart());
$('#sendTo').addEventListener('change', async (e) => {
  const ok = await api.setSendTo(e.target.checked);
  if (!ok) e.target.checked = !e.target.checked;
});

api.onState((s) => { S = s; render(); });
api.state().then((s) => { S = s; render(); document.documentElement.dataset.ready = '1'; });
