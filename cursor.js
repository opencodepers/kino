// Kino cursor tracker — pure math, no DOM, so it can be exercised from Node.
// Screen capture gives us no pointer coordinates, so the pointer is recovered
// from the pixels: whichever small cluster of pixels changes from frame to
// frame, near where the pointer was last seen, is the pointer.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinoCursor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CELL = 6;          // analysis grid cell, px
  const DIFF = 60;         // summed RGB delta that counts as motion
  const MIN_BLOB = 4;      // changed cells needed to treat it as the cursor
  const SEARCH = 9;        // cells to search around the last position
  const GAP = 0.4;         // seconds of missing data that hides the cursor

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // One frame pair → pointer position in 0..1 frame coordinates, or null.
  function trackFrame(cur, prev, w, h, last) {
    const cols = Math.ceil(w / CELL);
    const rows = Math.ceil(h / CELL);
    const score = new Float32Array(cols * rows);
    let total = 0;

    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = (row + x) * 4;
        const d = Math.abs(cur[i] - prev[i])
          + Math.abs(cur[i + 1] - prev[i + 1])
          + Math.abs(cur[i + 2] - prev[i + 2]);
        if (d > DIFF) {
          score[((y / CELL) | 0) * cols + ((x / CELL) | 0)] += 1;
          total++;
        }
      }
    }
    if (!total) return null;

    let best = -1;
    let bestScore = 0;
    const scan = (windowed) => {
      const cx0 = last ? clamp(Math.round(last.x * cols), 0, cols - 1) : -1;
      const cy0 = last ? clamp(Math.round(last.y * rows), 0, rows - 1) : -1;
      for (let cy = 0; cy < rows; cy++) {
        if (windowed && Math.abs(cy - cy0) > SEARCH) continue;
        for (let cx = 0; cx < cols; cx++) {
          if (windowed && Math.abs(cx - cx0) > SEARCH) continue;
          const s = score[cy * cols + cx];
          if (s > bestScore) { bestScore = s; best = cy * cols + cx; }
        }
      }
    };

    // Prefer motion near the last known position; fall back to the whole frame
    // so a fast flick or a missed frame doesn't lose the pointer for good.
    if (last) scan(true);
    if (best < 0 || bestScore < MIN_BLOB) {
      bestScore = 0;
      best = -1;
      scan(false);
    }
    if (best < 0 || bestScore < MIN_BLOB) return null;

    // Sub-cell centroid so the path doesn't snap to a 6px grid. The window
    // has to be wide enough for the whole blob (a 40px pointer spans 7 cells)
    // while the threshold keeps unrelated motion out of the average.
    const bx = best % cols;
    const by = (best / cols) | 0;
    const cut = bestScore * 0.3;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let cy = Math.max(0, by - 3); cy <= Math.min(rows - 1, by + 3); cy++) {
      for (let cx = Math.max(0, bx - 3); cx <= Math.min(cols - 1, bx + 3); cx++) {
        const s = score[cy * cols + cx];
        if (s < cut) continue;
        sx += (cx + 0.5) * s;
        sy += (cy + 0.5) * s;
        sw += s;
      }
    }
    if (!sw) return null;
    return {
      x: clamp((sx / sw) / cols, 0, 1),
      y: clamp((sy / sw) / rows, 0, 1),
      conf: clamp(bestScore / 12, 0, 1),
    };
  }

  function medianFilter(values, radius) {
    return values.map((_, i) => {
      const w = [];
      for (let j = i - radius; j <= i + radius; j++) if (values[j] != null) w.push(values[j]);
      w.sort((a, b) => a - b);
      return w[w.length >> 1];
    });
  }

  // Raw per-frame hits → a dense, de-jittered path.
  function smoothPath(samples, opts) {
    const o = opts || {};
    const smoothing = clamp(o.smoothing == null ? 0.6 : o.smoothing, 0, 0.95);
    const keep = (samples || []).filter((s) => s && s.conf >= 0.15);
    if (keep.length < 3) return [];

    const mx = medianFilter(keep.map((s) => s.x), 2);
    const my = medianFilter(keep.map((s) => s.y), 2);

    // Forward pass then backward pass: heavy low-pass with no lag, which is
    // what makes the motion read as "fluid" rather than "delayed".
    const a = Math.max(0.08, 1 - smoothing * 0.95);
    const ema = (arr) => {
      const out = [];
      let v = arr[0];
      for (const x of arr) { v += (x - v) * a; out.push(v); }
      return out;
    };
    const fx = ema(mx);
    const fy = ema(my);
    const bx = ema(mx.slice().reverse()).reverse();
    const by = ema(my.slice().reverse()).reverse();

    return keep.map((s, i) => ({
      t: s.t,
      x: (fx[i] + bx[i]) / 2,
      y: (fy[i] + by[i]) / 2,
      c: s.conf,
    }));
  }

  // Position at an arbitrary time. Returns null across gaps so the cursor
  // hides instead of sliding through a stretch we never saw.
  function sampleAt(path, t, gapMax) {
    const n = path ? path.length : 0;
    if (!n) return null;
    if (t <= path[0].t || t >= path[n - 1].t) return null;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (path[mid].t <= t) lo = mid; else hi = mid;
    }
    const p = path[lo];
    const q = path[hi];
    const span = q.t - p.t;
    if (span > (gapMax == null ? GAP : gapMax)) return null;
    const f = span > 0 ? (t - p.t) / span : 0;
    return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
  }

  return { trackFrame, smoothPath, sampleAt };
});
