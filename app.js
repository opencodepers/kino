'use strict';

// Kino — screen recording with automatic eased zooms.
// Record → mark a spot on the frame → the compositor blends a smooth zoom
// in/hold/out around it and re-renders the padded, rounded video into a canvas.

const $ = (sel) => document.querySelector(sel);
const canvas = $('#stage');
const ctx = canvas.getContext('2d');
const video = $('#source');

let W = canvas.width;
let H = canvas.height;
const BASE_W = 1920;
let K = W / BASE_W; // canvas-px scale: keeps padding, radius, cursor and type
                    // the same relative size at Half / Quarter resolution.

// Zoom shape: ease up, hold, ease back out. Seconds.
const RAMP = 0.55;
const HOLD = 1.1;

// Viewer resolution (Full / Half / Quarter) rescales the backing store, so
// export size follows it exactly like a render-quality control does.
function setRes(scale) {
  const w = Math.round(BASE_W * scale);
  const h = Math.round((BASE_W * 9) / 16 * scale);
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w;
  canvas.height = h;
  W = w;
  H = h;
  K = W / BASE_W;
  bgCache = null;
  lastDrawEmpty = null;
}

const state = {
  marks: [],
  bg: 'midnight',
  padding: 96,
  radius: 30,
  solid: '#0d0e10',
  zoom: 1.85,
  look: 'none',
  vignette: 0,
  pattern: 'none',
  texts: [],
  annos: [],
  sel: null,
  vis: { zoom: true, cursor: true, text: true, anno: true, look: true },
  winIn: 0,
  winOut: 0,
  range: 'all',
  loop: false,
  viewZoom: 'fit',
  res: 1,
  fps: 60,
  quality: 12,
  placeKind: 'zoom',
  takes: [],
  activeTake: null,
  takeSeq: 0,
  undo: [],
  redo: [],
  mic: false,
  place: false,
  recording: false,
  exporting: false,
  duration: 0,
  url: '',
  recorder: null,
  audioCtx: null,
  audioNode: null,
  scrubbing: false,
  tracing: false,
  cursor: {
    on: false,
    style: 'arrow',
    size: 1.3,
    smoothing: 0.6,
    lag: 0.08,
    path: [],
    raw: [],
  },
};

// ── Backgrounds ────────────────────────────────────────────────
const BGS = {
  midnight(g, w, h) {
    const lg = g.createLinearGradient(0, 0, 0, h);
    lg.addColorStop(0, '#0b0e13');
    lg.addColorStop(1, '#181e28');
    g.fillStyle = lg;
    g.fillRect(0, 0, w, h);
  },
  aurora(g, w, h) {
    g.fillStyle = '#050a10';
    g.fillRect(0, 0, w, h);
    const blob = (x, y, r, color) => {
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, color);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, w, h);
    };
    blob(w * 0.2, h * 0.12, w * 0.62, 'rgba(56, 189, 248, 0.30)');
    blob(w * 0.86, h * 0.95, w * 0.7, 'rgba(129, 91, 255, 0.34)');
    blob(w * 0.55, h * 0.45, w * 0.5, 'rgba(200, 244, 90, 0.07)');
  },
  ember(g, w, h) {
    g.fillStyle = '#130b09';
    g.fillRect(0, 0, w, h);
    const rg = g.createRadialGradient(w * 0.75, h * 0.9, 0, w * 0.75, h * 0.9, w * 0.8);
    rg.addColorStop(0, 'rgba(255, 122, 61, 0.36)');
    rg.addColorStop(0.55, 'rgba(160, 40, 20, 0.14)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
  },
  graphite(g, w, h) {
    const lg = g.createLinearGradient(0, 0, w, h);
    lg.addColorStop(0, '#14161a');
    lg.addColorStop(1, '#1d2026');
    g.fillStyle = lg;
    g.fillRect(0, 0, w, h);
  },
  grid(g, w, h) {
    g.fillStyle = '#0a0d10';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.055)';
    for (let y = 0; y < h; y += 40) {
      for (let x = 0; x < w; x += 40) g.fillRect(x, y, 2, 2);
    }
  },
  paper(g, w, h) {
    const lg = g.createLinearGradient(0, 0, 0, h);
    lg.addColorStop(0, '#f6f3ec');
    lg.addColorStop(1, '#e4dfd4');
    g.fillStyle = lg;
    g.fillRect(0, 0, w, h);
    const rg = g.createRadialGradient(w * 0.5, h * 0.1, 0, w * 0.5, h * 0.1, w * 0.7);
    rg.addColorStop(0, 'rgba(255,255,255,0.7)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
  },
  // Flat palette backdrop: one solid block, no gradient — the brand rule.
  solid(g, w, h) {
    g.fillStyle = state.solid;
    g.fillRect(0, 0, w, h);
  },
};

const BG_LABEL = {
  midnight: 'Midnight', aurora: 'Aurora', ember: 'Ember',
  graphite: 'Graphite', grid: 'Grid', paper: 'Paper',
};

let bgCache = null;
function background() {
  if (bgCache) return bgCache;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  BGS[state.bg](g, W, H);
  drawPattern(g, W, H);
  bgCache = c;
  return c;
}

// Backdrop treatment drawn over whatever base block or scene is active.
function drawPattern(g, w, h) {
  const p = state.pattern;
  if (!p || p === 'none') return;
  if (p === 'dots') {
    g.fillStyle = 'rgba(255,255,255,0.07)';
    for (let y = 26; y < h; y += 36) for (let x = 26; x < w; x += 36) g.fillRect(x, y, 3, 3);
  } else if (p === 'grid') {
    g.strokeStyle = 'rgba(255,255,255,0.055)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x < w; x += 64) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); }
    for (let y = 0; y < h; y += 64) { g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); }
    g.stroke();
  } else if (p === 'scan') {
    g.fillStyle = 'rgba(0,0,0,0.2)';
    for (let y = 0; y < h; y += 6) g.fillRect(0, y, w, 3);
  } else if (p === 'glow') {
    const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.62);
    rg.addColorStop(0, 'rgba(184,242,58,0.16)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
  }
}

// The plate edge has to flip to ink on light blocks instead of always
// assuming a dark scene, or a Cream/Lime backdrop loses its hairline.
function bgIsLight() {
  if (state.bg === 'paper') return true;
  if (state.bg !== 'solid') return false;
  const hex = state.solid.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
}

// ── Geometry ───────────────────────────────────────────────────
function roundRect(g, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.lineTo(x + w, y + h - rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.lineTo(x + rr, y + h);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.lineTo(x, y + rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}

// Where the video sits inside the padded frame, aspect preserved.
function plate() {
  const pad = state.padding * K;
  const boxW = Math.max(16, W - pad * 2);
  const boxH = Math.max(16, H - pad * 2);
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const fit = Math.min(boxW / vw, boxH / vh);
  const w = vw * fit;
  const h = vh * fit;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

const smooth = (p) => p * p * (3 - 2 * p);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// How strongly a mark pulls at time t: 0 outside, 1 on the plateau.
function weightAt(t, m) {
  const half = HOLD / 2;
  const a = m.t - half - RAMP;
  const b = m.t + half + RAMP;
  if (t <= a || t >= b) return 0;
  if (t < a + RAMP) return smooth((t - a) / RAMP);
  if (t > b - RAMP) return smooth((b - t) / RAMP);
  return 1;
}

// Blend from the resting frame toward the strongest mark at this instant.
function focusAt(t) {
  let best = null;
  let bestW = 0;
  if (!state.vis.zoom) return { s: 1, x: 0.5, y: 0.5, mark: null };
  for (const m of state.marks) {
    const w = weightAt(t, m);
    if (w > bestW) { bestW = w; best = m; }
  }
  if (!best) return { s: 1, x: 0.5, y: 0.5, mark: null };
  return {
    s: 1 + (best.scale - 1) * bestW,
    x: 0.5 + (best.x - 0.5) * bestW,
    y: 0.5 + (best.y - 0.5) * bestW,
    mark: best,
  };
}

// ── Renderer ───────────────────────────────────────────────────
// Looks are one canvas filter pass over the video. Keeping them a filter
// (rather than a per-pixel readback) keeps the preview on a single frame budget.
const LOOKS = {
  none: { label: 'Normal', filter: 'none' },
  mono: { label: 'Mono', filter: 'grayscale(1) contrast(1.05)' },
  sepia: { label: 'Sepia', filter: 'sepia(0.72) saturate(1.12) contrast(1.03)' },
  vivid: { label: 'Vivid', filter: 'saturate(1.75) contrast(1.12)' },
  soft: { label: 'Soft', filter: 'saturate(0.9) brightness(1.07) contrast(0.9) blur(0.5px)' },
  punch: { label: 'Punch', filter: 'contrast(1.35) saturate(1.28)' },
};

const CAN_FILTER = (() => {
  try { ctx.filter = 'none'; return ctx.filter === 'none'; } catch (e) { return false; }
})();

let lastDrawEmpty = null;
function drawFrame(t) {
  const hasVideo = video.readyState >= 2 && video.videoWidth > 0;
  if (!hasVideo) {
    if (lastDrawEmpty) return; // static placeholder, draw once
    lastDrawEmpty = true;
  } else {
    lastDrawEmpty = null;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(background(), 0, 0, W, H);

  const r = plate();
  const rad = state.radius * K;
  const f = hasVideo ? focusAt(t) : { s: 1, x: 0.5, y: 0.5 };

  if (!hasVideo) {
    ctx.save();
    ctx.setLineDash([18, 14]);
    roundRect(ctx, r.x, r.y, r.w, r.h, rad);
    ctx.fillStyle = 'rgba(255,255,255,0.028)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.font = '600 34px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No recording yet', W / 2, H / 2 - 14);
    ctx.font = '400 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillText('Hit “Record screen” to capture a window, tab or display', W / 2, H / 2 + 30);
    ctx.restore();
    return;
  }

  // Drop shadow underneath the plate.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 80 * K;
  ctx.shadowOffsetY = 30 * K;
  roundRect(ctx, r.x, r.y, r.w, r.h, rad);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();

  // Video, clipped to the plate and pushed around by the current zoom.
  ctx.save();
  roundRect(ctx, r.x, r.y, r.w, r.h, rad);
  ctx.clip();
  ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
  ctx.scale(f.s, f.s);
  ctx.translate(-(f.x - 0.5) * r.w, -(f.y - 0.5) * r.h);
  if (CAN_FILTER) ctx.filter = state.vis.look ? (LOOKS[state.look] || LOOKS.none).filter : 'none';
  ctx.drawImage(video, -r.w / 2, -r.h / 2, r.w, r.h);
  if (CAN_FILTER) ctx.filter = 'none';
  drawCursor(t, r, f.s);
  ctx.restore();

  // Overlays ride on the plate itself, unzoomed, still clipped to it.
  ctx.save();
  roundRect(ctx, r.x, r.y, r.w, r.h, rad);
  ctx.clip();
  drawVignette(r);
  drawAnnos(t, r);
  drawTexts(t, r);
  drawSelection(r);
  ctx.restore();

  // Hairline edge so the plate reads on light backgrounds too.
  ctx.save();
  roundRect(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, Math.max(0, rad - 1));
  ctx.strokeStyle = bgIsLight() ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function hexAlpha(hex, a) {
  const h = String(hex || '#b8f23a').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${a})`;
}

const live = (item, t) => item.t <= t && item.t + (item.dur || 0) >= t;

function drawVignette(r) {
  const v = state.vignette / 100;
  if (v <= 0) return;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rad = Math.hypot(r.w, r.h) / 2;
  const rg = ctx.createRadialGradient(cx, cy, rad * 0.4, cx, cy, rad);
  rg.addColorStop(0, 'rgba(0,0,0,0)');
  rg.addColorStop(1, `rgba(0,0,0,${(0.88 * v).toFixed(3)})`);
  ctx.fillStyle = rg;
  ctx.fillRect(r.x, r.y, r.w, r.h);
}

function drawTexts(t, r) {
  if (!state.vis.text) return;
  for (const s of state.texts) {
    if (!live(s, t)) continue;
    const px = Math.max(8, s.size * (r.w / 1080));
    const lines = String(s.text || '').split('\n');
    const lh = px * 1.2;
    const cx = r.x + s.x * r.w;
    const cy = r.y + s.y * r.h;
    ctx.save();
    ctx.font = `500 ${px}px "Geist", ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = px * 0.24;
    ctx.fillStyle = s.color || '#f7f5ec';
    lines.forEach((line, i) => {
      ctx.fillText(line, cx, cy + (i - (lines.length - 1) / 2) * lh);
    });
    ctx.restore();
  }
}

function drawAnnos(t, r) {
  if (!state.vis.anno) return;
  const k = r.w / 1080;
  for (const a of state.annos) {
    if (!live(a, t)) continue;
    const x = r.x + a.x * r.w;
    const y = r.y + a.y * r.h;
    const w = a.w * r.w;
    const h = a.h * r.h;
    ctx.save();
    ctx.lineWidth = Math.max(2, a.weight * k);
    ctx.strokeStyle = a.color;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (a.shape === 'box') {
      roundRect(ctx, x, y, w, h, 8 * k);
      ctx.fillStyle = hexAlpha(a.color, 0.16);
      ctx.fill();
      ctx.stroke();
    } else if (a.shape === 'circle') {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(a.color, 0.16);
      ctx.fill();
      ctx.stroke();
    } else {
      const x2 = x + w;
      const y2 = y + h;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const ang = Math.atan2(y2 - y, x2 - x);
      const head = Math.max(14, 26 * k);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - 0.4), y2 - head * Math.sin(ang - 0.4));
      ctx.lineTo(x2 - head * Math.cos(ang + 0.4), y2 - head * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fillStyle = a.color;
      ctx.fill();
    }
    ctx.restore();
  }
}

// Selection marquee — only while parked, never during playback or export.
function drawSelection(r) {
  const sel = state.sel;
  if (!sel || state.exporting || !video.paused) return;
  ctx.save();
  ctx.strokeStyle = '#b8f23a';
  ctx.lineWidth = Math.max(1, 2 * K);
  ctx.setLineDash([9 * K, 6 * K]);

  if (sel.kind === 'text') {
    const s = state.texts.find((x) => x.id === sel.id);
    if (s && live(s, video.currentTime)) {
      const px = Math.max(8, s.size * (r.w / 1080));
      ctx.font = `500 ${px}px "Geist", ui-sans-serif, system-ui, sans-serif`;
      const lines = String(s.text || '').split('\n');
      let wmax = 0;
      lines.forEach((l) => { wmax = Math.max(wmax, ctx.measureText(l || ' ').width); });
      const bw = wmax + 36 * K;
      const bh = px * 1.2 * lines.length + 24 * K;
      const cx = r.x + s.x * r.w;
      const cy = r.y + s.y * r.h;
      ctx.strokeRect(cx - bw / 2, cy - bh / 2, bw, bh);
    }
  } else if (sel.kind === 'anno') {
    const a = state.annos.find((x) => x.id === sel.id);
    if (a && live(a, video.currentTime)) {
      ctx.strokeRect(r.x + a.x * r.w, r.y + a.y * r.h, a.w * r.w, a.h * r.h);
    }
  } else if (sel.kind === 'zoom') {
    const m = state.marks.find((x) => x.id === sel.id);
    if (m && state.vis.zoom) {
      const cx = r.x + m.x * r.w;
      const cy = r.y + m.y * r.h;
      ctx.strokeRect(cx - 40 * K, cy - 40 * K, 80 * K, 80 * K);
      ctx.beginPath();
      ctx.moveTo(cx - 54 * K, cy); ctx.lineTo(cx + 54 * K, cy);
      ctx.moveTo(cx, cy - 54 * K); ctx.lineTo(cx, cy + 54 * K);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ── Custom cursor ──────────────────────────────────────────────
// The recording already contains the OS pointer as pixels. Once "detect" has
// recovered its path we redraw it on top: de-jittered, sitting a beat behind
// the smoothed path (that lag is the fluid feel), redrawn at a fixed apparent
// size so zooms don't balloon it.
const ARROW = [
  [0, 0], [0, 1], [0.24, 0.77], [0.42, 1.1], [0.55, 1.04], [0.37, 0.71], [0.68, 0.68],
];

function paintCursor(g, x, y, u, style, alpha) {
  g.save();
  g.translate(x, y);
  g.globalAlpha = alpha;
  g.lineJoin = 'round';

  if (style === 'arrow') {
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = u * 0.3;
    g.shadowOffsetY = u * 0.08;
    g.beginPath();
    ARROW.forEach(([px, py], i) => (i ? g.lineTo(px * u, py * u) : g.moveTo(px * u, py * u)));
    g.closePath();
    g.fillStyle = '#fff';
    g.fill();
    g.shadowColor = 'transparent';
    g.lineWidth = Math.max(1, u * 0.055);
    g.strokeStyle = 'rgba(18,20,24,0.92)';
    g.stroke();
  } else if (style === 'dot') {
    g.shadowColor = 'rgba(0,0,0,0.4)';
    g.shadowBlur = u * 0.4;
    g.beginPath();
    g.arc(0, 0, u * 0.2, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.97)';
    g.fill();
    g.shadowColor = 'transparent';
    g.lineWidth = Math.max(1, u * 0.05);
    g.strokeStyle = 'rgba(18,20,24,0.55)';
    g.stroke();
  } else {
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, u * 0.95);
    rg.addColorStop(0, 'rgba(255,255,255,0.5)');
    rg.addColorStop(0.35, 'rgba(200,244,90,0.22)');
    rg.addColorStop(1, 'rgba(200,244,90,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.arc(0, 0, u * 0.95, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(0, 0, u * 0.09, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.fill();
  }
  g.restore();
}

function drawCursor(t, r, zoomScale) {
  const C = state.cursor;
  if (!C.on || !C.path.length || !state.vis.cursor) return;
  const at = (when) => KinoCursor.sampleAt(C.path, when, 0.4);
  const head = at(t - C.lag);
  if (!head) return;

  const u = (42 * C.size * K) / zoomScale;

  // Creamy trail behind the dot styles — the "fluid" bit.
  if (C.style !== 'arrow') {
    for (let i = 5; i >= 1; i--) {
      const ghost = at(t - C.lag - i * 0.035);
      if (!ghost) continue;
      paintCursor(ctx, (ghost.x - 0.5) * r.w, (ghost.y - 0.5) * r.h, u * (1 - i * 0.06), C.style, 0.1 * (1 - i / 6));
    }
  }
  paintCursor(ctx, (head.x - 0.5) * r.w, (head.y - 0.5) * r.h, u, C.style, 1);
}

function seekTo(t) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.currentTime = clamp(t, 0, Math.max(0, state.duration - 0.001));
    setTimeout(done, 400);
  });
}

async function traceCursor() {
  if (!state.url || state.tracing || state.exporting) return;
  state.tracing = true;
  $('#traceBtn').disabled = true;
  $('#cursorOn').disabled = true;
  video.pause();

  const AW = 480;
  const AH = 270;
  const work = document.createElement('canvas');
  work.width = AW;
  work.height = AH;
  const wg = work.getContext('2d', { willReadFrequently: true });

  const samples = [];
  let prev = null;
  let last = null;
  const step = 1 / 20;
  let n = 0;

  for (let t = 0; t < state.duration; t += step) {
    await seekTo(t);
    wg.drawImage(video, 0, 0, AW, AH);
    const frame = wg.getImageData(0, 0, AW, AH).data;
    if (prev) {
      const hit = KinoCursor.trackFrame(frame, prev, AW, AH, last);
      if (hit) {
        samples.push({ t, x: hit.x, y: hit.y, conf: hit.conf });
        if (hit.conf > 0.3) last = hit;
      }
    }
    prev = frame;
    if (++n % 15 === 0) {
      setStatus(`Finding the mouse… ${Math.round((t / state.duration) * 100)}%`, true);
    }
  }

  state.cursor.raw = samples;
  state.cursor.path = KinoCursor.smoothPath(samples, { smoothing: state.cursor.smoothing, gap: 0.4 });
  state.cursor.on = state.cursor.path.length > 3;
  state.tracing = false;
  $('#traceBtn').disabled = false;
  $('#cursorOn').disabled = false;
  syncCursorToggle();
  video.currentTime = 0;

  if (!state.cursor.on) {
    setStatus('Could not find a pointer in this recording — try a clip that moves the mouse');
    return;
  }
  const span = state.cursor.path[state.cursor.path.length - 1].t - state.cursor.path[0].t;
  setStatus(`Cursor tracked across ${fmt(span)} — scrub to check it, then export`);
}

// ── Loop ───────────────────────────────────────────────────────
function loop() {
  drawFrame(video.currentTime || 0);
  if (!state.scrubbing) syncClock(video.currentTime || 0);
  requestAnimationFrame(loop);
}

// ── Timeline ───────────────────────────────────────────────────
const track = $('#track');
const head = $('#head');
const ticks = $('#ticks');

function fmt(t) {
  const d = Math.max(0, t || 0);
  const m = Math.floor(d / 60);
  const s = d % 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function syncClock(t) {
  const dur = state.duration || 0;
  $('#dur').textContent = fmt(dur);
  $('#tc').textContent = fmt(t);
  $('#vTime').textContent = fmt(t);
  head.style.left = dur ? `${clamp((t / dur) * 100, 0, 100)}%` : '0%';
}

const LAYER_DEFS = [
  { id: 'zoom', name: 'Zoom marks', color: '#b8f23a' },
  { id: 'cursor', name: 'Cursor', color: '#9fd0ff' },
  { id: 'text', name: 'Text', color: '#f7f5ec' },
  { id: 'anno', name: 'Annotations', color: '#3f7cff' },
  { id: 'look', name: 'Look', color: '#d9381e' },
];

function findItem(kind, id) {
  if (kind === 'zoom') return state.marks.find((m) => m.id === id) || null;
  if (kind === 'text') return state.texts.find((m) => m.id === id) || null;
  if (kind === 'anno') return state.annos.find((m) => m.id === id) || null;
  return null;
}

function selectLayer(kind, id) {
  state.sel = { kind, id: id || null };
  renderMarks();
  renderProps();
}

// Each layer's bars, in seconds, off whatever items it owns.
function layerItems(id) {
  const dur = state.duration || 0;
  if (id === 'zoom') {
    const half = HOLD / 2 + RAMP;
    return state.marks.map((m) => ({
      id: m.id,
      start: Math.max(0, m.t - half),
      end: Math.min(dur, m.t + half),
      label: `${m.scale.toFixed(2)}×`,
    }));
  }
  if (id === 'cursor') {
    const p = state.cursor.path;
    return p.length ? [{ id: 'cursor', start: p[0].t, end: p[p.length - 1].t, label: 'detected' }] : [];
  }
  if (id === 'text') {
    return state.texts.map((s) => ({
      id: s.id, start: s.t, end: s.t + s.dur,
      label: (String(s.text).split('\n')[0] || 'Text').slice(0, 20),
    }));
  }
  if (id === 'anno') {
    return state.annos.map((a) => ({ id: a.id, start: a.t, end: a.t + a.dur, label: a.shape }));
  }
  if (id === 'look') {
    if (state.look === 'none') return [];
    return [{ id: 'look', start: 0, end: dur, label: (LOOKS[state.look] || LOOKS.none).label }];
  }
  return [];
}

const pctOf = (t) => (state.duration ? clamp((t / state.duration) * 100, 0, 100) : 0);

function renderRuler() {
  const ruler = $('#ruler');
  const dur = state.duration;
  ruler.innerHTML = '';
  if (!dur) return;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  const step = steps.find((s) => dur / s <= 10) || 300;
  for (let t = 0; t <= dur + 0.001; t += step) {
    const line = document.createElement('i');
    line.style.left = `${pctOf(t)}%`;
    ruler.appendChild(line);
    const lab = document.createElement('span');
    lab.style.left = `${pctOf(t)}%`;
    lab.textContent = fmt(t);
    ruler.appendChild(lab);
  }
}

function renderTimeline() {
  const heads = $('#tlHeads');
  const lanes = $('#tlRows');
  heads.innerHTML = '';
  lanes.innerHTML = '';

  LAYER_DEFS.forEach((def, i) => {
    const items = layerItems(def.id);
    const on = state.vis[def.id];
    const selKind = !!(state.sel && state.sel.kind === def.id);

    const row = document.createElement('div');
    row.className = 'hrow' + (selKind ? ' sel' : '');
    row.dataset.layer = def.id;
    row.innerHTML =
      `<span class="ix">${i + 1}</span>` +
      `<span class="tag" style="background:${def.color}"></span>` +
      `<span class="nm">${def.name}</span>` +
      `<span class="kind">${items.length}</span>`;

    const eye = document.createElement('button');
    eye.className = 'eye' + (on ? '' : ' off');
    eye.textContent = on ? '◉' : '○';
    eye.title = on ? 'Hide layer' : 'Show layer';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      mutate(() => { state.vis[def.id] = !state.vis[def.id]; });
      setStatus(`${def.name} ${state.vis[def.id] ? 'visible' : 'hidden'}`);
    });
    row.appendChild(eye);

    const kill = document.createElement('button');
    kill.className = 'kill';
    kill.textContent = '×';
    kill.title = `Clear ${def.name}`;
    kill.addEventListener('click', (e) => {
      e.stopPropagation();
      clearLayer(def.id);
    });
    row.appendChild(kill);

    row.addEventListener('click', () => selectLayer(def.id, null));
    heads.appendChild(row);

    const lane = document.createElement('div');
    lane.className = 'lane' + (selKind ? ' sel' : '');
    lane.dataset.layer = def.id;
    items.forEach((it) => {
      const bar = document.createElement('div');
      bar.className = 'bar' + (on ? '' : ' hidden')
        + (state.sel && state.sel.id === it.id ? ' sel' : '');
      bar.dataset.kind = def.id;
      bar.dataset.id = it.id;
      bar.style.left = `${pctOf(it.start)}%`;
      bar.style.width = `${Math.max(0.6, pctOf(it.end) - pctOf(it.start))}%`;
      bar.style.background = def.color;
      bar.textContent = it.label;
      bar.title = `${it.label} — ${fmt(it.start)} → ${fmt(it.end)}`;
      lane.appendChild(bar);
    });
    lanes.appendChild(lane);
  });
}

function clearLayer(id) {
  const label = (LAYER_DEFS.find((d) => d.id === id) || {}).name || id;
  mutate(() => {
    if (id === 'zoom') state.marks = [];
    else if (id === 'text') state.texts = [];
    else if (id === 'anno') state.annos = [];
    else if (id === 'cursor') state.cursor.on = false;
    else if (id === 'look') state.look = 'none';
    state.sel = null;
  });
  setStatus(`${label} cleared — ctrl+z undoes it`);
}

// Drag a bar to retime its item.
function startBarDrag(e, bar) {
  const kind = bar.dataset.kind;
  const id = bar.dataset.id;
  const item = findItem(kind, id);
  const isSpan = kind === 'text' || kind === 'anno';
  if (!item && kind !== 'cursor' && kind !== 'look') return;
  e.stopPropagation();
  selectLayer(kind, id === kind ? null : id);
  if (!item) return; // cursor / look bars are read-only spans

  const rect = track.getBoundingClientRect();
  const x0 = e.clientX;
  const t0 = item.t;
  let moved = false;
  const base = snap();
  track.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (Math.abs(dx) < 3 && !moved) return;
    moved = true;
    const dt = (dx / rect.width) * (state.duration || 0);
    const span = isSpan ? item.dur : 0;
    item.t = clamp(t0 + dt, 0, Math.max(0, state.duration - span));
    renderMarks();
  };
  const up = () => {
    track.removeEventListener('pointermove', move);
    track.removeEventListener('pointerup', up);
    track.removeEventListener('pointercancel', up);
    if (moved) { pushUndo(base); setStatus(`${kind} moved to ${fmt(item.t)}`); }
  };
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', up);
  track.addEventListener('pointercancel', up);
}

function renderMarks() {
  const dur = state.duration || 1;
  ticks.innerHTML = '';
  for (const m of state.marks) {
    const el = document.createElement('div');
    el.className = 'tick';
    el.style.left = `${clamp((m.t / dur) * 100, 0, 100)}%`;
    ticks.appendChild(el);
  }

  renderTimeline();
  renderRuler();
  renderWin();
  const mc = $('#markCount');
  if (mc) mc.textContent = String(state.marks.length);

  const list = $('#marks');
  list.innerHTML = '';
  if (!state.marks.length) {
    list.innerHTML = '<li class="empty">No zooms yet. Press <kbd>Z</kbd>, then click the frame.</li>';
    return;
  }
  for (const m of state.marks) {
    const li = document.createElement('li');
    if (state.sel && state.sel.kind === 'zoom' && state.sel.id === m.id) li.className = 'sel';
    li.innerHTML = `<span class="t">${fmt(m.t)}</span><span class="z">${m.scale.toFixed(2)}×</span>`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      mutate(() => {
        state.marks = state.marks.filter((x) => x.id !== m.id);
        if (state.sel && state.sel.id === m.id) state.sel = null;
      });
    });
    li.appendChild(del);
    li.addEventListener('click', () => { selectLayer('zoom', m.id); seek(m.t); });
    list.appendChild(li);
  }
}

function seek(t) {
  if (!state.duration) return;
  video.currentTime = clamp(t, 0, state.duration);
  syncClock(video.currentTime);
}

function seekFromEvent(e) {
  const rect = track.getBoundingClientRect();
  const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  seek(ratio * state.duration);
}

track.addEventListener('pointerdown', (e) => {
  const bar = e.target.closest('.bar');
  if (bar) { startBarDrag(e, bar); return; }
  if (e.target.closest('.handle')) return; // work-area handles drag themselves
  if (!state.duration) return;
  video.pause();
  state.scrubbing = true;
  track.setPointerCapture(e.pointerId);
  seekFromEvent(e);
});
track.addEventListener('pointermove', (e) => {
  if (state.scrubbing) seekFromEvent(e);
});
track.addEventListener('pointerup', (e) => {
  state.scrubbing = false;
  try { track.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
});

// ── Playback ───────────────────────────────────────────────────
const playBtn = $('#playBtn');

function togglePlay() {
  if (!state.url || state.exporting) return;
  if (video.paused) {
    if (video.currentTime >= state.duration - 0.05) video.currentTime = 0;
    video.play().catch(() => {});
  } else {
    video.pause();
  }
}
playBtn.addEventListener('click', togglePlay);
video.addEventListener('play', () => { playBtn.textContent = '❚❚'; });
video.addEventListener('pause', () => { playBtn.textContent = '▶'; });

// ── Create & place ─────────────────────────────────────────────
const addBtn = $('#addZoom');
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const PLACE_HINT = {
  zoom: 'Click the frame to set the zoom focus',
  text: 'Click the frame to place the text',
  box: 'Click the frame to place the box',
  circle: 'Click the frame to place the circle',
  arrow: 'Click the frame to set the arrow tip',
};

function beginPlace(kind) {
  if (!state.url) {
    setStatus('Record something first — then items can be placed on it');
    return;
  }
  video.pause();
  state.place = true;
  state.placeKind = kind || 'zoom';
  canvas.classList.add('placing');
  setStatus(PLACE_HINT[state.placeKind] || 'Click the frame');
}

$('#addZoom').addEventListener('click', () => beginPlace('zoom'));
$('#addTextBtn').addEventListener('click', () => beginPlace('text'));
$('#addBoxBtn').addEventListener('click', () => beginPlace('box'));
$('#addCircleBtn').addEventListener('click', () => beginPlace('circle'));
$('#addArrowBtn').addEventListener('click', () => beginPlace('arrow'));

canvas.addEventListener('click', (e) => {
  if (!state.place) return;
  const box = canvas.getBoundingClientRect();
  const px = ((e.clientX - box.left) / box.width) * W;
  const py = ((e.clientY - box.top) / box.height) * H;
  const r = plate();
  // Invert the transform the renderer just used, so the click lands where
  // it looks like it lands even mid-zoom.
  const f = focusAt(video.currentTime);
  const vx = clamp(0.5 + (px - (r.x + r.w / 2)) / (r.w * f.s) + (f.x - 0.5), 0.03, 0.97);
  const vy = clamp(0.5 + (py - (r.y + r.h / 2)) / (r.h * f.s) + (f.y - 0.5), 0.03, 0.97);

  const kind = state.placeKind;
  const id = uid();
  mutate(() => {
    if (kind === 'zoom') {
      state.marks.push({ id, t: video.currentTime, x: vx, y: vy, scale: state.zoom });
      state.marks.sort((a, b) => a.t - b.t);
    } else if (kind === 'text') {
      state.texts.push({
        id, t: video.currentTime, dur: 3, text: 'New title',
        x: vx, y: vy, size: 72, color: '#f7f5ec',
      });
    } else {
      state.annos.push({
        id, t: video.currentTime, dur: 3, shape: kind,
        x: clamp(vx - 0.12, 0, 0.76), y: clamp(vy - 0.1, 0, 0.76),
        w: 0.24, h: 0.2, color: '#b8f23a', weight: 6,
      });
    }
    state.sel = { kind, id };
  });

  state.place = false;
  canvas.classList.remove('placing');
  setStatus(`${kind} added — edit it in Properties, drag its bar to retime`);
});

function deleteSelected() {
  const sel = state.sel;
  if (!sel) { deleteNearest(); return; }
  // Item selected → drop just it. Layer selected (no id) → clear the layer.
  if (sel.id && (sel.kind === 'zoom' || sel.kind === 'text' || sel.kind === 'anno')) {
    mutate(() => {
      if (sel.kind === 'zoom') state.marks = state.marks.filter((m) => m.id !== sel.id);
      if (sel.kind === 'text') state.texts = state.texts.filter((m) => m.id !== sel.id);
      if (sel.kind === 'anno') state.annos = state.annos.filter((m) => m.id !== sel.id);
      state.sel = null;
    });
    setStatus('Deleted — ctrl+z undoes it');
    return;
  }
  clearLayer(sel.kind);
}

function deleteNearest() {
  if (!state.marks.length) return;
  let best = state.marks[0];
  for (const m of state.marks) {
    if (Math.abs(m.t - video.currentTime) < Math.abs(best.t - video.currentTime)) best = m;
  }
  mutate(() => {
    state.marks = state.marks.filter((m) => m.id !== best.id);
    if (state.sel && state.sel.id === best.id) state.sel = null;
  });
  setStatus('Zoom removed');
}

// ── Status ─────────────────────────────────────────────────────
function setStatus(text, live) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('live', !!live);
}

// ── Recording ──────────────────────────────────────────────────
const recordBtn = $('#recordBtn');
const exportBtn = $('#exportBtn');
const micBtn = $('#micBtn');

function pickMime() {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

micBtn.addEventListener('click', () => {
  state.mic = !state.mic;
  micBtn.setAttribute('aria-pressed', String(state.mic));
  micBtn.textContent = state.mic ? 'Mic on' : 'Mic off';
});

recordBtn.addEventListener('click', () => {
  if (state.recording) {
    state.recorder.stop();
    return;
  }
  startRecording();
});

async function startRecording() {
  state.recording = true;
  recordBtn.textContent = 'Stop';
  recordBtn.classList.add('armed');
  setStatus('Pick a screen, window or tab to share…', true);

  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 60 } },
      audio: true,
    });
  } catch (err) {
    resetRecordButton();
    state.recording = false;
    setStatus('Screen share cancelled');
    return;
  }

  let out = display;
  let micStream = null;
  if (state.mic) {
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { /* no mic */ }
  }
  if (micStream) {
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    if (display.getAudioTracks().length) ac.createMediaStreamSource(display).connect(dest);
    ac.createMediaStreamSource(micStream).connect(dest);
    out = new MediaStream([...display.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  }

  const mime = pickMime();
  const rec = new MediaRecorder(out, mime ? { mimeType: mime, videoBitsPerSecond: 14_000_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => finishRecording(chunks, mime, display, micStream);
  rec.start(500);
  state.recorder = rec;

  const started = performance.now();
  const tick = setInterval(() => {
    const s = (performance.now() - started) / 1000;
    setStatus(`● recording ${fmt(s)} — stop from here or the share bar`, true);
  }, 200);

  const stopShare = () => { if (state.recording) rec.stop(); };
  display.getVideoTracks()[0].addEventListener('ended', stopShare);
  rec.addEventListener('stop', () => clearInterval(tick), { once: true });

  setStatus('● recording — stop when you are done', true);
}

function resetRecordButton() {
  recordBtn.textContent = 'Record screen';
  recordBtn.classList.remove('armed');
}

async function finishRecording(chunks, mime, display, micStream) {
  state.recording = false;
  state.recorder = null;
  resetRecordButton();
  display.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: mime || 'video/webm' });
  if (!blob.size) { setStatus('Recording was empty — try again'); return; }

  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(blob);
  video.src = state.url;
  video.muted = true;
  video.load();

  await new Promise((resolve) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
  });

  // Chrome's MediaRecorder webm reports Infinity until the stream has been
  // seeked past the end; nudge it once so the timeline gets a real length.
  if (!Number.isFinite(video.duration)) {
    await new Promise((resolve) => {
      const onSeek = () => {
        video.removeEventListener('timeupdate', onSeek);
        video.currentTime = 0;
        resolve();
      };
      video.addEventListener('timeupdate', onSeek);
      video.currentTime = 1e101;
    });
  }

  state.duration = Number.isFinite(video.duration) ? video.duration : 0;

  // A fresh take starts a fresh project — nothing carries over.
  state.marks = [];
  state.texts = [];
  state.annos = [];
  state.sel = null;
  state.winIn = 0;
  state.winOut = 0;
  state.undo = [];
  state.redo = [];
  state.cursor.path = [];
  state.cursor.raw = [];
  state.cursor.on = false;
  syncCursorToggle();
  renderMarks();
  syncClock(0);
  registerTake(blob);

  playBtn.disabled = false;
  exportBtn.disabled = false;
  addBtn.disabled = false;
  $('#traceBtn').disabled = false;
  $('#cursorOn').disabled = false;
  ['addTextBtn', 'addBoxBtn', 'addCircleBtn', 'addArrowBtn', 'setIn', 'setOut', 'exportPng']
    .forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = false; });

  video.currentTime = 0.001;
  setStatus(`Recorded ${fmt(state.duration)} (${(blob.size / 1048576).toFixed(1)} MB) — add zooms, then export`);
}

// ── Export ─────────────────────────────────────────────────────
function audioDestination() {
  try {
    state.audioCtx = state.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    if (!state.audioNode) state.audioNode = state.audioCtx.createMediaElementSource(video);
    const dest = state.audioCtx.createMediaStreamDestination();
    state.audioNode.connect(dest);
    return dest;
  } catch (err) {
    return null;
  }
}

exportBtn.addEventListener('click', exportVideo);

async function exportVideo() {
  if (!state.url || state.exporting) return;
  state.exporting = true;
  exportBtn.disabled = true;
  recordBtn.disabled = true;
  video.pause();
  // Export the work area when one is set, otherwise the whole clip.
  const rangeStart = state.winOut ? state.winIn : 0;
  const rangeEnd = state.winOut ? state.winOut : state.duration;
  video.currentTime = rangeStart;
  setStatus('Rendering… 0%', true);
  await new Promise((r) => setTimeout(r, 150));

  const stream = canvas.captureStream(state.fps || 60);

  // Route the recording's audio through the captured stream. The element
  // stays muted to the speakers because nothing connects to ctx.destination.
  const dest = audioDestination();
  if (dest) {
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    video.muted = false;
  }

  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime
    ? { mimeType: mime, videoBitsPerSecond: Math.max(1, state.quality || 12) * 1_000_000 }
    : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(250);

  const progress = setInterval(() => {
    const span = Math.max(0.1, rangeEnd - rangeStart);
    const pct = Math.min(99, Math.max(0, Math.round(((video.currentTime - rangeStart) / span) * 100)));
    setStatus(`Rendering… ${pct}%`, true);
  }, 250);

  await new Promise((resolve) => {
    let settled = false;
    let watch = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (watch) clearInterval(watch);
      video.onended = null;
      video.pause();
      resolve();
    };
    watch = setInterval(() => {
      if (video.ended || video.currentTime >= rangeEnd - 0.02) finish();
    }, 90);
    video.onended = finish;
    video.play().catch(finish);
  });

  clearInterval(progress);
  rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  if (state.audioNode) state.audioNode.disconnect();

  video.muted = true;
  video.onended = null;
  video.currentTime = 0;

  const blob = new Blob(chunks, { type: mime || 'video/webm' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kino-${new Date().toISOString().slice(0, 10)}.webm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);

  state.exporting = false;
  exportBtn.disabled = false;
  recordBtn.disabled = false;
  setStatus(`Exported ${(blob.size / 1048576).toFixed(1)} MB — check your downloads`);
}

// ── Panel wiring ───────────────────────────────────────────────
const swatches = $('#swatches');
const palette = $('#palette');

// Flat brand blocks for the backdrop.
const PALETTE = [
  { name: 'Ink', hex: '#0d0e10' },
  { name: 'Cream', hex: '#f7f5ec' },
  { name: 'Lime', hex: '#b8f23a' },
  { name: 'Blue', hex: '#3f7cff' },
  { name: 'Sky', hex: '#9fd0ff' },
  { name: 'Panel', hex: '#14161b' },
];

for (const key of Object.keys(BG_LABEL)) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.dataset.bg = key;
  b.setAttribute('aria-pressed', String(key === state.bg));
  b.innerHTML = `<span>${BG_LABEL[key]}</span>`;
  b.style.background = `center / cover no-repeat url("${bgPreview(key)}")`;
  b.addEventListener('click', () => mutate(() => {
    state.bg = key;
    bgCache = null;
    lastDrawEmpty = null;
    [...swatches.children].forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.bg === key)));
    [...palette.children].forEach((p) => (p.dataset.active = 'false'));
  }));
  swatches.appendChild(b);
}

// Paint each preset once into a small thumbnail so the swatch matches the frame.
function bgPreview(key) {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 100;
  BGS[key](c.getContext('2d'), c.width, c.height);
  return c.toDataURL();
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 1400);
}

function copyHex(hex) {
  try { navigator.clipboard.writeText(hex).catch(() => {}); } catch (e) { /* clipboard blocked */ }
  toast(`Copied ${hex}`);
}

// Click a block to use it as the backdrop; click the hex strip to copy it.
function applySolid(hex) {
  state.solid = hex;
  state.bg = 'solid';
  bgCache = null;
  lastDrawEmpty = null;
  [...swatches.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
  [...palette.querySelectorAll('.pal')].forEach((p) => (p.dataset.active = String(p.dataset.hex === hex)));
}

for (const c of PALETTE) {
  const tile = document.createElement('div');
  tile.className = 'pal';
  tile.dataset.hex = c.hex;
  tile.dataset.active = 'false';
  tile.innerHTML =
    `<button class="pal-fill" style="background:${c.hex}" title="Use ${c.name} as the backdrop"></button>` +
    `<button class="pal-hex" title="Copy ${c.hex}">${c.hex}</button>`;
  palette.appendChild(tile);
}

const customTile = document.createElement('div');
customTile.className = 'pal custom';
customTile.innerHTML =
  `<label class="pal-fill" title="Pick any colour"><input type="color" id="customColor" value="#b8f23a" aria-label="Custom backdrop colour"></label>` +
  `<button class="pal-hex" id="customHex" title="Copy the custom colour">#b8f23a</button>`;
palette.appendChild(customTile);

palette.addEventListener('click', (e) => {
  const tile = e.target.closest('.pal');
  if (!tile || !tile.dataset.hex) return;
  const hex = tile.dataset.hex;
  if (e.target.closest('.pal-hex')) { copyHex(hex); return; }
  const base = snap();
  applySolid(hex);
  pushUndo(base);
  setStatus(`Backdrop: ${hex}`);
});

let colorBase = null;
$('#customColor').addEventListener('focus', () => { colorBase = snap(); });
$('#customColor').addEventListener('input', (e) => {
  const hex = e.target.value;
  $('#customHex').textContent = hex;
  applySolid(hex);
  setStatus(`Backdrop: ${hex}`);
});
$('#customColor').addEventListener('change', () => {
  if (colorBase) { pushUndo(colorBase); colorBase = null; }
});

$('#customHex').addEventListener('click', () => copyHex($('#customHex').textContent));

function bindSlider(id, labelId, apply) {
  const el = document.getElementById(id);
  if (!el) return;
  let base = null;
  el.addEventListener('pointerdown', () => { base = snap(); });
  el.addEventListener('input', (e) => {
    apply(Number(e.target.value));
    const lab = document.getElementById(labelId);
    if (lab) lab.textContent = id === 'zoom' ? `${state.zoom.toFixed(2)}×` : state[id === 'pad' ? 'padding' : id === 'rad' ? 'radius' : 'vignette'];
  });
  el.addEventListener('change', () => {
    if (base) { pushUndo(base); base = null; }
    renderProps();
  });
}
bindSlider('pad', 'padVal', (v) => { state.padding = v; });
bindSlider('rad', 'radVal', (v) => { state.radius = v; });
bindSlider('zoom', 'zoomVal', (v) => { state.zoom = v; });

// ── Cursor panel ───────────────────────────────────────────────
function syncCursorToggle() {
  const btn = $('#cursorOn');
  btn.setAttribute('aria-pressed', String(state.cursor.on));
  btn.textContent = state.cursor.on ? 'on' : 'off';
}

$('#cursorOn').addEventListener('click', () => {
  if (!state.cursor.path.length) {
    setStatus('Run “detect” first — it finds the pointer in the recording');
    return;
  }
  state.cursor.on = !state.cursor.on;
  syncCursorToggle();
  setStatus(state.cursor.on ? 'Custom cursor on' : 'Custom cursor off');
});

$('#traceBtn').addEventListener('click', traceCursor);

document.querySelectorAll('#cursorStyles .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    state.cursor.style = chip.dataset.style;
    document.querySelectorAll('#cursorStyles .chip').forEach((c) => {
      if (c.dataset.style) c.setAttribute('aria-pressed', String(c === chip));
    });
  });
});

$('#smooth').addEventListener('input', (e) => {
  state.cursor.smoothing = Number(e.target.value);
  $('#smoothVal').textContent = state.cursor.smoothing.toFixed(2);
  if (state.cursor.raw.length) {
    state.cursor.path = KinoCursor.smoothPath(state.cursor.raw, { smoothing: state.cursor.smoothing, gap: 0.4 });
  }
});
$('#lag').addEventListener('input', (e) => {
  state.cursor.lag = Number(e.target.value);
  $('#lagVal').textContent = `${state.cursor.lag.toFixed(2)}s`;
});
$('#size').addEventListener('input', (e) => {
  state.cursor.size = Number(e.target.value);
  $('#sizeVal').textContent = `${state.cursor.size.toFixed(2)}×`;
});

// ── Properties ────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function nrow(label, f, val, step, min, max) {
  const extra = `${min != null ? `min="${min}"` : ''} ${max != null ? `max="${max}"` : ''}`;
  return `<div class="prow"><label>${label}</label><input type="number" data-f="${f}" value="${val}" step="${step || 'any'}" ${extra}></div>`;
}
function arow(label, btns) {
  return `<div class="prow"><label>${label}</label><div class="pbtns">${btns}</div></div>`;
}

function renderProps() {
  const box = $('#props');
  if (!box) return;
  const sel = state.sel;

  if (!sel || (!sel.id && (sel.kind === 'zoom' || sel.kind === 'text' || sel.kind === 'anno'))) {
    const tk = state.takes.find((x) => x.id === state.activeTake);
    const items = state.marks.length + state.texts.length + state.annos.length;
    box.innerHTML =
      '<div class="grp">Composition</div>' +
      pshort('Take', tk ? tk.name : 'none') +
      pshort('Length', fmt(state.duration)) +
      pshort('Render', `${W}×${H}`) +
      pshort('Items', String(items)) +
      (items === 0
        ? '<p class="empty" style="margin-top:8px">Nothing placed yet — use Add on the left, then click the frame.</p>'
        : '<p class="empty" style="margin-top:8px">Select a layer or a bar to edit it.</p>');
    return;
  }

  if (sel.kind === 'zoom') {
    const m = findItem('zoom', sel.id);
    if (!m) { state.sel = null; return renderProps(); }
    box.innerHTML =
      '<div class="grp">Zoom mark</div>' +
      nrow('Start s', 't', m.t.toFixed(2), '0.05') +
      nrow('Focus X %', 'x', (m.x * 100).toFixed(0), '1') +
      nrow('Focus Y %', 'y', (m.y * 100).toFixed(0), '1') +
      nrow('Zoom ×', 'scale', m.scale.toFixed(2), '0.05', 1, 5) +
      arow('Action', '<button class="mini" data-act="center">Centre</button><button class="mini" data-act="delete">Delete</button>');
    bindProps(box, m, 'zoom');
    return;
  }

  if (sel.kind === 'text') {
    const s = findItem('text', sel.id);
    if (!s) { state.sel = null; return renderProps(); }
    box.innerHTML =
      '<div class="grp">Text</div>' +
      `<div class="prow"><label>Content</label><textarea data-f="text" rows="3">${escapeHtml(s.text)}</textarea></div>` +
      nrow('Start s', 't', s.t.toFixed(2), '0.05') +
      nrow('Duration', 'dur', s.dur.toFixed(2), '0.1', 0.2, 120) +
      nrow('Size', 'size', s.size, '1', 12, 300) +
      `<div class="prow"><label>Colour</label><input type="color" data-f="color" value="${s.color}"></div>` +
      nrow('X %', 'x', (s.x * 100).toFixed(0), '1') +
      nrow('Y %', 'y', (s.y * 100).toFixed(0), '1') +
      arow('Action', '<button class="mini" data-act="delete">Delete</button>');
    bindProps(box, s, 'span');
    return;
  }

  if (sel.kind === 'anno') {
    const a = findItem('anno', sel.id);
    if (!a) { state.sel = null; return renderProps(); }
    box.innerHTML =
      '<div class="grp">Annotation</div>' +
      `<div class="prow"><label>Shape</label><select data-f="shape"><option value="box"${a.shape === 'box' ? ' selected' : ''}>Box</option><option value="circle"${a.shape === 'circle' ? ' selected' : ''}>Circle</option><option value="arrow"${a.shape === 'arrow' ? ' selected' : ''}>Arrow</option></select></div>` +
      nrow('Start s', 't', a.t.toFixed(2), '0.05') +
      nrow('Duration', 'dur', a.dur.toFixed(2), '0.1', 0.2, 120) +
      `<div class="prow"><label>Colour</label><input type="color" data-f="color" value="${a.color}"></div>` +
      nrow('Weight', 'weight', a.weight, '1', 1, 30) +
      nrow('W %', 'w', (a.w * 100).toFixed(0), '1') +
      nrow('H %', 'h', (a.h * 100).toFixed(0), '1') +
      nrow('X %', 'x', (a.x * 100).toFixed(0), '1') +
      nrow('Y %', 'y', (a.y * 100).toFixed(0), '1') +
      arow('Action', '<button class="mini" data-act="delete">Delete</button>');
    bindProps(box, a, 'span');
    return;
  }

  if (sel.kind === 'look') {
    box.innerHTML =
      '<div class="grp">Look</div>' +
      `<div class="prow"><label>Preset</label><select data-f="look">${Object.keys(LOOKS)
        .map((k) => `<option value="${k}"${state.look === k ? ' selected' : ''}>${LOOKS[k].label}</option>`).join('')}</select></div>` +
      nrow('Vignette', 'vignette', state.vignette, '1', 0, 100);
    bindProps(box, state, 'clip');
    return;
  }

  if (sel.kind === 'cursor') {
    const p = state.cursor.path;
    box.innerHTML =
      '<div class="grp">Cursor</div>' +
      pshort('Tracked', p.length ? `${fmt(p[p.length - 1].t - p[0].t)} of pointer` : 'not detected') +
      pshort('Style', state.cursor.style) +
      pshort('Smoothing', state.cursor.smoothing.toFixed(2)) +
      pshort('State', state.cursor.on ? 'on' : 'off') +
      '<p class="empty" style="margin-top:8px">Cursor settings live in the Cursor panel on the right. Press Detect to re-trace.</p>';
  }
}

function pshort(label, val) {
  return `<div class="prow"><label>${label}</label><span class="mono" style="color:var(--text)">${escapeHtml(val)}</span></div>`;
}

function bindProps(box, item, kind) {
  let base = null;
  box.querySelectorAll('[data-f]').forEach((el) => {
    el.addEventListener('focus', () => { base = snap(); });
    el.addEventListener('input', () => applyProp(item, kind, el.dataset.f, el.value));
    el.addEventListener('change', () => {
      if (base) { pushUndo(base); base = null; }
      renderMarks();
    });
  });
  const del = box.querySelector('[data-act="delete"]');
  if (del) del.addEventListener('click', deleteSelected);
  const centre = box.querySelector('[data-act="center"]');
  if (centre) centre.addEventListener('click', () => mutate(() => { item.x = 0.5; item.y = 0.5; }));
}

function applyProp(item, kind, field, raw) {
  if (kind === 'clip') {
    if (field === 'look') { state.look = raw; lookPressed(); }
    else if (field === 'vignette') { state.vignette = Number(raw) || 0; syncLookControls(); }
    return;
  }
  if (field === 'text') { item.text = raw; return; }
  if (field === 'color' || field === 'shape') { item[field] = raw; return; }
  const v = Number(raw);
  if (!Number.isFinite(v)) return;
  if (field === 'x' || field === 'y') item[field] = clamp(v / 100, 0, 1);
  else if (field === 'w' || field === 'h') item[field] = clamp(v / 100, 0.02, 1);
  else if (field === 't') item.t = clamp(v, 0, Math.max(0, state.duration - (item.dur || 0)));
  else if (field === 'dur') item.dur = clamp(v, 0.2, 120);
  else if (field === 'scale') item.scale = clamp(v, 1, 5);
  else if (field === 'size') item.size = clamp(v, 12, 300);
  else if (field === 'weight') item.weight = clamp(v, 1, 30);
  if (kind === 'zoom') state.marks.sort((a, b) => a.t - b.t);
}

// ── Work area, transport, viewer ───────────────────────────────
function renderWin() {
  const win = $('#winArea');
  const inH = $('#inHandle');
  const outH = $('#outHandle');
  const rl = $('#rangeLabel');
  if (!win || !inH || !outH) return;
  if (!state.winOut) {
    win.hidden = true;
    inH.hidden = true;
    outH.hidden = true;
    if (rl) rl.textContent = 'Work area: full';
    return;
  }
  const a = pctOf(state.winIn);
  const b = pctOf(state.winOut);
  win.hidden = false;
  inH.hidden = false;
  outH.hidden = false;
  win.style.left = `${a}%`;
  win.style.width = `${Math.max(0, b - a)}%`;
  inH.style.left = `${a}%`;
  outH.style.left = `${b}%`;
  if (rl) rl.textContent = `Work area: ${fmt(state.winIn)} → ${fmt(state.winOut)}`;
}

function bindHandle(el, which) {
  if (!el) return;
  el.addEventListener('pointerdown', (e) => {
    if (!state.duration) return;
    e.stopPropagation();
    const rect = track.getBoundingClientRect();
    const base = snap();
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = clamp((ev.clientX - rect.left) / rect.width, 0, 1) * state.duration;
      if (which === 'in') state.winIn = clamp(r, 0, state.winOut ? state.winOut - 0.2 : state.duration);
      else state.winOut = clamp(r, state.winIn + 0.2, state.duration);
      renderWin();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      pushUndo(base);
      setStatus(`Work area ${fmt(state.winIn)} → ${fmt(state.winOut)}`);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}
bindHandle($('#inHandle'), 'in');
bindHandle($('#outHandle'), 'out');

$('#setIn').addEventListener('click', () => mutate(() => {
  state.winIn = video.currentTime;
  if (!state.winOut || state.winOut <= state.winIn) state.winOut = state.duration;
}));
$('#setOut').addEventListener('click', () => mutate(() => {
  state.winOut = video.currentTime;
  if (state.winIn >= state.winOut) state.winIn = 0;
}));
$('#resetRange').addEventListener('click', () => mutate(() => { state.winIn = 0; state.winOut = 0; }));

function setViewZoom(v) {
  state.viewZoom = v;
  const stage = $('#stage');
  if (v === 'fit') {
    stage.style.width = '';
    stage.style.maxWidth = '100%';
    stage.style.maxHeight = '100%';
  } else {
    stage.style.width = `${Number(v)}%`;
    stage.style.maxWidth = 'none';
    stage.style.maxHeight = 'none';
  }
}
$('#vZoom').addEventListener('change', (e) => setViewZoom(e.target.value));

$('#vRes').addEventListener('change', (e) => {
  state.res = Number(e.target.value);
  setRes(state.res);
  setStatus(`Render quality: ${e.target.selectedOptions[0].textContent} (${W}×${H})`);
});

$('#skipStart').addEventListener('click', () => seek(0));
$('#skipEnd').addEventListener('click', () => seek(state.duration));
$('#stepBack').addEventListener('click', () => seek(video.currentTime - 1 / 30));
$('#stepFwd').addEventListener('click', () => seek(video.currentTime + 1 / 30));
$('#loopBtn').addEventListener('click', () => {
  state.loop = !state.loop;
  $('#loopBtn').setAttribute('aria-pressed', String(state.loop));
  setStatus(state.loop ? 'Looping the work area' : 'Loop off');
});

// ── Shortcuts ──────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
  const cmdOpen = !document.getElementById('cmdk').hidden;

  if (cmdOpen) {
    const list = $('#cmdkList');
    if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!cmdkRows.length) return;
      cmdkIdx = (cmdkIdx + (e.key === 'ArrowDown' ? 1 : -1) + cmdkRows.length) % cmdkRows.length;
      [...list.children].forEach((n, j) => n.classList.toggle('on', j === cmdkIdx));
      const node = list.children[cmdkIdx];
      if (node) node.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = cmdkRows[cmdkIdx];
      closeCmdk();
      if (cmd) cmd.run();
      return;
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'k') { e.preventDefault(); openCmdk(); return; }
    if (k === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (k === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (k === 'e') { e.preventDefault(); exportVideo(); return; }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (key === 'z') beginPlace('zoom');
  else if (key === 't') beginPlace('text');
  else if (key === 'b') beginPlace('box');
  else if (key === 'c') beginPlace('circle');
  else if (key === 'a') beginPlace('arrow');
  else if (key === 'i') $('#setIn').click();
  else if (key === 'o') $('#setOut').click();
  else if (key === 'l') $('#loopBtn').click();
  else if (key === 'p') exportPng();
  else if (key === 'r') recordBtn.click();
  else if (key === ',') seek(video.currentTime - 1 / 30);
  else if (key === '.') seek(video.currentTime + 1 / 30);
  else if (e.key === 'Home') seek(0);
  else if (e.key === 'End') seek(state.duration);
  else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(video.currentTime - 1 / 30); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); seek(video.currentTime + 1 / 30); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'Escape') {
    if (state.place) {
      state.place = false;
      canvas.classList.remove('placing');
      setStatus('Placement cancelled');
    }
    closeMenus();
  }
});

// ── Project snapshot, undo ─────────────────────────────────────
// Everything but the recorded bytes is JSON-shaped, so one snapshot backs
// both undo and take switching.
function captureProject() {
  return {
    marks: state.marks,
    texts: state.texts,
    annos: state.annos,
    bg: state.bg,
    solid: state.solid,
    padding: state.padding,
    radius: state.radius,
    zoom: state.zoom,
    look: state.look,
    vignette: state.vignette,
    pattern: state.pattern,
    vis: state.vis,
    winIn: state.winIn,
    winOut: state.winOut,
    cursor: {
      on: state.cursor.on,
      style: state.cursor.style,
      size: state.cursor.size,
      smoothing: state.cursor.smoothing,
      lag: state.cursor.lag,
    },
  };
}

function loadProject(p) {
  if (!p || typeof p !== 'object') return;
  state.marks = p.marks || [];
  state.texts = p.texts || [];
  state.annos = p.annos || [];
  state.bg = p.bg || 'midnight';
  state.solid = p.solid || '#0d0e10';
  state.padding = p.padding != null ? p.padding : 96;
  state.radius = p.radius != null ? p.radius : 30;
  state.zoom = p.zoom != null ? p.zoom : 1.85;
  state.look = p.look || 'none';
  state.vignette = p.vignette || 0;
  state.pattern = p.pattern || 'none';
  state.vis = p.vis || { zoom: true, cursor: true, text: true, anno: true, look: true };
  state.winIn = p.winIn || 0;
  state.winOut = p.winOut || 0;
  if (p.cursor) Object.assign(state.cursor, p.cursor);
  state.sel = null;
  bgCache = null;
  lastDrawEmpty = null;
  syncClipControls();
  syncLookControls();
  lookPressed();
  syncCursorToggle();
  renderMarks();
  renderProps();
}

const snap = () => JSON.stringify(captureProject());

function pushUndo(base) {
  if (typeof base !== 'string' || base === snap()) return;
  state.undo.push(base);
  if (state.undo.length > 60) state.undo.shift();
  state.redo.length = 0;
}

function mutate(fn) {
  const base = snap();
  fn();
  pushUndo(base);
  afterChange();
}

function afterChange() {
  renderMarks();
  renderProps();
  syncClipControls();
  syncLookControls();
  lookPressed();
  lastDrawEmpty = null;
}

function undo() {
  if (!state.undo.length) { setStatus('Nothing to undo'); return; }
  const cur = snap();
  const prev = state.undo.pop();
  state.redo.push(cur);
  loadProject(JSON.parse(prev));
  setStatus('Undone');
}

function redo() {
  if (!state.redo.length) { setStatus('Nothing to redo'); return; }
  const cur = snap();
  const next = state.redo.pop();
  state.undo.push(cur);
  loadProject(JSON.parse(next));
  setStatus('Redone');
}

function syncClipControls() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('pad', state.padding);
  set('rad', state.radius);
  set('zoom', state.zoom);
  const txt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  txt('padVal', state.padding);
  txt('radVal', state.radius);
  txt('zoomVal', `${state.zoom.toFixed(2)}×`);
}

// ── Looks & backdrop treatment ─────────────────────────────────
function lookPressed() {
  document.querySelectorAll('#lookGroup .chip').forEach((c) => {
    c.setAttribute('aria-pressed', String(c.dataset.look === state.look));
  });
}
function syncLookControls() {
  const v = document.getElementById('vignette');
  const vv = document.getElementById('vignetteVal');
  const p = document.getElementById('pattern');
  if (v) v.value = state.vignette;
  if (vv) vv.textContent = state.vignette;
  if (p) p.value = state.pattern;
}
function setLook(k) {
  if (!LOOKS[k]) return;
  mutate(() => { state.look = k; });
  setStatus(`Look: ${LOOKS[k].label}`);
}

$('#lookGroup').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (b) setLook(b.dataset.look);
});
let vignBase = null;
$('#vignette').addEventListener('pointerdown', () => { vignBase = snap(); });
$('#vignette').addEventListener('input', (e) => {
  state.vignette = Number(e.target.value);
  $('#vignetteVal').textContent = state.vignette;
});
$('#vignette').addEventListener('change', () => {
  if (vignBase) { pushUndo(vignBase); vignBase = null; }
});
$('#pattern').addEventListener('change', (e) => mutate(() => {
  state.pattern = e.target.value;
  bgCache = null;
  lastDrawEmpty = null;
}));

// Export settings: rate and bitrate. Resolution lives on the viewer's Res
// control because it drives the backing store itself.
$('#expFps').addEventListener('change', (e) => {
  state.fps = Number(e.target.value);
  setStatus(`Export frame rate: ${state.fps} fps`);
});
$('#expQuality').addEventListener('change', (e) => {
  state.quality = Number(e.target.value);
  setStatus(`Export quality: ${state.quality} Mbps`);
});

// ── Takes ───────────────────────────────────────────────────────
function registerTake(blob) {
  state.takeSeq += 1;
  const take = {
    id: state.takeSeq,
    name: `Take ${state.takeSeq}`,
    url: state.url,
    dur: state.duration,
    size: blob.size,
    project: captureProject(),
  };
  state.takes.unshift(take);
  state.activeTake = take.id;
  renderTakes();
}

function renderTakes() {
  const list = $('#takeList');
  const c = $('#takeCount');
  if (c) c.textContent = `${state.takes.length} take${state.takes.length === 1 ? '' : 's'}`;
  list.innerHTML = '';
  if (!state.takes.length) {
    list.innerHTML = '<li class="empty">Nothing recorded yet. Hit <b>Record screen</b> to capture a window, tab or display.</li>';
    return;
  }
  state.takes.forEach((tk) => {
    const li = document.createElement('li');
    if (tk.id === state.activeTake) li.className = 'sel';
    li.innerHTML = `<span class="nm">${escapeHtml(tk.name)}</span><span class="len">${fmt(tk.dur)} · ${(tk.size / 1048576).toFixed(1)} MB</span>`;
    const kill = document.createElement('button');
    kill.className = 'kill';
    kill.textContent = '\u00d7';
    kill.title = 'Delete take';
    kill.addEventListener('click', (e) => { e.stopPropagation(); deleteTake(tk.id); });
    li.appendChild(kill);
    li.addEventListener('click', () => switchTake(tk.id));
    list.appendChild(li);
  });
}

async function switchTake(id) {
  const tk = state.takes.find((x) => x.id === id);
  if (!tk || tk.id === state.activeTake) return;
  const prev = state.takes.find((x) => x.id === state.activeTake);
  if (prev) prev.project = captureProject();
  state.activeTake = id;
  state.url = tk.url;
  video.pause();
  video.src = tk.url;
  video.muted = true;
  video.load();
  await new Promise((res) => video.addEventListener('loadedmetadata', res, { once: true }));
  state.duration = Number.isFinite(video.duration) ? video.duration : (tk.dur || 0);
  loadProject(tk.project || {});
  state.duration = Number.isFinite(video.duration) ? video.duration : (tk.dur || 0);
  video.currentTime = 0;
  syncClock(0);
  renderTakes();
  setStatus(`Loaded ${tk.name} — ${fmt(state.duration)}`);
}

function deleteTake(id) {
  const wasActive = state.activeTake === id;
  const tk = state.takes.find((x) => x.id === id);
  state.takes = state.takes.filter((x) => x.id !== id);
  if (wasActive && state.takes.length) {
    switchTake(state.takes[0].id);
  } else if (wasActive) {
    state.activeTake = null;
    state.url = '';
    state.duration = 0;
    video.pause();
    video.removeAttribute('src');
    video.load();
    playBtn.disabled = true;
    exportBtn.disabled = true;
    ['addZoom', 'addTextBtn', 'addBoxBtn', 'addCircleBtn', 'addArrowBtn', 'setIn', 'setOut', 'exportPng']
      .forEach((i) => { const el = document.getElementById(i); if (el) el.disabled = true; });
    renderMarks();
    renderProps();
    syncClock(0);
  }
  if (tk) setTimeout(() => URL.revokeObjectURL(tk.url), 1500);
  renderTakes();
  setStatus(wasActive && !state.takes.length ? 'Take deleted — nothing left to edit' : 'Take deleted');
}

function exportPng() {
  canvas.toBlob((blob) => {
    if (!blob) { setStatus('Could not read the frame'); return; }
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = `kino-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 20000);
    toast('Frame exported as PNG');
  }, 'image/png');
}

// ── Command palette ────────────────────────────────────────────
const COMMANDS = [
  { label: 'Record screen', keys: 'R', run: () => recordBtn.click() },
  { label: 'Export video', keys: 'Ctrl+E', run: () => exportVideo(), on: () => !state.url && !state.exporting },
  { label: 'Export current frame as PNG', keys: 'P', run: exportPng, on: () => !!state.url },
  { sep: true },
  { label: 'Add zoom mark', keys: 'Z', run: () => beginPlace('zoom'), on: () => !!state.url },
  { label: 'Add text', keys: 'T', run: () => beginPlace('text'), on: () => !!state.url },
  { label: 'Add box annotation', keys: 'B', run: () => beginPlace('box'), on: () => !!state.url },
  { label: 'Add circle annotation', keys: 'C', run: () => beginPlace('circle'), on: () => !!state.url },
  { label: 'Add arrow annotation', keys: 'A', run: () => beginPlace('arrow'), on: () => !!state.url },
  { sep: true },
  { label: 'Play / pause', keys: 'Space', run: togglePlay, on: () => !!state.url },
  { label: 'Set work-area in point', keys: 'I', run: () => $('#setIn').click(), on: () => !!state.url },
  { label: 'Set work-area out point', keys: 'O', run: () => $('#setOut').click(), on: () => !!state.url },
  { label: 'Clear work area', keys: '', run: () => $('#resetRange').click() },
  { label: 'Toggle loop', keys: 'L', run: () => $('#loopBtn').click() },
  { label: 'Detect cursor in recording', keys: '', run: () => $('#traceBtn').click(), on: () => !!state.url && !state.tracing },
  { sep: true },
  { label: 'Undo', keys: 'Ctrl+Z', run: undo, on: () => state.undo.length > 0 },
  { label: 'Redo', keys: 'Ctrl+Shift+Z', run: redo, on: () => state.redo.length > 0 },
  { label: 'Delete selection', keys: 'Del', run: deleteSelected, on: () => !!state.sel },
  { sep: true },
  { label: 'Look: Normal', keys: '', run: () => setLook('none') },
  { label: 'Look: Mono', keys: '', run: () => setLook('mono') },
  { label: 'Look: Sepia', keys: '', run: () => setLook('sepia') },
  { label: 'Look: Vivid', keys: '', run: () => setLook('vivid') },
  { label: 'Look: Soft', keys: '', run: () => setLook('soft') },
  { label: 'Look: Punch', keys: '', run: () => setLook('punch') },
  { sep: true },
  { label: 'Backdrop pattern: None', keys: '', run: () => setPattern('none') },
  { label: 'Backdrop pattern: Dots', keys: '', run: () => setPattern('dots') },
  { label: 'Backdrop pattern: Grid', keys: '', run: () => setPattern('grid') },
  { label: 'Backdrop pattern: Scanlines', keys: '', run: () => setPattern('scan') },
  { label: 'Backdrop pattern: Radial glow', keys: '', run: () => setPattern('glow') },
  { sep: true },
  { label: 'View: Fit', keys: '', run: () => setViewZoomChoice('fit') },
  { label: 'View: 100%', keys: '', run: () => setViewZoomChoice('100') },
  { label: 'View: 200%', keys: '', run: () => setViewZoomChoice('200') },
  { label: 'Render quality: Full', keys: '', run: () => setResChoice('1') },
  { label: 'Render quality: Half', keys: '', run: () => setResChoice('0.5') },
  { label: 'Render quality: Quarter', keys: '', run: () => setResChoice('0.25') },
  { sep: true },
  { label: 'Toggle microphone', keys: '', run: () => micBtn.click() },
  { label: 'Toggle panel theme contrast', keys: '', run: () => toggleContrast() },
  { label: 'Keyboard shortcuts', keys: 'Ctrl+K', run: () => openCmdk() },
];

function setPattern(p) {
  mutate(() => { state.pattern = p; bgCache = null; lastDrawEmpty = null; });
  setStatus(`Backdrop pattern: ${p}`);
}
function setViewZoomChoice(v) {
  const el = $('#vZoom');
  if (el) el.value = v;
  setViewZoom(v);
  setStatus(`View: ${v === 'fit' ? 'Fit' : v + '%'}`);
}
function setResChoice(v) {
  const el = $('#vRes');
  if (el) el.value = v;
  state.res = Number(v);
  setRes(state.res);
  setStatus(`Render quality: ${W}×${H}`);
}
function toggleContrast() {
  document.body.classList.toggle('high');
  setStatus(document.body.classList.contains('high') ? 'High-contrast panels on' : 'High-contrast panels off');
}

let cmdkIdx = 0;
let cmdkRows = [];

function openCmdk() {
  const box = $('#cmdk');
  box.hidden = false;
  $('#cmdkInput').value = '';
  fillCmdk('');
  $('#cmdkInput').focus();
}
function closeCmdk() {
  const box = $('#cmdk');
  if (box) box.hidden = true;
}
function fillCmdk(q) {
  const list = $('#cmdkList');
  const query = q.trim().toLowerCase();
  cmdkRows = COMMANDS.filter((c) => !c.sep && (!query || c.label.toLowerCase().includes(query)));
  cmdkIdx = 0;
  list.innerHTML = '';
  if (!cmdkRows.length) {
    list.innerHTML = '<li class="none">No matching command</li>';
    return;
  }
  cmdkRows.forEach((c, i) => {
    const li = document.createElement('li');
    const enabled = c.on ? c.on() : true;
    li.className = (i === 0 ? 'on' : '') + (enabled ? '' : ' off');
    if (!enabled) li.style.opacity = '0.4';
    li.innerHTML = `<span>${escapeHtml(c.label)}</span><span class="mono">${escapeHtml(c.keys || '')}</span>`;
    li.addEventListener('click', () => { closeCmdk(); c.run(); });
    li.addEventListener('mousemove', () => {
      cmdkIdx = i;
      [...list.children].forEach((n, j) => n.classList.toggle('on', j === i));
    });
    list.appendChild(li);
  });
}
$('#cmdkInput').addEventListener('input', (e) => fillCmdk(e.target.value));
$('#cmdk').addEventListener('click', (e) => { if (e.target.id === 'cmdk') closeCmdk(); });

// ── Menus ──────────────────────────────────────────────────────
const MENUS = {
  project: ['Record screen', '-', 'Export video', 'Export current frame as PNG', '-', 'Detect cursor in recording'],
  edit: ['Undo', 'Redo', '-', 'Delete selection', '-', 'Set work-area in point', 'Set work-area out point', 'Clear work area'],
  view: ['View: Fit', 'View: 100%', 'View: 200%', '-', 'Render quality: Full', 'Render quality: Half', 'Render quality: Quarter', '-', 'Toggle loop'],
  help: ['Keyboard shortcuts', '-', 'Toggle panel theme contrast'],
};

function closeMenus() {
  const pop = $('#menuPop');
  if (pop) pop.hidden = true;
  document.querySelectorAll('.mnu.on').forEach((b) => b.classList.remove('on'));
}

function openMenu(btn) {
  const pop = $('#menuPop');
  const name = btn.dataset.menu;
  const keys = MENUS[name] || [];
  const already = btn.classList.contains('on');
  closeMenus();
  if (already) return;
  btn.classList.add('on');
  pop.innerHTML = '';
  keys.forEach((label) => {
    if (label === '-') { pop.appendChild(document.createElement('hr')); return; }
    const cmd = COMMANDS.find((c) => !c.sep && c.label === label);
    if (!cmd) return;
    const b = document.createElement('button');
    const enabled = cmd.on ? cmd.on() : true;
    b.disabled = !enabled;
    b.innerHTML = `<span>${escapeHtml(cmd.label)}</span><span class="mono">${escapeHtml(cmd.keys || '')}</span>`;
    b.addEventListener('click', () => { closeMenus(); cmd.run(); });
    pop.appendChild(b);
  });
  const r = btn.getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = `${r.left}px`;
  pop.style.top = `${r.bottom + 1}px`;
}

$('#menus').addEventListener('click', (e) => {
  const b = e.target.closest('.mnu');
  if (b) openMenu(b);
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#menuPop') && !e.target.closest('.mnu')) closeMenus();
});

// ── Boot ───────────────────────────────────────────────────────
state.marks = [];
renderTakes();
renderMarks();
renderProps();
renderWin();
syncClock(0);
setStatus('Ready — record your screen to start');
loop();
