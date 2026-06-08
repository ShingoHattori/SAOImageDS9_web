/* colormap.js — DS9 built-in colormaps, reproduced from the DS9 source
 * (tksao/colorbar/default.C). Two kinds:
 *   SAO : per-channel piecewise-linear control points  [ [x,value], ... ]
 *   LUT : a discrete list of RGB colors (stair-stepped across the range)
 * build(name, invert) returns a 256*3 Uint8 lookup table.
 */
(function (global) {
  'use strict';

  // --- SAO colormaps: { r:[[x,v]...], g:[...], b:[...] } ---
  const SAO = {
    grey: { r: [[0,0],[1,1]], g: [[0,0],[1,1]], b: [[0,0],[1,1]] },
    red:  { r: [[0,0],[1,1]], g: [[0,0],[0,0]], b: [[0,0],[0,0]] },
    green:{ r: [[0,0],[0,0]], g: [[0,0],[1,1]], b: [[0,0],[0,0]] },
    blue: { r: [[0,0],[0,0]], g: [[0,0],[0,0]], b: [[0,0],[1,1]] },
    a: {
      r: [[0,0],[.25,0],[.5,1],[1,1]],
      g: [[0,0],[.25,1],[.5,0],[.77,0],[1,1]],
      b: [[0,0],[.125,0],[.5,1],[.64,.5],[.77,0],[1,0]],
    },
    b: {
      r: [[0,0],[.25,0],[.5,1],[1,1]],
      g: [[0,0],[.5,0],[.75,1],[1,1]],
      b: [[0,0],[.25,1],[.5,0],[.75,0],[1,1]],
    },
    bb: {
      r: [[0,0],[.5,1],[1,1]],
      g: [[0,0],[.25,0],[.75,1],[1,1]],
      b: [[0,0],[.5,0],[1,1]],
    },
    he: {
      r: [[0,0],[.015,.5],[.25,.5],[.5,.75],[1,1]],
      g: [[0,0],[.065,0],[.125,.5],[.25,.75],[.5,.81],[1,1]],
      b: [[0,0],[.015,.125],[.03,.375],[.065,.625],[.25,.25],[1,1]],
    },
    heat: {
      r: [[0,0],[.34,1],[1,1]],
      g: [[0,0],[1,1]],
      b: [[0,0],[.65,0],[.98,1],[1,1]],
    },
    cool: {
      r: [[0,0],[.29,0],[.76,.1],[1,1]],
      g: [[0,0],[.22,0],[.96,1],[1,1]],
      b: [[0,0],[.53,1],[1,1]],
    },
    rainbow: {
      r: [[0,1],[.2,0],[.6,0],[.8,1],[1,1]],
      g: [[0,0],[.2,0],[.4,1],[.8,1],[1,0]],
      b: [[0,1],[.4,1],[.6,0],[1,0]],
    },
    standard: {
      r: [[0,0],[.333,.3],[.333,0],[.666,.3],[.666,.3],[1,1]],
      g: [[0,0],[.333,.3],[.333,.3],[.666,1],[.666,0],[1,.3]],
      b: [[0,0],[.333,1],[.333,0],[.666,.3],[.666,0],[1,.3]],
    },
  };

  // --- LUT colormaps: discrete RGB lists ---
  const LUT = {
    i8: [[0,0,0],[0,1,0],[0,0,1],[0,1,1],[1,0,0],[1,1,0],[1,0,1],[1,1,1]],
    aips0: [
      [.196,.196,.196],[.475,0,.608],[0,0,.785],[.373,.655,.925],
      [0,.596,0],[0,.965,0],[1,1,0],[1,.694,0],[1,0,0],
    ],
    staircase: stairColors(),
    color: [
      [0,0,0],[.18431,.18431,.18431],[.37255,.37255,.37255],[.56078,.56078,.56078],
      [.74902,.74902,.74902],[.93725,.93725,.93725],[0,.18431,.93725],[0,.37255,.74902],
      [0,.49804,.49804],[0,.74902,.30980],[0,.93725,0],[.30980,.62353,0],
      [.49804,.49804,0],[.62353,.30980,0],[.93725,0,0],[.74902,0,.30980],
    ],
  };

  function stairColors() {
    const c = [];
    for (let i = 1; i <= 5; i++) { const k = i/5; c.push([k*.3, k*.3, k*1]); }
    for (let i = 1; i <= 5; i++) { const k = i/5; c.push([k*.3, k*1, k*.3]); }
    for (let i = 1; i <= 5; i++) { const k = i/5; c.push([k*1, k*.3, k*.3]); }
    return c;
  }

  // Linear interpolation over control points; duplicate x produces a jump.
  function interp(points, t) {
    if (t <= points[0][0]) return points[0][1];
    const n = points.length;
    if (t >= points[n-1][0]) return points[n-1][1];
    for (let i = 0; i < n - 1; i++) {
      const x0 = points[i][0], x1 = points[i+1][0];
      if (t >= x0 && t <= x1) {
        if (x1 === x0) continue;            // zero-width segment -> discontinuity
        const f = (t - x0) / (x1 - x0);
        return points[i][1] + (points[i+1][1] - points[i][1]) * f;
      }
    }
    return points[n-1][1];
  }

  const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t;

  function sample(name, t) {
    if (SAO[name]) {
      const c = SAO[name];
      return [interp(c.r, t), interp(c.g, t), interp(c.b, t)];
    }
    if (LUT[name]) {
      const arr = LUT[name];
      const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(t * arr.length)));
      return arr[idx];                      // discrete (stair-stepped)
    }
    return [t, t, t];
  }

  function build(name, invert) {
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = invert ? (255 - i) / 255 : i / 255;
      const c = sample(name, t);
      lut[i*3]   = Math.round(clamp01(c[0]) * 255);
      lut[i*3+1] = Math.round(clamp01(c[1]) * 255);
      lut[i*3+2] = Math.round(clamp01(c[2]) * 255);
    }
    return lut;
  }

  // DS9 Color-menu order
  const names = ['grey','red','green','blue','a','b','bb','he','i8','aips0',
                 'heat','cool','rainbow','standard','staircase','color'];

  global.Colormap = { build, names };
})(window);
