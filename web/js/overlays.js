/* overlays.js — DS9-style overlays: contours, coordinate grid, crosshair.
 *
 * Contours and grid are computed with marching squares:
 *   - contour: iso-intensity lines of the image data
 *   - grid: iso-RA and iso-Dec lines of the WCS sky fields RA(x,y), Dec(x,y)
 * Geometry is produced in image coords and mapped to screen via the viewer, so
 * overlays stay locked to pixels under zoom/pan. Contour/grid segments are
 * cached and only recomputed when the image or parameters change.
 */
(function (global) {
  'use strict';

  // Marching squares over an nx*ny lattice. sample(gx,gy)->value (may be NaN).
  // Returns flat segments [x1,y1,x2,y2,...] in lattice coordinates.
  function isoSegments(nx, ny, sample, level) {
    const segs = [];
    const interp = (va, vb, xa, ya, xb, yb) => {
      const t = (level - va) / (vb - va);
      return [xa + (xb - xa) * t, ya + (yb - ya) * t];
    };
    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const v0 = sample(x, y), v1 = sample(x+1, y), v2 = sample(x+1, y+1), v3 = sample(x, y+1);
        if (!(Number.isFinite(v0) && Number.isFinite(v1) && Number.isFinite(v2) && Number.isFinite(v3))) continue;
        let idx = 0;
        if (v0 > level) idx |= 1;
        if (v1 > level) idx |= 2;
        if (v2 > level) idx |= 4;
        if (v3 > level) idx |= 8;
        if (idx === 0 || idx === 15) continue;
        const top = () => interp(v0, v1, x, y, x+1, y);
        const right = () => interp(v1, v2, x+1, y, x+1, y+1);
        const bottom = () => interp(v3, v2, x, y+1, x+1, y+1);
        const left = () => interp(v0, v3, x, y, x, y+1);
        const push = (a, b) => segs.push(a[0], a[1], b[0], b[1]);
        switch (idx) {
          case 1: case 14: push(left(), top()); break;
          case 2: case 13: push(top(), right()); break;
          case 3: case 12: push(left(), right()); break;
          case 4: case 11: push(right(), bottom()); break;
          case 6: case 9:  push(top(), bottom()); break;
          case 7: case 8:  push(left(), bottom()); break;
          case 5:  push(left(), top()); push(right(), bottom()); break;
          case 10: push(top(), right()); push(left(), bottom()); break;
        }
      }
    }
    return segs;
  }

  function niceStep(range, target) {
    const raw = range / target;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }

  function Overlays(viewer) {
    this.v = viewer;
    this.contour = { on: false, levels: 5, color: '#46d063', segs: null, stride: 1 };
    this.grid = { on: false, color: '#6f9bd6', lines: null };
    this.cross = { on: false, ix: null, iy: null };
  }

  Overlays.prototype.invalidate = function () {
    this.contour.segs = null;
    this.grid.lines = null;
  };

  Overlays.prototype.setCursor = function (ix, iy) {
    if (!this.cross.on) return;
    this.cross.ix = ix; this.cross.iy = iy;
    this.v.draw();
  };

  // ---- contour ----
  Overlays.prototype._buildContour = function () {
    const v = this.v, img = v.image;
    if (!img || !img.data) { this.contour.segs = []; return; }
    const w = img.width, h = img.height;
    const stride = Math.max(1, Math.floor(Math.max(w, h) / 400));   // cap lattice ~400
    const nx = Math.floor(w / stride), ny = Math.floor(h / stride);
    const data = img.data;
    const sample = (gx, gy) => data[(gy * stride) * w + gx * stride];
    const lo = v.low, hi = v.high, n = this.contour.levels;
    const levels = [];
    for (let i = 1; i <= n; i++) levels.push(lo + (hi - lo) * i / (n + 1));
    const all = [];
    for (const lv of levels) {
      const s = isoSegments(nx, ny, sample, lv);
      for (let i = 0; i < s.length; i += 4)
        all.push(s[i] * stride, s[i+1] * stride, s[i+2] * stride, s[i+3] * stride);
    }
    this.contour.segs = all;
    this.contour.stride = stride;
  };

  // ---- coordinate grid (needs WCS pix->sky) ----
  Overlays.prototype._buildGrid = function () {
    const v = this.v;
    this.grid.lines = [];
    if (!v.wcs) return;
    const w = v.image.width, h = v.image.height;
    const N = 60;                          // coarse lattice for the sky fields
    const ra = new Float64Array(N * N), dec = new Float64Array(N * N);
    let raMin = Infinity, raMax = -Infinity, decMin = Infinity, decMax = -Infinity;
    for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
      const ix = gx / (N - 1) * w, iy = gy / (N - 1) * h;
      const s = v.wcs(ix + 0.5, iy + 0.5);
      ra[gy*N+gx] = s.ra; dec[gy*N+gx] = s.dec;
      if (s.ra < raMin) raMin = s.ra; if (s.ra > raMax) raMax = s.ra;
      if (s.dec < decMin) decMin = s.dec; if (s.dec > decMax) decMax = s.dec;
    }
    if (raMax - raMin > 180) return;        // RA wrap — skip for MVP
    const toImg = (gx, gy) => [gx / (N - 1) * w, gy / (N - 1) * h];
    const addLines = (field, lo, hi, color) => {
      const step = niceStep(hi - lo, 6);
      for (let lv = Math.ceil(lo / step) * step; lv <= hi; lv += step) {
        const s = isoSegments(N, N, (gx, gy) => field[gy*N+gx], lv);
        const seg = [];
        for (let i = 0; i < s.length; i += 4) {
          const a = toImg(s[i], s[i+1]), b = toImg(s[i+2], s[i+3]);
          seg.push(a[0], a[1], b[0], b[1]);
        }
        this.grid.lines.push({ value: lv, segs: seg });
      }
    };
    addLines(ra, raMin, raMax);
    addLines(dec, decMin, decMax);
  };

  // ---- draw ---- (fields under regions, crosshair on top) ----
  Overlays.prototype.drawFields = function (ctx) {
    if (!this.v.image) return;
    if (this.grid.on) this._drawGrid(ctx);
    if (this.contour.on) this._drawContour(ctx);
  };
  Overlays.prototype.drawCrosshair = function (ctx) {
    if (this.v.image && this.cross.on) this._drawCross(ctx);
  };

  Overlays.prototype._drawSegs = function (ctx, segs) {
    const v = this.v;
    ctx.beginPath();
    for (let i = 0; i < segs.length; i += 4) {
      const a = v.imageToScreen(segs[i], segs[i+1]);
      const b = v.imageToScreen(segs[i+2], segs[i+3]);
      ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy);
    }
    ctx.stroke();
  };

  Overlays.prototype._drawContour = function (ctx) {
    if (!this.contour.segs) this._buildContour();
    ctx.save();
    ctx.strokeStyle = this.contour.color;
    ctx.lineWidth = 1;
    this._drawSegs(ctx, this.contour.segs);
    ctx.restore();
  };

  Overlays.prototype._drawGrid = function (ctx) {
    if (!this.grid.lines) this._buildGrid();
    ctx.save();
    ctx.strokeStyle = this.grid.color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    for (const ln of this.grid.lines) this._drawSegs(ctx, ln.segs);
    ctx.restore();
  };

  Overlays.prototype._drawCross = function (ctx) {
    if (this.cross.ix == null) return;
    const v = this.v;
    const c = v.imageToScreen(this.cross.ix, this.cross.iy);
    ctx.save();
    ctx.strokeStyle = '#ffd24c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c.sx, 0); ctx.lineTo(c.sx, v.canvas.clientHeight);
    ctx.moveTo(0, c.sy); ctx.lineTo(v.canvas.clientWidth, c.sy);
    ctx.stroke();
    ctx.restore();
  };

  global.Overlays = Overlays;
})(window);
