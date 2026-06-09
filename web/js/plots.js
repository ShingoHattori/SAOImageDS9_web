/* plots.js — DS9-style analysis plots in a modal:
 *   histogram   — distribution of displayed pixel values
 *   hcut / vcut — value profile along the cursor row / column (live)
 *   radial      — azimuthally-averaged radial profile about a centre
 *                 (a selected circle region's centre, else the cursor)
 * Pure canvas line/bar rendering; reads the viewer's displayed image.
 */
(function (global) {
  'use strict';

  function Plots(viewer, els, getCenter, getLine) {
    this.v = viewer;
    this.els = els;
    this.getCenter = getCenter;     // () -> {ix,iy,maxR}|null  (from regions)
    this.getLine = getLine;         // () -> {x1,y1,x2,y2}|null  (line region)
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
    this._last = null;
    if (!v.image) return;
    const t = this.els.type.value;
    if (t === 'histogram') this._histogram(ctx, cv);
    else if (t === 'hcut') this._cut(ctx, cv, 'h');
    else if (t === 'vcut') this._cut(ctx, cv, 'v');
    else if (t === 'radial') this._radial(ctx, cv);
    else if (t === 'projection') this._projection(ctx, cv);
  };

  // ---- projection: value sampled along the selected line region ----
  Plots.prototype._projection = function (ctx, cv) {
    const line = this.getLine && this.getLine();
    if (!line) { frame(ctx, cv); this._title('projection — line リージョンを選択'); return; }
    const { width: w, height: h, data } = this.v.image;
    const { x1, y1, x2, y2 } = line;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const N = Math.max(2, Math.round(len));
    const ys = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, ix = x1 + (x2 - x1) * t, iy = y1 + (y2 - y1) * t;
      const col = Math.floor(ix), row = Math.floor(iy);
      ys.push((data && col >= 0 && col < w && row >= 0 && row < h) ? data[row * w + col] : NaN);
    }
    const fr = frame(ctx, cv);
    const [ymin, ymax] = extent(ys);
    plotLine(ctx, fr, null, ys, 0, len, ymin, ymax, '#46d063');
    axisLabels(ctx, fr, 0, len, ymin, ymax, 'distance (pixel)', 'value');
    this._title(`projection — length ${len.toFixed(1)} px`);
    this._last = { title: 'projection', xlabel: 'distance', ylabel: 'value',
      xs: ys.map((_, i) => i / N * len), ys };
  };

  // Export the current plot's data as CSV text and trigger a download.
  Plots.prototype.exportData = function () {
    const d = this._last;
    if (!d) return;
    let out = `# ${d.title}\n${d.xlabel},${d.ylabel}\n`;
    for (let i = 0; i < d.ys.length; i++)
      out += `${d.xs ? d.xs[i] : i},${d.ys[i]}\n`;
    const blob = new Blob([out], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `plot_${this.els.type.value}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Histogram of an arbitrary value array (e.g. a table column). One-shot view.
  Plots.prototype.columnHistogram = function (values, label) {
    this.open = true;
    this.els.modal.classList.remove('hidden');
    const cv = this.els.canvas, ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    let lo = Infinity, hi = -Infinity;
    for (const v of values) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi === lo) hi = lo + 1;
    const NB = 128, span = hi - lo, bins = new Float64Array(NB);
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      let b = Math.floor((v - lo) / span * NB);
      if (b < 0) b = 0; else if (b >= NB) b = NB - 1;
      bins[b]++;
    }
    const fr = frame(ctx, cv);
    const [, ymax] = extent(bins);
    ctx.fillStyle = '#4c8dff';
    const bw = fr.w / NB;
    for (let i = 0; i < NB; i++) { const hgt = bins[i] / (ymax || 1) * fr.h; ctx.fillRect(fr.x0 + i * bw, fr.y0 - hgt, Math.max(1, bw - 0.5), hgt); }
    axisLabels(ctx, fr, lo, hi, 0, ymax, label, 'count');
    this._title(`column: ${label} — ${values.length} rows`);
    this._histAxis = null;
    const centres = []; for (let i = 0; i < NB; i++) centres.push(lo + (i + 0.5) / NB * span);
    this._last = { title: 'column ' + label, xlabel: label, ylabel: 'count', xs: centres, ys: Array.from(bins) };
  };

  // 1-D Gaussian fit y = B + A*exp(-x^2 / 2σ^2) (centre fixed at x=0).
  function fitGaussian(xs, ys) {
    const pts = [];
    for (let i = 0; i < ys.length; i++) if (Number.isFinite(ys[i])) pts.push([xs[i], ys[i]]);
    if (pts.length < 4) return null;
    let B = pts[pts.length - 1][1];
    let A = pts[0][1] - B;
    if (A === 0) return null;
    let sigma = 1;
    for (const [x, y] of pts) if ((y - B) <= A / 2) { sigma = x / 1.1774 || 1; break; }
    // Gauss-Newton refinement
    for (let iter = 0; iter < 12; iter++) {
      let JtJ = [[0,0,0],[0,0,0],[0,0,0]], Jtr = [0,0,0];
      for (const [x, y] of pts) {
        const e = Math.exp(-(x*x) / (2*sigma*sigma));
        const f = B + A*e;
        const r = y - f;
        const dA = e, dB = 1, dS = A*e*(x*x)/(sigma*sigma*sigma);
        const J = [dA, dS, dB];
        for (let a = 0; a < 3; a++) { Jtr[a] += J[a]*r; for (let b = 0; b < 3; b++) JtJ[a][b] += J[a]*J[b]; }
      }
      for (let i = 0; i < 3; i++) JtJ[i][i] *= 1.0001;        // tiny damping
      const d = solve3(JtJ, Jtr);
      if (!d) break;
      A += d[0]; sigma += d[1]; B += d[2];
      if (sigma < 1e-3) sigma = 1e-3;
      if (Math.hypot(d[0], d[1], d[2]) < 1e-6) break;
    }
    return { A, sigma: Math.abs(sigma), B, fwhm: 2.354820045 * Math.abs(sigma) };
  }
  function solve3(M, v) {
    const det = M[0][0]*(M[1][1]*M[2][2]-M[1][2]*M[2][1])
              - M[0][1]*(M[1][0]*M[2][2]-M[1][2]*M[2][0])
              + M[0][2]*(M[1][0]*M[2][1]-M[1][1]*M[2][0]);
    if (Math.abs(det) < 1e-12) return null;
    // Cramer's rule
    const col = (M, i, vec) => M.map((row, r) => row.map((val, k) => k === i ? vec[r] : val));
    const d = MM => MM[0][0]*(MM[1][1]*MM[2][2]-MM[1][2]*MM[2][1])
                   - MM[0][1]*(MM[1][0]*MM[2][2]-MM[1][2]*MM[2][0])
                   + MM[0][2]*(MM[1][0]*MM[2][1]-MM[1][1]*MM[2][0]);
    return [d(col(M,0,v))/det, d(col(M,1,v))/det, d(col(M,2,v))/det];
  }

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
    // current Low/High markers (for click-to-set feedback)
    const mark = (val, col) => {
      const X = fr.x0 + (val - lo) / span * fr.w;
      if (X < fr.x0 || X > fr.x1) return;
      ctx.strokeStyle = col; ctx.setLineDash([3, 2]); ctx.beginPath();
      ctx.moveTo(X, fr.y1); ctx.lineTo(X, fr.y0); ctx.stroke(); ctx.setLineDash([]);
    };
    mark(v.low, '#4c8dff'); mark(v.high, '#ff6b6b');
    this._histAxis = { x0: fr.x0, x1: fr.x1, lo, span };
    axisLabels(ctx, fr, lo, hi, 0, ymax, 'pixel value (click=Low, Shift+click=High)', 'count');
    this._title(`histogram — ${data.length} px, ${NB} bins`);
    const centres = []; for (let i = 0; i < NB; i++) centres.push(lo + (i + 0.5) / NB * span);
    this._last = { title: 'histogram', xlabel: 'value', ylabel: 'count', xs: centres, ys: Array.from(bins) };
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
    this._last = { title: `${dir}cut ${label}`, xlabel: dir === 'h' ? 'x' : 'y', ylabel: 'value', xs: null, ys };
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

    // Gaussian fit overlay
    const radii = prof.map((_, i) => i);
    const fit = fitGaussian(radii, prof);
    let titleExtra = '';
    if (fit) {
      const model = radii.map(r => fit.B + fit.A * Math.exp(-(r*r) / (2*fit.sigma*fit.sigma)));
      ctx.save(); ctx.setLineDash([5, 3]);
      plotLine(ctx, fr, null, model, 0, maxR, ymin, ymax, '#4c8dff');
      ctx.restore();
      titleExtra = `  ·  fit: FWHM=${fit.fwhm.toFixed(2)} px, σ=${fit.sigma.toFixed(2)}, peak=${(fit.A).toPrecision(3)}`;
      this._fit = fit;
    }
    axisLabels(ctx, fr, 0, maxR, ymin, ymax, 'radius (pixel)', 'mean');
    this._title(`radial — centre (${cx.toFixed(1)}, ${cy.toFixed(1)})${titleExtra}`);
    this._last = { title: `radial centre ${cx.toFixed(1)},${cy.toFixed(1)}`, xlabel: 'radius', ylabel: 'mean', xs: radii, ys: prof };
  };

  Plots.prototype._title = function (s) { if (this.els.title) this.els.title.textContent = s; };

  global.Plots = Plots;
})(window);
