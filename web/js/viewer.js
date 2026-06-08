/* viewer.js — canvas image viewer: colormap render, zoom/pan, contrast/bias.
 *
 * Pipeline:
 *   image (Float64) --limits+transfer--> 8-bit index --colormap LUT--> RGBA
 * The RGBA is drawn once to an offscreen canvas at native resolution; the
 * visible canvas just blits it with a pan/zoom transform (nearest-neighbour),
 * so panning/zooming is cheap and only colormap changes trigger a re-render.
 *
 * Coordinate note: FITS pixel (1,1) is the bottom-left and y increases upward.
 * The offscreen canvas stores row 0 at the TOP, so we flip vertically while
 * writing pixels; screen<->image mapping accounts for that flip.
 */
(function (global) {
  'use strict';

  class Viewer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.off = document.createElement('canvas');
      this.offCtx = this.off.getContext('2d');

      this.image = null;          // { data, width, height, min, max }
      this.wcs = null;            // pixToSky function or null

      this.scale = 'linear';
      this.limitMode = 'zscale';
      this.cmap = 'grey';
      this.invert = false;
      this.low = 0;
      this.high = 1;

      this.contrast = 1;          // DS9-style colormap contrast (>0)
      this.bias = 0.5;            // DS9-style colormap bias [0,1]
      this.lockScale = true;      // keep low/high fixed when stepping cube slices

      this.zoom = 1;              // screen pixels per image pixel
      this.cx = 0;               // image coord at canvas centre
      this.cy = 0;

      this.onReadout = null;      // callback(info) for status bar
      this.onChange = null;       // callback() after view/colormap changes (panels)
      this.overlay = null;        // function(ctx) painted on top of the image
      this.pointerHook = null;    // {down,move,up} — consumes events before pan
      this._raf = null;

      this._bindInteraction();
      this._resizeObserver();
    }

    setImage(image, wcs) {
      this.image = image;
      this.wcs = wcs || null;
      this.off.width = image.width;
      this.off.height = image.height;
      this.contrast = 1;
      this.bias = 0.5;
      this.recomputeLimits();
      this.zoomFit();
      this.renderImage();
      this.draw();
    }

    // Swap to another cube slice without resetting the view; limits stay fixed
    // when lockScale is on (so a spectral line appears/disappears naturally).
    setPlane(image) {
      this.image = image;
      this.off.width = image.width;
      this.off.height = image.height;
      if (!this.lockScale) this.recomputeLimits();
      this.renderImage();
      this.draw();
    }

    recomputeLimits() {
      if (!this.image) return;
      const [lo, hi] = global.Scale.limits(
        this.limitMode, this.image.data, this.image.min, this.image.max);
      this.low = lo;
      this.high = hi > lo ? hi : lo + 1;
    }

    // Render full-resolution colormapped image to the offscreen canvas.
    renderImage() {
      if (!this.image) return;
      const { data, width, height } = this.image;
      const lut = global.Colormap.build(this.cmap, this.invert);
      const transfer = global.Scale.makeTransfer(this.scale, this.image, this.low, this.high);
      const lo = this.low, span = (this.high - this.low) || 1;
      const contrast = this.contrast, bias = this.bias;

      const img = this.offCtx.createImageData(width, height);
      const px = img.data;
      // background (NaN) colour: transparent so checker shows through
      for (let r = 0; r < height; r++) {
        const srcRow = r * width;
        const dstRow = (height - 1 - r) * width; // vertical flip
        for (let c = 0; c < width; c++) {
          const v = data[srcRow + c];
          const o = (dstRow + c) * 4;
          if (!Number.isFinite(v)) { px[o+3] = 0; continue; }
          let u = (v - lo) / span;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          u = transfer(u);
          // apply contrast/bias on the colormap index
          let t = (u - bias) * contrast + 0.5;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const idx = (t * 255 + 0.5) | 0;
          px[o]   = lut[idx*3];
          px[o+1] = lut[idx*3+1];
          px[o+2] = lut[idx*3+2];
          px[o+3] = 255;
        }
      }
      this.offCtx.putImageData(img, 0, 0);
    }

    // ----- view transform -----
    zoomFit() {
      if (!this.image) return;
      const { clientWidth: cw, clientHeight: ch } = this.canvas;
      const z = Math.min(cw / this.image.width, ch / this.image.height);
      this.zoom = z > 0 ? z : 1;
      this.cx = this.image.width / 2;
      this.cy = this.image.height / 2;
    }

    setZoom(factor, anchorScreen) {
      if (!this.image) return;
      const a = anchorScreen || { x: this.canvas.clientWidth/2, y: this.canvas.clientHeight/2 };
      const before = this.screenToImage(a.x, a.y);
      this.zoom = Math.max(0.02, Math.min(200, this.zoom * factor));
      const after = this.screenToImage(a.x, a.y);
      // keep the anchor pixel stationary
      this.cx += before.ix - after.ix;
      this.cy += before.iy - after.iy;
      this.draw();
    }

    zoomTo(z) { if (this.image) { this.zoom = z; this.draw(); } }

    // screen(css px) -> image pixel (0-based, y up). Returns floats.
    screenToImage(sx, sy) {
      const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
      const dx = (sx - cw / 2) / this.zoom;
      const dy = (sy - ch / 2) / this.zoom;
      return { ix: this.cx + dx, iy: this.cy - dy };
    }

    // image pixel (0-based, y up) -> screen(css px). Inverse of screenToImage.
    imageToScreen(ix, iy) {
      const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
      return { sx: (ix - this.cx) * this.zoom + cw / 2,
               sy: ch / 2 + (this.cy - iy) * this.zoom };
    }

    draw() {
      const dpr = window.devicePixelRatio || 1;
      const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
      if (this.canvas.width !== cw * dpr || this.canvas.height !== ch * dpr) {
        this.canvas.width = cw * dpr;
        this.canvas.height = ch * dpr;
      }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      if (!this.image) return;

      ctx.imageSmoothingEnabled = false;
      const z = this.zoom;
      const w = this.image.width, h = this.image.height;
      // canvas-space top-left of the image
      const left = cw / 2 - this.cx * z;
      const top = ch / 2 - (h - this.cy) * z;
      ctx.drawImage(this.off, 0, 0, w, h, left, top, w * z, h * z);

      if (this.overlay) this.overlay(ctx);
      if (this.onChange) this.onChange();
    }

    // ----- interaction -----
    _bindInteraction() {
      const c = this.canvas;
      let dragging = null;     // 'pan' | 'cb' | 'hook'
      let last = null;
      const hook = () => this.pointerHook;

      c.addEventListener('mousedown', (e) => {
        const rect = c.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        last = { x: e.clientX, y: e.clientY };
        if (hook() && hook().down && hook().down(sx, sy, e)) {
          dragging = 'hook'; e.preventDefault(); return;
        }
        dragging = (e.button === 2 || e.shiftKey) ? 'cb' : 'pan';
        e.preventDefault();
      });
      window.addEventListener('mouseup', (e) => {
        if (dragging === 'hook' && hook() && hook().up) hook().up(e);
        dragging = null; last = null;
      });

      c.addEventListener('mousemove', (e) => {
        const rect = c.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        if (dragging === 'hook') {
          if (hook() && hook().move) hook().move(sx, sy, e, true);
        } else if (dragging && last) {
          const dx = e.clientX - last.x, dy = e.clientY - last.y;
          last = { x: e.clientX, y: e.clientY };
          if (dragging === 'pan') {
            this.cx -= dx / this.zoom;
            this.cy += dy / this.zoom;
            this.draw();
          } else { // contrast/bias like DS9: horizontal=bias, vertical=contrast
            this.bias = Math.min(1, Math.max(0, this.bias + dx / 400));
            this.contrast = Math.min(10, Math.max(0.05, this.contrast * Math.exp(-dy / 200)));
            this.renderImage();
            this.draw();
          }
        } else if (hook() && hook().move) {
          hook().move(sx, sy, e, false);    // hover (cursor feedback)
        }
        this._emitReadout(sx, sy);
      });

      c.addEventListener('mouseleave', () => { if (this.onReadout) this.onReadout(null); });
      c.addEventListener('contextmenu', (e) => e.preventDefault());

      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        this.setZoom(e.deltaY < 0 ? 1.15 : 1/1.15, anchor);
      }, { passive: false });
    }

    _emitReadout(sx, sy) {
      if (!this.onReadout || !this.image) return;
      const { ix, iy } = this.screenToImage(sx, sy);
      const col = Math.floor(ix), row = Math.floor(iy);
      let value = null;
      if (col >= 0 && col < this.image.width && row >= 0 && row < this.image.height) {
        value = this.image.data[row * this.image.width + col];
      }
      // FITS pixel coords are 1-based, centre of first pixel = (1,1)
      const fx = ix + 0.5, fy = iy + 0.5;
      let sky = null;
      if (this.wcs && value !== null) {
        try { sky = this.wcs(fx, fy); } catch (_) { sky = null; }
      }
      this.onReadout({
        x: value === null ? null : fx,
        y: value === null ? null : fy,
        value, sky,
        ix, iy, col, row,            // 0-based image coords (for panels)
        inside: value !== null,
      });
    }

    _resizeObserver() {
      const ro = new ResizeObserver(() => {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => { this._raf = null; this.draw(); });
      });
      ro.observe(this.canvas);
    }
  }

  global.Viewer = Viewer;
})(window);
