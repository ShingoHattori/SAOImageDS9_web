/* plots.js — DS9-style analysis plots in a modal:
 *   histogram   — distribution of displayed pixel values
 *   hcut / vcut — value profile along the cursor row / column (live)
 *   radial      — azimuthally-averaged radial profile about a centre
 *                 (a selected circle region's centre, else the cursor)
 * Pure canvas line/bar rendering; reads the viewer's displayed image.
 */
(function (global) {
  'use strict';

  function Plots(viewer, els, getCenter) {
    this.v = viewer;
    this.els = els;
    this.getCenter = getCenter;     // () -> {ix,iy,maxR}|null  (from regions)
    this.cursor = null;
    this.open = false;
  }

  Plots.prototype.toggle = function () { this.open ? this.close() : this.show(); };
  Plots.prototype.show = function () { this.open = true; this.els.modal.classList.remove('hidden'); this.render(); };
  Plots.prototype.close = function () { this.open = false; this.els.modal.classList.add('hidden'); };

  Plots.prototype.setCursor = function (info) {
    this.cursor = (info && info.inside) ? info : this.cursor;
    if (this.open) {
      const t = this.els.type.value;
      if (t === 'hcut' || t === 'vcut' || t === 'radial') this.render();
    }
  };

  Plots.prototype.render = function () {
    if (!this.open) return;
    const v = this.v, cv = this.els.canvas, ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!v.image) return;
    const t = this.els.type.value;
    if (t === 'histogram') this._histogram(ctx, cv);
    else if (t === 'hcut') this._cut(ctx, cv, 'h');
    else if (t === 'vcut') this._cut(ctx, cv, 'v');
    else if (t === 'radial') this._radial(ctx, cv);
  };

  // ---- generic plot frame ----
  function frame(ctx, cv) {
    const m = { l: 52, r: 14, t: 14, b: 30 };
    const x0 = m.l, y0 = cv.height - m.b, x1 = cv.width - m.r, y1 = m.t;
    ctx.strokeStyle = '#555'; ctx.fillStyle = '#9aa0aa';
    ctx.lineWidth = 1; ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.beginPath();
    ctx.moveTo(x0, y1); ctx.lineTo(x0, y0); ctx.lineTo(x1, y0);
    ctx.stroke();
    return { x0, y0, x1, y1, w: x1 - x0, h: y0 - y1 };
  }
  function axisLabels(ctx, fr, xmin, xmax, ymin, ymax, xlab, ylab) {
    ctx.fillStyle = '#9aa0aa'; ctx.textBaseline = 'top';
    ctx.fillText(fmt(xmin), fr.x0, fr.y0 + 6);
    ctx.textAlign = 'right'; ctx.fillText(fmt(xmax), fr.x1, fr.y0 + 6);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom'; ctx.fillText(fmt(ymax), 4, fr.y1 + 10);
    ctx.fillText(fmt(ymin), 4, fr.y0);
    ctx.fillStyle = '#6f86a8';
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    ctx.fillText(xlab, (fr.x0 + fr.x1) / 2, fr.y0 + 16);
    ctx.textAlign = 'left';
  }
  function fmt(v) {
    if (!Number.isFinite(v)) return '–';
    const a = Math.abs(v);
    if (v === 0) return '0';
    if (a >= 1e4 || a < 1e-2) return v.toExponential(1);
    return (Math.round(v * 100) / 100).toString();
  }
  function plotLine(ctx, fr, xs, ys, xmin, xmax, ymin, ymax, color) {
    const sx = x => fr.x0 + (x - xmin) / (xmax - xmin || 1) * fr.w;
    const sy = y => fr.y0 - (y - ymin) / (ymax - ymin || 1) * fr.h;
    ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.beginPath();
    let started = false;
    for (let i = 0; i < ys.length; i++) {
      if (!Number.isFinite(ys[i])) { started = false; continue; }
      const X = sx(xs ? xs[i] : i), Y = sy(ys[i]);
      started ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      started = true;
    }
    ctx.stroke();
  }
  function extent(arr) {
    let mn = Infinity, mx = -Infinity;
    for (const v of arr) if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
    if (!Number.isFinite(mn)) { mn = 0; mx = 1; }
    if (mn === mx) mx = mn + 1;
    return [mn, mx];
  }

  // ---- histogram ----
  Plots.prototype._histogram = function (ctx, cv) {
    const v = this.v, data = v.image.data;
    const lo = v.low, hi = v.high, span = (hi - lo) || 1, NB = 128;
    const bins = new Float64Array(NB);
    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      if (!Number.isFinite(val)) continue;
      let b = Math.floor((val - lo) / span * NB);
      if (b < 0) b = 0; else if (b >= NB) b = NB - 1;
      bins[b]++;
    }
    const fr = frame(ctx, cv);
    const [, ymax] = extent(bins);
    ctx.fillStyle = '#4c8dff';
    const bw = fr.w / NB;
    for (let i = 0; i < NB; i++) {
      const hgt = bins[i] / (ymax || 1) * fr.h;
      ctx.fillRect(fr.x0 + i * bw, fr.y0 - hgt, Math.max(1, bw - 0.5), hgt);
    }
    axisLabels(ctx, fr, lo, hi, 0, ymax, 'pixel value', 'count');
    this._title(`histogram — ${data.length} px, ${NB} bins`);
  };

  // ---- horizontal / vertical cut ----
  Plots.prototype._cut = function (ctx, cv, dir) {
    const v = this.v, { width: w, height: h, data } = v.image;
    const c = this.cursor;
    const ys = [];
    let label;
    if (dir === 'h') {
      const row = c ? c.row : (h >> 1);
      for (let x = 0; x < w; x++) ys.push(data[row * w + x]);
      label = `row y=${row}`;
    } else {
      const col = c ? c.col : (w >> 1);
      for (let y = 0; y < h; y++) ys.push(data[y * w + col]);
      label = `column x=${col}`;
    }
    const fr = frame(ctx, cv);
    const [ymin, ymax] = extent(ys);
    plotLine(ctx, fr, null, ys, 0, ys.length - 1, ymin, ymax, '#46d063');
    axisLabels(ctx, fr, 0, ys.length - 1, ymin, ymax, dir === 'h' ? 'x (pixel)' : 'y (pixel)', 'value');
    this._title(`${dir === 'h' ? 'horizontal' : 'vertical'} cut — ${label}`);
  };

  // ---- radial profile ----
  Plots.prototype._radial = function (ctx, cv) {
    const v = this.v, { width: w, height: h, data } = v.image;
    const ctr = this.getCenter && this.getCenter();
    const cx = ctr ? ctr.ix : (this.cursor ? this.cursor.ix : w / 2);
    const cy = ctr ? ctr.iy : (this.cursor ? this.cursor.iy : h / 2);
    const maxR = Math.max(4, Math.min(ctr ? Math.ceil(ctr.maxR) : 40, Math.hypot(w, h) / 2));
    const sum = new Float64Array(maxR + 1), cnt = new Float64Array(maxR + 1);
    const x0 = Math.max(0, Math.floor(cx - maxR - 1)), x1 = Math.min(w, Math.ceil(cx + maxR + 1));
    const y0 = Math.max(0, Math.floor(cy - maxR - 1)), y1 = Math.min(h, Math.ceil(cy + maxR + 1));
    for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++) {
      const val = data[r * w + c];
      if (!Number.isFinite(val)) continue;
      const rad = Math.hypot((c + 0.5) - cx, (r + 0.5) - cy);
      const b = Math.round(rad);
      if (b <= maxR) { sum[b] += val; cnt[b]++; }
    }
    const prof = [];
    for (let i = 0; i <= maxR; i++) prof.push(cnt[i] ? sum[i] / cnt[i] : NaN);
    const fr = frame(ctx, cv);
    const [ymin, ymax] = extent(prof);
    plotLine(ctx, fr, null, prof, 0, maxR, ymin, ymax, '#ffd24c');
    axisLabels(ctx, fr, 0, maxR, ymin, ymax, 'radius (pixel)', 'mean');
    this._title(`radial profile — centre (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
  };

  Plots.prototype._title = function (s) { if (this.els.title) this.els.title.textContent = s; };

  global.Plots = Plots;
})(window);
