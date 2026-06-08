/* panels.js — DS9-style side panels: panner, magnifier, pixel table, colorbar.
 *
 * All panels are read-only views of viewer state:
 *   - panner / colorbar update on viewer.onChange (view or colormap changed)
 *   - magnifier / pixel table update on cursor movement (driven from main.js)
 *
 * The viewer keeps a full-resolution, colormapped offscreen canvas (viewer.off)
 * with row 0 at the TOP (image y flipped), which the panner and magnifier blit.
 */
(function (global) {
  'use strict';

  function Panels(viewer, els) {
    this.v = viewer;
    this.els = els;
    this._pannerFit = null;
    this._bindPanner();
  }

  Panels.prototype.updateView = function () {
    this.drawPanner();
    this.drawColorbar();
  };

  // ---- panner: whole image + current viewport rectangle ----
  Panels.prototype.drawPanner = function () {
    const cv = this.els.panner, v = this.v;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (!v.image) { this._pannerFit = null; return; }
    const iw = v.image.width, ih = v.image.height;
    const s = Math.min(W / iw, H / ih);
    const fw = iw * s, fh = ih * s;
    const fx = (W - fw) / 2, fy = (H - fh) / 2;
    this._pannerFit = { fx, fy, fw, fh, iw, ih };

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(v.off, 0, 0, iw, ih, fx, fy, fw, fh);

    // viewport rectangle (visible image region)
    const cw = v.canvas.clientWidth, ch = v.canvas.clientHeight;
    const a = v.screenToImage(0, 0), b = v.screenToImage(cw, ch);
    const toX = ix => fx + Math.max(0, Math.min(1, ix / iw)) * fw;
    const toY = iy => fy + Math.max(0, Math.min(1, 1 - iy / ih)) * fh;
    const x0 = toX(a.ix), x1 = toX(b.ix), y0 = toY(a.iy), y1 = toY(b.iy);
    ctx.strokeStyle = '#4c8dff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(Math.min(x0,x1), Math.min(y0,y1), Math.abs(x1-x0), Math.abs(y1-y0));
  };

  Panels.prototype._bindPanner = function () {
    const cv = this.els.panner;
    if (!cv) return;
    const recenter = (e) => {
      const f = this._pannerFit, v = this.v;
      if (!f || !v.image) return;
      const r = cv.getBoundingClientRect();
      const px = (e.clientX - r.left) * (cv.width / r.width);
      const py = (e.clientY - r.top) * (cv.height / r.height);
      v.cx = ((px - f.fx) / f.fw) * f.iw;
      v.cy = (1 - (py - f.fy) / f.fh) * f.ih;
      v.draw();
    };
    let down = false;
    cv.addEventListener('mousedown', e => { down = true; recenter(e); });
    window.addEventListener('mousemove', e => { if (down) recenter(e); });
    window.addEventListener('mouseup', () => { down = false; });
  };

  // ---- magnifier: zoomed crop around the cursor ----
  Panels.prototype.MAG = 8;
  Panels.prototype.drawMagnifier = function (info) {
    const cv = this.els.magnifier, v = this.v;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (!v.image || !info || !info.inside) return;
    const mag = this.MAG;
    const srcW = W / mag, srcH = H / mag;
    const offRow = (v.image.height - 1 - info.iy);   // off canvas is y-flipped
    const sx = info.ix - srcW / 2, sy = offRow - srcH / 2;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(v.off, sx, sy, srcW, srcH, 0, 0, W, H);
    // crosshair
    ctx.strokeStyle = 'rgba(76,141,255,.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W/2, 0); ctx.lineTo(W/2, H);
    ctx.moveTo(0, H/2); ctx.lineTo(W, H/2);
    ctx.stroke();
  };

  // ---- pixel table: NxN values around the cursor ----
  Panels.prototype.N = 7;
  Panels.prototype.drawPixelTable = function (info) {
    const tbl = this.els.pixtable, v = this.v;
    if (!tbl) return;
    if (!v.image || !info || !info.inside) { tbl.innerHTML = ''; return; }
    const n = this.N, half = (n - 1) >> 1;
    const { width: w, height: h, data } = v.image;
    const cc = info.col, cr = info.row;
    let html = '';
    // rows top (cr+half) down to (cr-half) so y increases upward like the image
    for (let dr = half; dr >= -half; dr--) {
      html += '<tr>';
      for (let dc = -half; dc <= half; dc++) {
        const c = cc + dc, r = cr + dr;
        let txt = '', cls = '';
        if (c >= 0 && c < w && r >= 0 && r < h) {
          const val = data[r * w + c];
          txt = Number.isFinite(val) ? fmtShort(val) : 'NaN';
          if (dc === 0 && dr === 0) cls = 'ctr';
        }
        html += `<td class="${cls}">${txt}</td>`;
      }
      html += '</tr>';
    }
    tbl.innerHTML = html;
  };

  function fmtShort(v) {
    const a = Math.abs(v);
    if (v === 0) return '0';
    if (a >= 1e4 || a < 1e-2) return v.toExponential(1);
    return (Math.round(v * 100) / 100).toString();
  }

  // ---- colorbar: gradient reflecting cmap / invert / contrast / bias ----
  Panels.prototype.drawColorbar = function () {
    const cv = this.els.colorbar, v = this.v;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const lut = global.Colormap.build(v.cmap, v.invert);
    const img = ctx.createImageData(W, H);
    const px = img.data;
    for (let x = 0; x < W; x++) {
      let t = (x / (W - 1) - v.bias) * v.contrast + 0.5;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const idx = (t * 255 + 0.5) | 0;
      const r = lut[idx*3], g = lut[idx*3+1], b = lut[idx*3+2];
      for (let y = 0; y < H; y++) {
        const o = (y * W + x) * 4;
        px[o] = r; px[o+1] = g; px[o+2] = b; px[o+3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (this.els.cbLow)  this.els.cbLow.textContent = fmtShort(v.low);
    if (this.els.cbHigh) this.els.cbHigh.textContent = fmtShort(v.high);
  };

  global.Panels = Panels;
})(window);
