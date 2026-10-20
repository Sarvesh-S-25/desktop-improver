'use strict';
// Pure geometry helpers. "Glass rect" = the visible pod; the window is that rect
// plus PAD on every side so the soft shadow has room to render.

const PAD = 18;
const EDGE = 8; // keep pods this far from the work-area edge

const MIN = {
  folder: { w: 136, h: 136 },
  strip: { w: 200, h: 104 },
  open: { w: 280, h: 230 },
};
const MAX = { w: 2400, h: 1600 };

function windowBounds(rect) {
  return {
    x: Math.round(rect.x - PAD),
    y: Math.round(rect.y - PAD),
    width: Math.round(rect.w + PAD * 2),
    height: Math.round(rect.h + PAD * 2),
  };
}

function clampSize(w, h, min) {
  return {
    w: Math.round(Math.min(Math.max(w, min.w), MAX.w)),
    h: Math.round(Math.min(Math.max(h, min.h), MAX.h)),
  };
}

// Fit rect inside area (shrinking it if it is larger than the area).
function clampRectToArea(rect, area, margin = EDGE) {
  const w = Math.max(1, Math.min(rect.w, area.width - margin * 2));
  const h = Math.max(1, Math.min(rect.h, area.height - margin * 2));
  const x = Math.min(Math.max(rect.x, area.x + margin), area.x + area.width - margin - w);
  const y = Math.min(Math.max(rect.y, area.y + margin), area.y + area.height - margin - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// Open panel grows from the pod's top-left corner when there is room,
// otherwise it slides so it stays fully on screen.
function computeOpenRect(closed, openSize, workArea) {
  return clampRectToArea({ x: closed.x, y: closed.y, w: openSize.w, h: openSize.h }, workArea);
}

function overlap(a, area) {
  const w = Math.min(a.x + a.w, area.x + area.width) - Math.max(a.x, area.x);
  const h = Math.min(a.y + a.h, area.y + area.height) - Math.max(a.y, area.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Pick the work area a rect mostly sits in; fall back to the primary one.
function pickArea(rect, areas, primaryIndex = 0) {
  let best = -1;
  let bestOverlap = 0;
  areas.forEach((a, i) => {
    const o = overlap(rect, a);
    if (o > bestOverlap) { bestOverlap = o; best = i; }
  });
  return areas[best >= 0 ? best : primaryIndex];
}

// Make sure a pod is reachable after monitors change.
function ensureVisible(rect, areas, primaryIndex = 0) {
  return clampRectToArea(rect, pickArea(rect, areas, primaryIndex));
}

// While dragging, line a pod up with its neighbours (same edge, or GAP apart) and with the
// work-area margin when it comes within SNAP px. Each axis snaps to its nearest candidate.
const SNAP = 10;
const GAP = 12;
function snapRect(rect, others, area) {
  const xs = [area.x + EDGE, area.x + area.width - EDGE - rect.w];
  const ys = [area.y + EDGE, area.y + area.height - EDGE - rect.h];
  for (const o of others) {
    xs.push(o.x, o.x + o.w - rect.w, o.x + o.w + GAP, o.x - GAP - rect.w);
    ys.push(o.y, o.y + o.h - rect.h, o.y + o.h + GAP, o.y - GAP - rect.h);
  }
  const best = (v, cands) => {
    let out = v;
    let d = SNAP + 1;
    for (const c of cands) if (Math.abs(c - v) < d) { d = Math.abs(c - v); out = c; }
    return out;
  };
  return { ...rect, x: best(rect.x, xs), y: best(rect.y, ys) };
}

module.exports = { PAD, EDGE, MIN, MAX, SNAP, GAP, snapRect, windowBounds, clampSize, clampRectToArea, computeOpenRect, pickArea, ensureVisible };
