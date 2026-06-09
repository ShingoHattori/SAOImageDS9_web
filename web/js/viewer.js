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

  // Colormap an image into a canvas at native resolution (row 0 at the top,
  // i.e. image y flipped). Shared by the single view and the tile renderer.
  global.renderColormap = function (canvas, image, p) {
    const { data, width, height } = image;
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const lut = global.Colormap.build(p.cmap, p.invert);
    const transfer = global.Scale.makeTransfer(p.scale, image, p.low, p.high);
    const lo = p.low, span = (p.high - p.low) || 1;
    const contrast = p.contrast, bias = p.bias;
    const img = ctx.createImageData(width, height);
    const px = img.data;
    for (let r = 0; r < height; r++) {
      const srcRow = r * width;
      const dstRow = (height - 1 - r) * width;   // vertical flip
      for (let c = 0; c < width; c++) {
        const v = data[srcRow + c];
        const o = (dstRow + c) * 4;
        if (!Number.isFinite(v)) { px[o+3] = 0; continue; }
        let u = (v - lo) / span;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        u = transfer(u);
        let t = (u - bias) * contrast + 0.5;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const idx = (t * 255 + 0.5) | 0;
        px[o] = lut[idx*3]; px[o+1] = lut[idx*3+1]; px[o+2] = lut[idx*3+2]; px[o+3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  class Viewer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.off = document.createElement('canvas');
      this.offCtx = this.off.getContext('2d');

      this.raw = null;            // raw image as read from FITS
      this.image = null;          // displayed image (raw, or smoothed/binned)
      this.wcs = null;            // pixToSky function or null
      this.smooth = { on: false, type: 'gaussian', radius: 2 };
      this.binFactor = 1;
      this.orient = { rot: 0, flipX: false, flipY: false };   // rot: 0/90/180/270 CCW
      this.mode = 'image';        // 'image' | 'rgb' | '3d'
      this.rgb = null;            // { red:{image,low,high}, green:{...}, blue:{...} }
      this.vol = null;            // 3D volume { data, w, h, d, min, max }
      this.view3d = { yaw: 0.6, pitch: 0.5, method: 'mip' };

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
      this.tileMode = false;      // grid display of all frames
      this.tiles = [];            // [{canvas,label,active}] for tile mode
      this.onTileClick = null;    // callback(index) when a tile is clicked
      this._tileLayout = null;
      this._raf = null;

      this._bindInteraction();
      this._resizeObserver();
    }

    // Apply binning then smoothing to the raw image (image-domain processing).
    _process(img) {
      let out = img;
      if (this.binFactor > 1) out = global.Smooth.bin(out, this.binFactor);
      if (this.smooth.on) out = this.smooth.type === 'boxcar'
        ? global.Smooth.boxcar(out, this.smooth.radius)
        : global.Smooth.gaussian(out, this.smooth.radius);
      return out;
    }
    _applySource(rawImg) {
      this.raw = rawImg;
      this.image = this._process(rawImg);
      this.off.width = this.image.width;
      this.off.height = this.image.height;
    }
    // Rebuild the displayed image after smooth/bin settings change.
    reprocess() {
      if (!this.raw) return;
      this.image = this._process(this.raw);
      this.off.width = this.image.width;
      this.off.height = this.image.height;
      if (this.limitMode !== 'user') this.recomputeLimits();
      this.renderImage();
      this.draw();
    }

    setImage(image, wcs) {
      this.wcs = wcs || null;
      this._applySource(image);
      this.contrast = 1;
      this.bias = 0.5;
      this.recomputeLimits();
      this.zoomFit();
      this.renderImage();
      this.draw();
    }

    // Restore a saved frame state (view + scale) onto a (new) image, without
    // the zoomFit / limit recompute that setImage does.
    restore(image, wcs, st) {
      this.wcs = wcs || null;
      this.scale = st.scale; this.limitMode = st.limitMode;
      this.cmap = st.cmap; this.invert = st.invert;
      this.low = st.low; this.high = st.high;
      this.contrast = st.contrast; this.bias = st.bias;
      this.lockScale = st.lockScale;
      this._applySource(image);
      this.zoom = st.zoom; this.cx = st.cx; this.cy = st.cy;
      this.renderImage();
      this.draw();
    }

    // Swap the image keeping the current view + scale (for cross-frame lock).
    swapImage(image, wcs) {
      this.wcs = wcs || null;
      this._applySource(image);
      this.renderImage();
      this.draw();
    }

    // Swap to another cube slice without resetting the view; limits stay fixed
    // when lockScale is on (so a spectral line appears/disappears naturally).
    setPlane(image) {
      this._applySource(image);
      if (!this.lockScale) this.recomputeLimits();
      this.renderImage();
      this.draw();
    }

    recomputeLimits() {
      if (!this.image) return;
      const src = this.mode === '3d' ? this.vol : this.image;
      if (!src || !src.data) return;
      const [lo, hi] = global.Scale.limits(this.limitMode, src.data, src.min, src.max);
      this.low = lo;
      this.high = hi > lo ? hi : lo + 1;
    }

    // Render full-resolution image to the offscreen canvas (dispatch by mode).
    renderImage() {
      if (this.mode === 'rgb') return this._renderRGB();
      if (this.mode === '3d') return this._render3D();
      if (!this.image) return;
      global.renderColormap(this.off, this.image, {
        scale: this.scale, low: this.low, high: this.high,
        cmap: this.cmap, invert: this.invert, contrast: this.contrast, bias: this.bias });
    }

    // ---- RGB composite: each channel grayscale-mapped to its colour ----
    setRGB(channels, wcs) {
      this.mode = 'rgb';
      this.rgb = channels;
      this.wcs = wcs || null;
      const ref = (channels.red || channels.green || channels.blue).image;
      this.raw = ref; this.image = ref;       // reference for dims / readout
      this.off.width = ref.width; this.off.height = ref.height;
      this.contrast = 1; this.bias = 0.5;
      this._renderRGB();
      this.zoomFit();
      this.draw();
    }
    _renderRGB() {
      const ref = this.image, w = ref.width, h = ref.height;
      this.off.width = w; this.off.height = h;
      const ctx = this.off.getContext('2d');
      const out = ctx.createImageData(w, h);
      const px = out.data;
      const prep = (c) => {
        if (!c || !c.image || c.image.width !== w || c.image.height !== h) return null;
        return { data: c.image.data, lo: c.low, span: (c.high - c.low) || 1,
                 tf: global.Scale.makeTransfer(this.scale, c.image, c.low, c.high) };
      };
      const R = prep(this.rgb.red), G = prep(this.rgb.green), B = prep(this.rgb.blue);
      const ch = (C, i) => {
        if (!C) return 0;
        const v = C.data[i];
        if (!Number.isFinite(v)) return 0;
        let u = (v - C.lo) / C.span; u = u < 0 ? 0 : u > 1 ? 1 : u;
        return (C.tf(u) * 255 + 0.5) | 0;
      };
      for (let r = 0; r < h; r++) {
        const src = r * w, dst = (h - 1 - r) * w;
        for (let c = 0; c < w; c++) {
          const i = src + c, o = (dst + c) * 4;
          px[o] = ch(R, i); px[o+1] = ch(G, i); px[o+2] = ch(B, i); px[o+3] = 255;
        }
      }
      ctx.putImageData(out, 0, 0);
    }

    // ---- 3D: maximum-intensity-projection of a volume, drag to rotate ----
    setVolume(vol, wcs) {
      this.mode = '3d';
      this.vol = vol;
      this.wcs = null;                          // projection has no sky WCS
      const S = Math.ceil(Math.sqrt(vol.w*vol.w + vol.h*vol.h + vol.d*vol.d));
      this.image = { width: S, height: S, data: null, min: vol.min, max: vol.max };
      this.off.width = S; this.off.height = S;
      this.contrast = 1; this.bias = 0.5;
      const [lo, hi] = global.Scale.limits('99.5', vol.data, vol.min, vol.max);
      this.low = lo; this.high = hi;
      this._render3D();
      this.zoomFit();
      this.draw();
    }
    _render3D() {
      if (!this.vol) return;
      const { data, w, h, d } = this.vol;
      const S = this.off.width;
      const method = this.view3d.method || 'mip';
      const proj = new Float32Array(S * S).fill(method === 'mip' ? -Infinity : 0);
      const cnt = method === 'mean' ? new Int32Array(S * S) : null;
      const { yaw, pitch } = this.view3d;
      const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
      const cpit = Math.cos(pitch), spit = Math.sin(pitch);
      const cx0 = w / 2, cy0 = h / 2, cz0 = d / 2, c = S / 2;
      for (let z = 0; z < d; z++) {
        const Zc = z - cz0;
        for (let y = 0; y < h; y++) {
          const Yc = y - cy0, base = (z * h + y) * w;
          for (let x = 0; x < w; x++) {
            const v = data[base + x];
            if (!Number.isFinite(v)) continue;
            const Xc = x - cx0;
            const X1 = cyaw * Xc + syaw * Zc;        // yaw about Y
            const Z1 = -syaw * Xc + cyaw * Zc;
            const Y2 = cpit * Yc - spit * Z1;        // pitch about X (then project)
            const px = (c + X1) | 0, py = (c - Y2) | 0;
            if (px < 0 || px >= S || py < 0 || py >= S) continue;
            const idx = py * S + px;
            if (method === 'mip') { if (v > proj[idx]) proj[idx] = v; }
            else { proj[idx] += v; if (cnt) cnt[idx]++; }
          }
        }
      }
      if (method === 'mip') { for (let i = 0; i < proj.length; i++) if (proj[i] === -Infinity) proj[i] = NaN; }
      else if (method === 'mean') { for (let i = 0; i < proj.length; i++) proj[i] = cnt[i] ? proj[i] / cnt[i] : NaN; }
      else { for (let i = 0; i < proj.length; i++) if (proj[i] === 0) proj[i] = NaN; }
      const ctx = this.off.getContext('2d');
      const lut = global.Colormap.build(this.cmap, this.invert);
      const tf = global.Scale.makeTransfer(this.scale, { data: proj }, this.low, this.high);
      const lo = this.low, span = (this.high - this.low) || 1;
      const out = ctx.createImageData(S, S), px = out.data;
      for (let i = 0; i < S * S; i++) {
        const v = proj[i], o = i * 4;
        if (!Number.isFinite(v)) { px[o+3] = 0; continue; }
        let u = (v - lo) / span; u = u < 0 ? 0 : u > 1 ? 1 : u; u = tf(u);
        let t = (u - this.bias) * this.contrast + 0.5; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const k = (t * 255 + 0.5) | 0;
        px[o] = lut[k*3]; px[o+1] = lut[k*3+1]; px[o+2] = lut[k*3+2]; px[o+3] = 255;
      }
      ctx.putImageData(out, 0, 0);
    }
    rotate3D(dx, dy) {
      this.view3d.yaw += dx * 0.01;
      this.view3d.pitch = Math.max(-1.5, Math.min(1.5, this.view3d.pitch + dy * 0.01));
      this._render3D();
      this.draw();
    }

    // ----- view transform -----
    zoomFit() {
      if (!this.image) return;
      const { clientWidth: cw, clientHeight: ch } = this.canvas;
      const { W, H } = this.viewDims();
      const z = Math.min(cw / W, ch / H);
      this.zoom = z > 0 ? z : 1;
      this.cx = W / 2;
      this.cy = H / 2;
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

    // Oriented "view" dimensions (swap for 90/270 rotation).
    viewDims() {
      const w = this.image ? this.image.width : 1, h = this.image ? this.image.height : 1;
      return (this.orient.rot === 90 || this.orient.rot === 270) ? { W: h, H: w } : { W: w, H: h };
    }
    // image coords (ix,iy, y up) -> oriented view coords (vx,vy, y up).
    _orient(ix, iy) {
      const w = this.image.width, h = this.image.height;
      let u = ix - w / 2, v = iy - h / 2;
      if (this.orient.flipX) u = -u;
      if (this.orient.flipY) v = -v;
      let u2, v2;
      switch (this.orient.rot) {
        case 90:  u2 = -v; v2 = u; break;
        case 180: u2 = -u; v2 = -v; break;
        case 270: u2 = v; v2 = -u; break;
        default:  u2 = u; v2 = v;
      }
      const { W, H } = this.viewDims();
      return { vx: u2 + W / 2, vy: v2 + H / 2 };
    }
    _unorient(vx, vy) {
      const w = this.image.width, h = this.image.height;
      const { W, H } = this.viewDims();
      let u2 = vx - W / 2, v2 = vy - H / 2, u, v;
      switch (this.orient.rot) {
        case 90:  u = v2; v = -u2; break;
        case 180: u = -u2; v = -v2; break;
        case 270: u = -v2; v = u2; break;
        default:  u = u2; v = v2;
      }
      if (this.orient.flipX) u = -u;
      if (this.orient.flipY) v = -v;
      return { ix: u + w / 2, iy: v + h / 2 };
    }

    // screen(css px) -> image pixel (0-based, y up). Returns floats.
    screenToImage(sx, sy) {
      const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
      const vx = this.cx + (sx - cw / 2) / this.zoom;
      const vy = this.cy - (sy - ch / 2) / this.zoom;
      return this._unorient(vx, vy);
    }

    // image pixel (0-based, y up) -> screen(css px). Inverse of screenToImage.
    imageToScreen(ix, iy) {
      const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
      const { vx, vy } = this._orient(ix, iy);
      return { sx: (vx - this.cx) * this.zoom + cw / 2,
               sy: ch / 2 + (this.cy - vy) * this.zoom };
    }

    rotate90(dir) { this.orient.rot = (this.orient.rot + (dir < 0 ? 270 : 90)) % 360; this.zoomFit(); this.draw(); }
    flip(axis) { if (axis === 'x') this.orient.flipX = !this.orient.flipX; else this.orient.flipY = !this.orient.flipY; this.zoomFit(); this.draw(); }
    resetOrient() { this.orient = { rot: 0, flipX: false, flipY: false }; this.zoomFit(); this.draw(); }

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

      if (this.tileMode) { this._drawTiles(ctx, cw, ch); if (this.onChange) this.onChange(); return; }
      if (!this.image) return;

      ctx.imageSmoothingEnabled = false;
      const w = this.image.width, h = this.image.height;
      // Map the offscreen image (pixel (0,0)→image(0,h) … i.e. row 0 at top)
      // through the oriented image→screen transform via a corner-based affine,
      // so rotation/flip apply consistently with regions/overlays.
      const P00 = this.imageToScreen(0, h), P10 = this.imageToScreen(w, h), P01 = this.imageToScreen(0, 0);
      const ax = (P10.sx - P00.sx) / w, ay = (P10.sy - P00.sy) / w;
      const bx = (P01.sx - P00.sx) / h, by = (P01.sy - P00.sy) / h;
      ctx.setTransform(dpr*ax, dpr*ay, dpr*bx, dpr*by, dpr*P00.sx, dpr*P00.sy);
      ctx.drawImage(this.off, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // restore for overlays

      if (this.overlay) this.overlay(ctx);
      if (this.onChange) this.onChange();
    }

    _drawTiles(ctx, cw, ch) {
      const n = this.tiles.length;
      if (!n) return;
      const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
      const cwid = cw / cols, chgt = ch / rows;
      this._tileLayout = { cols, rows, cwid, chgt };
      ctx.imageSmoothingEnabled = false;
      ctx.textBaseline = 'top';
      for (let i = 0; i < n; i++) {
        const t = this.tiles[i];
        const ox = (i % cols) * cwid, oy = Math.floor(i / cols) * chgt;
        const pad = 4, aw = cwid - 2*pad, ah = chgt - 2*pad;
        const s = Math.min(aw / t.canvas.width, ah / t.canvas.height);
        const w = t.canvas.width * s, h = t.canvas.height * s;
        ctx.drawImage(t.canvas, 0, 0, t.canvas.width, t.canvas.height,
          ox + (cwid - w)/2, oy + (chgt - h)/2, w, h);
        ctx.strokeStyle = t.active ? '#4c8dff' : '#3a3e47';
        ctx.lineWidth = t.active ? 2 : 1;
        ctx.strokeRect(ox + 1, oy + 1, cwid - 2, chgt - 2);
        ctx.fillStyle = t.active ? '#4c8dff' : '#9aa0aa';
        ctx.font = '12px sans-serif';
        ctx.fillText(t.label, ox + 6, oy + 5);
      }
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
        if (this.tileMode) {
          const L = this._tileLayout;
          if (L && this.onTileClick) {
            const idx = Math.floor(sy / L.chgt) * L.cols + Math.floor(sx / L.cwid);
            if (idx >= 0 && idx < this.tiles.length) this.onTileClick(idx);
          }
          e.preventDefault(); return;
        }
        if (this.mode === '3d') { dragging = 'rot3d'; e.preventDefault(); return; }
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
        if (dragging === 'rot3d') {
          const dx = e.clientX - last.x, dy = e.clientY - last.y;
          last = { x: e.clientX, y: e.clientY };
          this.rotate3D(dx, dy);
        } else if (dragging === 'hook') {
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
      if (this.image.data && col >= 0 && col < this.image.width && row >= 0 && row < this.image.height) {
        value = this.image.data[row * this.image.width + col];
      }
      // FITS pixel coords are 1-based, centre of first pixel = (1,1)
      const fx = ix + 0.5, fy = iy + 0.5;
      let sky = null;
      if (this.wcs && value !== null) {
        // map displayed (possibly binned) pixel back to raw FITS coords for WCS
        const f = this.binFactor;
        const rfx = f > 1 ? (fx - 0.5) * f + 0.5 : fx;
        const rfy = f > 1 ? (fy - 0.5) * f + 0.5 : fy;
        try { sky = this.wcs(rfx, rfy); } catch (_) { sky = null; }
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
