/* regions.js — DS9-style region markers (the signature DS9 feature).
 *
 * Shapes: circle, ellipse, box, line, point, polygon.
 * Create (drag / click), select, move, resize, rotate, delete; a region list;
 * and DS9 region-format import/export in image coordinates.
 *
 * Geometry is stored in the viewer's image coordinates (ix,iy: 0-based, y up).
 * FITS/DS9 "image" coords are X = ix + 0.5, Y = iy + 0.5. Angles are radians,
 * CCW positive in image space (matches DS9's image-system angle). All drawing
 * and hit-testing map points through viewer.imageToScreen / screenToImage, so
 * regions stay locked to pixels under any zoom/pan.
 */
(function (global) {
  'use strict';

  const HANDLE_PX = 5;       // half-size of a square handle, screen px
  const HIT_PX = 6;          // pointer tolerance, screen px
  const ROT_PX = 22;         // rotation-handle offset, screen px
  const POINT_PX = 6;        // point marker radius, screen px

  let nextId = 1;

  function Regions(viewer, opts) {
    this.v = viewer;
    this.opts = opts || {};
    this.list = [];
    this.selected = null;
    this.tool = 'pointer';
    this.color = 'green';
    this._creating = null;     // region being created
    this._drag = null;         // { mode:'move'|'resize'|'rotate', handle, last }
    this._poly = null;         // polygon under construction
    // drawing is composed by main (overlay order: contour/grid/regions/crosshair)
    viewer.pointerHook = {
      down: (sx, sy, e) => this._down(sx, sy, e),
      move: (sx, sy, e, dragging) => this._move(sx, sy, e, dragging),
      up:   (e) => this._up(e),
    };
  }

  Regions.prototype.setTool = function (t) {
    this._finishPoly(false);
    this.tool = t;
    this.v.canvas.style.cursor = (t === 'pointer') ? 'crosshair' : 'copy';
  };

  Regions.prototype.notify = function () { if (this.opts.onChange) this.opts.onChange(); };

  Regions.prototype.add = function (r) {
    r.id = nextId++;
    if (!r.color) r.color = this.color;
    this.list.push(r);
    this.select(r);
    this.v.draw();
    this.notify();
    return r;
  };

  Regions.prototype.remove = function (r) {
    const i = this.list.indexOf(r);
    if (i >= 0) this.list.splice(i, 1);
    if (this.selected === r) this.selected = null;
    this.v.draw();
    this.notify();
  };

  Regions.prototype.clear = function () {
    this.list = []; this.selected = null; this._poly = null;
    this.v.draw(); this.notify();
  };

  Regions.prototype.select = function (r) {
    this.selected = r;
    this.v.draw();
    this.notify();
  };

  // ---- geometry helpers (image space) ----
  function rotate(px, py, cx, cy, ang) {
    const dx = px - cx, dy = py - cy, c = Math.cos(ang), s = Math.sin(ang);
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  }
  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx*dx + dy*dy;
    let t = l2 ? ((px-ax)*dx + (py-ay)*dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return dist(px, py, ax + t*dx, ay + t*dy);
  }

  // Boundary/handle points of a region in image coords.
  // Returns { outline:[{x,y}...], closed:bool, handles:[{name,x,y}], rot:{x,y}|null }
  function geometry(r) {
    if (r.type === 'circle') {
      const out = [];
      for (let i = 0; i <= 48; i++) { const a = i/48*2*Math.PI; out.push({ x: r.x + r.r*Math.cos(a), y: r.y + r.r*Math.sin(a) }); }
      return { outline: out, closed: true, handles: [{ name:'r', x: r.x + r.r, y: r.y }], rot: null };
    }
    if (r.type === 'ellipse' || r.type === 'box') {
      const out = [];
      if (r.type === 'ellipse') {
        for (let i = 0; i <= 60; i++) {
          const a = i/60*2*Math.PI;
          const p = rotate(r.x + r.a*Math.cos(a), r.y + r.b*Math.sin(a), r.x, r.y, r.angle);
          out.push(p);
        }
      } else {
        const hw = r.w/2, hh = r.h/2;
        [[ -hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].forEach(([dx,dy]) =>
          out.push(rotate(r.x+dx, r.y+dy, r.x, r.y, r.angle)));
      }
      const ax = r.type === 'ellipse' ? r.a : r.w/2;
      const by = r.type === 'ellipse' ? r.b : r.h/2;
      const hA = rotate(r.x + ax, r.y, r.x, r.y, r.angle);
      const hB = rotate(r.x, r.y + by, r.x, r.y, r.angle);
      return { outline: out, closed: true,
        handles: [{ name:'a', x:hA.x, y:hA.y }, { name:'b', x:hB.x, y:hB.y }],
        rotAxis: { x: ax, y: 0 } };
    }
    if (r.type === 'line') {
      return { outline: [{x:r.x1,y:r.y1},{x:r.x2,y:r.y2}], closed: false,
        handles: [{name:'p1',x:r.x1,y:r.y1},{name:'p2',x:r.x2,y:r.y2}], rot: null };
    }
    if (r.type === 'polygon') {
      return { outline: r.pts.slice(), closed: true,
        handles: r.pts.map((p,i) => ({ name:'v'+i, x:p.x, y:p.y })), rot: null };
    }
    // point
    return { outline: [{x:r.x,y:r.y}], closed: false, handles: [], rot: null, point: true };
  }

  function center(r) {
    if (r.type === 'line') return { x:(r.x1+r.x2)/2, y:(r.y1+r.y2)/2 };
    if (r.type === 'polygon') {
      let x=0,y=0; r.pts.forEach(p=>{x+=p.x;y+=p.y;}); return { x:x/r.pts.length, y:y/r.pts.length };
    }
    return { x:r.x, y:r.y };
  }

  // ---- drawing ----
  Regions.prototype.draw = function (ctx) {
    const v = this.v;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.font = '11px ui-monospace, Menlo, monospace';
    for (const r of this.list) this._drawRegion(ctx, r, r === this.selected);
    if (this._poly) this._drawDraftPoly(ctx, this._poly);
    ctx.restore();
  };

  Regions.prototype._drawRegion = function (ctx, r, sel) {
    const v = this.v;
    const g = geometry(r);
    const S = p => v.imageToScreen(p.x, p.y);
    ctx.strokeStyle = r.color;
    ctx.fillStyle = r.color;

    if (g.point) {
      const c = S(g.outline[0]);
      ctx.beginPath();
      ctx.moveTo(c.sx - POINT_PX, c.sy); ctx.lineTo(c.sx + POINT_PX, c.sy);
      ctx.moveTo(c.sx, c.sy - POINT_PX); ctx.lineTo(c.sx, c.sy + POINT_PX);
      ctx.stroke();
    } else {
      ctx.beginPath();
      g.outline.forEach((p, i) => { const s = S(p); i ? ctx.lineTo(s.sx, s.sy) : ctx.moveTo(s.sx, s.sy); });
      if (g.closed) ctx.closePath();
      ctx.stroke();
    }

    if (r.label) {
      const c = S(center(r));
      ctx.fillText(r.label, c.sx + 6, c.sy - 6);
    }

    if (sel) {
      // rotation handle for ellipse/box
      if (g.rotAxis) {
        const cc = center(r);
        const tip = rotate(r.x + g.rotAxis.x, r.y, r.x, r.y, r.angle);
        const t = S(tip), c = S(cc);
        const ux = t.sx - c.sx, uy = t.sy - c.sy, len = Math.hypot(ux, uy) || 1;
        const rx = t.sx + ux/len*ROT_PX, ry = t.sy + uy/len*ROT_PX;
        ctx.beginPath(); ctx.moveTo(t.sx, t.sy); ctx.lineTo(rx, ry); ctx.stroke();
        this._handle(ctx, rx, ry, true);
        r._rotScreen = { x: rx, y: ry };
      }
      for (const h of g.handles) { const s = S(h); this._handle(ctx, s.sx, s.sy, false); }
    }
  };

  Regions.prototype._handle = function (ctx, x, y, round) {
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#4c8dff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (round) ctx.arc(x, y, HANDLE_PX, 0, 2*Math.PI);
    else ctx.rect(x - HANDLE_PX, y - HANDLE_PX, HANDLE_PX*2, HANDLE_PX*2);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  };

  Regions.prototype._drawDraftPoly = function (ctx, poly) {
    const v = this.v;
    ctx.strokeStyle = this.color;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    poly.pts.concat(poly.preview ? [poly.preview] : []).forEach((p, i) => {
      const s = v.imageToScreen(p.x, p.y); i ? ctx.lineTo(s.sx, s.sy) : ctx.moveTo(s.sx, s.sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    poly.pts.forEach(p => { const s = v.imageToScreen(p.x, p.y); this._handle(ctx, s.sx, s.sy, false); });
  };

  // ---- hit testing (image space) ----
  Regions.prototype._hitHandle = function (r, ix, iy, tol) {
    const g = geometry(r);
    if (r._rotScreen && r === this.selected && g.rotAxis) {
      const rs = this.v.screenToImage(r._rotScreen.x, r._rotScreen.y);
      if (dist(ix, iy, rs.ix, rs.iy) <= tol) return { name: 'rot' };
    }
    for (const h of g.handles) if (dist(ix, iy, h.x, h.y) <= tol) return { name: h.name };
    return null;
  };

  Regions.prototype._hitBody = function (r, ix, iy, tol) {
    if (r.type === 'circle') return dist(ix, iy, r.x, r.y) <= r.r + tol;
    if (r.type === 'point') return dist(ix, iy, r.x, r.y) <= tol + POINT_PX/this.v.zoom;
    if (r.type === 'line') return segDist(ix, iy, r.x1, r.y1, r.x2, r.y2) <= tol;
    if (r.type === 'ellipse') {
      const p = rotate(ix, iy, r.x, r.y, -r.angle);
      const dx = (p.x - r.x)/r.a, dy = (p.y - r.y)/r.b;
      return dx*dx + dy*dy <= 1.1;
    }
    if (r.type === 'box') {
      const p = rotate(ix, iy, r.x, r.y, -r.angle);
      return Math.abs(p.x - r.x) <= r.w/2 + tol && Math.abs(p.y - r.y) <= r.h/2 + tol;
    }
    if (r.type === 'polygon') return pointInPoly(ix, iy, r.pts);
    return false;
  };

  function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  // ---- interaction ----
  Regions.prototype._down = function (sx, sy, e) {
    if (!this.v.image) return false;
    const p = this.v.screenToImage(sx, sy);
    const tol = HIT_PX / this.v.zoom;

    if (this.tool === 'polygon') { this._polyClick(p); return true; }

    if (this.tool !== 'pointer') { this._startCreate(p); return true; }

    // pointer: handle of selected first
    if (this.selected) {
      const h = this._hitHandle(this.selected, p.ix, p.iy, tol);
      if (h) {
        this._drag = { mode: h.name === 'rot' ? 'rotate' : 'resize', handle: h.name, last: p };
        return true;
      }
    }
    // topmost region body
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this._hitBody(this.list[i], p.ix, p.iy, tol)) {
        this.select(this.list[i]);
        this._drag = { mode: 'move', last: p };
        return true;
      }
    }
    this.select(null);
    return false;   // let the viewer pan
  };

  Regions.prototype._startCreate = function (p) {
    let r;
    switch (this.tool) {
      case 'circle':  r = { type:'circle',  x:p.ix, y:p.iy, r:0 }; break;
      case 'ellipse': r = { type:'ellipse', x:p.ix, y:p.iy, a:0, b:0, angle:0 }; break;
      case 'box':     r = { type:'box',     x:p.ix, y:p.iy, w:0, h:0, angle:0 }; break;
      case 'line':    r = { type:'line', x1:p.ix, y1:p.iy, x2:p.ix, y2:p.iy }; break;
      case 'point':   r = { type:'point', x:p.ix, y:p.iy }; break;
      default: return;
    }
    r.color = this.color;
    this._creating = { r, start: p };
    if (this.tool === 'point') { this.add(r); this._creating = null; this.setTool('pointer'); }
  };

  Regions.prototype._move = function (sx, sy, e, dragging) {
    if (!dragging) { if (this._poly) this.polyPreview(sx, sy); return; }
    const p = this.v.screenToImage(sx, sy);

    if (this._creating) { this._updateCreate(p); this.v.draw(); return; }
    if (!this._drag) return;
    const r = this.selected;
    if (!r) return;
    const d = this._drag;

    if (d.mode === 'move') {
      const dx = p.ix - d.last.ix, dy = p.iy - d.last.iy;
      translate(r, dx, dy);
      d.last = p;
    } else if (d.mode === 'rotate') {
      const c = center(r);
      r.angle = Math.atan2(p.iy - c.y, p.ix - c.x);
    } else { // resize
      this._resize(r, d.handle, p);
    }
    this.v.draw();
    this.notify();
  };

  Regions.prototype._updateCreate = function (p) {
    const { r, start } = this._creating;
    if (r.type === 'circle') r.r = dist(p.ix, p.iy, start.ix, start.iy);
    else if (r.type === 'ellipse') { r.a = Math.abs(p.ix - start.ix) || 1; r.b = Math.abs(p.iy - start.iy) || 1; }
    else if (r.type === 'box') { r.w = Math.abs(p.ix - start.ix)*2 || 1; r.h = Math.abs(p.iy - start.iy)*2 || 1; }
    else if (r.type === 'line') { r.x2 = p.ix; r.y2 = p.iy; }
  };

  Regions.prototype._resize = function (r, handle, p) {
    if (r.type === 'circle') r.r = Math.max(0.5, dist(p.ix, p.iy, r.x, r.y));
    else if (r.type === 'line') {
      if (handle === 'p1') { r.x1 = p.ix; r.y1 = p.iy; } else { r.x2 = p.ix; r.y2 = p.iy; }
    } else if (r.type === 'polygon') {
      const idx = +handle.slice(1); r.pts[idx] = { x: p.ix, y: p.iy };
    } else if (r.type === 'ellipse' || r.type === 'box') {
      const local = rotate(p.ix, p.iy, r.x, r.y, -r.angle);
      const dx = Math.abs(local.x - r.x), dy = Math.abs(local.y - r.y);
      if (r.type === 'ellipse') { if (handle === 'a') r.a = Math.max(0.5, dx); else r.b = Math.max(0.5, dy); }
      else { if (handle === 'a') r.w = Math.max(1, dx*2); else r.h = Math.max(1, dy*2); }
    }
  };

  function translate(r, dx, dy) {
    if (r.type === 'line') { r.x1 += dx; r.y1 += dy; r.x2 += dx; r.y2 += dy; }
    else if (r.type === 'polygon') r.pts.forEach(p => { p.x += dx; p.y += dy; });
    else { r.x += dx; r.y += dy; }
  }

  Regions.prototype._up = function () {
    if (this._creating) {
      const r = this._creating.r;
      // give zero-size creations a sensible default
      if (r.type === 'circle' && r.r < 1) r.r = 10;
      if (r.type === 'ellipse' && (r.a < 1 || r.b < 1)) { r.a = 14; r.b = 8; }
      if (r.type === 'box' && (r.w < 1 || r.h < 1)) { r.w = 20; r.h = 14; }
      this._creating = null;
      this.add(r);
      this.setTool('pointer');
    }
    this._drag = null;
  };

  // ---- polygon construction ----
  Regions.prototype._polyClick = function (p) {
    if (!this._poly) { this._poly = { pts: [{x:p.ix,y:p.iy}], preview: null }; this.v.draw(); return; }
    const first = this._poly.pts[0];
    if (this._poly.pts.length >= 3 && dist(p.ix, p.iy, first.x, first.y) <= HIT_PX/this.v.zoom) {
      this._finishPoly(true); return;
    }
    this._poly.pts.push({ x:p.ix, y:p.iy });
    this.v.draw();
  };
  Regions.prototype._finishPoly = function (commit) {
    if (this._poly && commit && this._poly.pts.length >= 3) {
      this.add({ type:'polygon', pts: this._poly.pts, color: this.color });
      this.setTool('pointer');
    }
    this._poly = null;
    this.v.draw();
  };
  // called from main on mousemove to show the rubber-band edge
  Regions.prototype.polyPreview = function (sx, sy) {
    if (!this._poly) return;
    const p = this.v.screenToImage(sx, sy);
    this._poly.preview = { x: p.ix, y: p.iy };
    this.v.draw();
  };

  // ---- DS9 region format (image coordinates) ----
  function f(n) { return (Math.round(n * 1000) / 1000); }
  Regions.prototype.toDS9 = function () {
    const out = ['# Region file format: DS9 version 4.1',
      `global color=${this.color} width=1`, 'image'];
    for (const r of this.list) {
      let s;
      const x = ix => f(ix + 0.5);        // image -> DS9 (1-based)
      if (r.type === 'circle') s = `circle(${x(r.x)},${x(r.y)},${f(r.r)})`;
      else if (r.type === 'ellipse') s = `ellipse(${x(r.x)},${x(r.y)},${f(r.a)},${f(r.b)},${f(r.angle*180/Math.PI)})`;
      else if (r.type === 'box') s = `box(${x(r.x)},${x(r.y)},${f(r.w)},${f(r.h)},${f(r.angle*180/Math.PI)})`;
      else if (r.type === 'line') s = `line(${x(r.x1)},${x(r.y1)},${x(r.x2)},${x(r.y2)})`;
      else if (r.type === 'point') s = `point(${x(r.x)},${x(r.y)}) # point=cross`;
      else if (r.type === 'polygon') s = `polygon(${r.pts.map(p => `${x(p.x)},${x(p.y)}`).join(',')})`;
      if (s) out.push(s + (r.color && !s.includes('#') ? ` # color=${r.color}` : (r.color ? ` color=${r.color}` : '')));
    }
    return out.join('\n') + '\n';
  };

  Regions.prototype.fromDS9 = function (text) {
    const added = [];
    let physical = false; // image/physical both treated as pixel coords
    for (let raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('global')) continue;
      if (/^(image|physical)$/i.test(line)) { physical = true; continue; }
      if (/^(fk5|icrs|galactic|wcs)/i.test(line)) { physical = false; continue; }
      const m = line.match(/^(\w+)\(([^)]*)\)/);
      if (!m) continue;
      const type = m[1].toLowerCase();
      const a = m[2].split(',').map(Number);
      const colorM = line.match(/color=(\w+)/);
      const color = colorM ? colorM[1] : this.color;
      const ix = X => X - 0.5;            // DS9 (1-based) -> image
      let r = null;
      if (type === 'circle') r = { type:'circle', x:ix(a[0]), y:ix(a[1]), r:a[2] };
      else if (type === 'ellipse') r = { type:'ellipse', x:ix(a[0]), y:ix(a[1]), a:a[2], b:a[3], angle:(a[4]||0)*Math.PI/180 };
      else if (type === 'box') r = { type:'box', x:ix(a[0]), y:ix(a[1]), w:a[2], h:a[3], angle:(a[4]||0)*Math.PI/180 };
      else if (type === 'line') r = { type:'line', x1:ix(a[0]), y1:ix(a[1]), x2:ix(a[2]), y2:ix(a[3]) };
      else if (type === 'point') r = { type:'point', x:ix(a[0]), y:ix(a[1]) };
      else if (type === 'polygon') {
        const pts = []; for (let i = 0; i+1 < a.length; i += 2) pts.push({ x:ix(a[i]), y:ix(a[i+1]) });
        r = { type:'polygon', pts };
      }
      if (r) { r.color = color; r.id = nextId++; this.list.push(r); added.push(r); }
    }
    this.v.draw(); this.notify();
    return added;
  };

  // ---- statistics of the selected region over the image ----
  Regions.prototype._contains = function (r, ix, iy) {
    if (r.type === 'circle') return dist(ix, iy, r.x, r.y) <= r.r;
    if (r.type === 'ellipse') { const p = rotate(ix, iy, r.x, r.y, -r.angle); const dx = (p.x - r.x) / r.a, dy = (p.y - r.y) / r.b; return dx*dx + dy*dy <= 1; }
    if (r.type === 'box') { const p = rotate(ix, iy, r.x, r.y, -r.angle); return Math.abs(p.x - r.x) <= r.w/2 && Math.abs(p.y - r.y) <= r.h/2; }
    if (r.type === 'polygon') return pointInPoly(ix, iy, r.pts);
    return false;
  };

  Regions.prototype.stats = function (image) {
    const r = this.selected;
    if (!r || r.type === 'line' || r.type === 'point') return null;
    const { width: w, height: h, data } = image;
    let bb;
    if (r.type === 'circle') bb = [r.x - r.r, r.x + r.r, r.y - r.r, r.y + r.r];
    else if (r.type === 'ellipse') { const m = Math.max(r.a, r.b); bb = [r.x - m, r.x + m, r.y - m, r.y + m]; }
    else if (r.type === 'box') { const m = Math.hypot(r.w, r.h) / 2; bb = [r.x - m, r.x + m, r.y - m, r.y + m]; }
    else { const xs = r.pts.map(p => p.x), ys = r.pts.map(p => p.y); bb = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]; }
    const x0 = Math.max(0, Math.floor(bb[0])), x1 = Math.min(w, Math.ceil(bb[1]));
    const y0 = Math.max(0, Math.floor(bb[2])), y1 = Math.min(h, Math.ceil(bb[3]));
    let n = 0, sum = 0, sum2 = 0, min = Infinity, max = -Infinity, cx = 0, cy = 0, wsum = 0;
    const vals = [];
    for (let row = y0; row < y1; row++) for (let col = x0; col < x1; col++) {
      const ix = col + 0.5, iy = row + 0.5;
      if (!this._contains(r, ix, iy)) continue;
      const v = data[row * w + col];
      if (!Number.isFinite(v)) continue;
      n++; sum += v; sum2 += v*v;
      if (v < min) min = v; if (v > max) max = v;
      const wv = v > 0 ? v : 0; cx += ix * wv; cy += iy * wv; wsum += wv;
      vals.push(v);
    }
    if (!n) return { npix: 0 };
    const mean = sum / n;
    vals.sort((a, b) => a - b);
    return { npix: n, sum, mean, median: vals[n >> 1],
      stddev: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), min, max,
      centroidX: wsum ? cx / wsum : NaN, centroidY: wsum ? cy / wsum : NaN };
  };

  global.Regions = Regions;
})(window);
