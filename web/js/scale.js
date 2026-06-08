/* scale.js — intensity transfer functions and low/high limit estimation,
 * reproduced from DS9 (tksao/frame/colorscale.C). The transfer maps the
 * clipped intensity u in [0,1] to a colormap position t in [0,1]:
 *
 *   linear  t = u
 *   log     t = log10(EXP*u + 1) / log10(EXP)
 *   pow     t = (EXP^u - 1) / EXP
 *   sqrt    t = sqrt(u)
 *   squared t = u*u
 *   asinh   t = asinh(10*u) / 3
 *   sinh    t = sinh(3*u) / 10
 *   histequ t = CDF(u)            (data-dependent — see makeTransfer)
 */
(function (global) {
  'use strict';

  const EXP = 1000;          // DS9 default scale exponent for log/pow
  const clamp01 = t => t < 0 ? 0 : t > 1 ? 1 : t;

  const STATIC = {
    linear:  u => u,
    log:     u => clamp01(Math.log10(EXP * u + 1) / Math.log10(EXP)),
    pow:     u => clamp01((Math.pow(EXP, u) - 1) / EXP),
    sqrt:    u => Math.sqrt(u),
    squared: u => u * u,
    asinh:   u => clamp01(Math.asinh(10 * u) / 3),
    sinh:    u => clamp01(Math.sinh(3 * u) / 10),
  };

  // Build a transfer function u->t. histequ needs the data histogram.
  function makeTransfer(name, image, lo, hi) {
    if (name !== 'histequ') return STATIC[name] || STATIC.linear;
    const N = 1024;
    const span = (hi - lo) || 1;
    const hist = new Float64Array(N);
    const data = image.data;
    let total = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      let b = Math.floor(((v - lo) / span) * N);
      if (b < 0) b = 0; else if (b >= N) b = N - 1;
      hist[b]++; total++;
    }
    // cumulative -> normalized CDF
    let acc = 0;
    for (let i = 0; i < N; i++) { acc += hist[i]; hist[i] = total ? acc / total : i / (N - 1); }
    return u => hist[Math.min(N - 1, Math.max(0, Math.floor(u * (N - 1))))];
  }

  // ---- limit estimation ----
  function sample(data, maxN) {
    const stride = Math.max(1, Math.floor(data.length / maxN));
    const s = [];
    for (let i = 0; i < data.length; i += stride) {
      const v = data[i];
      if (Number.isFinite(v)) s.push(v);
    }
    return s;
  }

  function percentile(data, loPct, hiPct) {
    const s = sample(data, 200000);
    if (!s.length) return [0, 1];
    s.sort((a, b) => a - b);
    const lo = s[Math.floor((loPct / 100) * (s.length - 1))];
    const hi = s[Math.floor((hiPct / 100) * (s.length - 1))];
    return [lo, hi > lo ? hi : lo + 1];
  }

  // IRAF zscale.
  function zscale(data, contrast) {
    contrast = contrast || 0.25;
    const s = sample(data, 5000);
    const npix = s.length;
    if (npix < 5) return percentile(data, 0, 100);
    s.sort((a, b) => a - b);
    const median = s[npix >> 1];
    let kept = s.map((_, i) => i), slope = 0, inter = median;
    for (let iter = 0; iter < 5; iter++) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      const c = npix / 2;
      for (const i of kept) { const x = i - c, y = s[i]; sx += x; sy += y; sxx += x*x; sxy += x*y; }
      const m = kept.length, denom = m * sxx - sx * sx;
      if (denom === 0) break;
      slope = (m * sxy - sx * sy) / denom;
      inter = (sy - slope * sx) / m;
      let ss = 0;
      for (const i of kept) { const r = s[i] - (inter + slope * (i - c)); ss += r * r; }
      const sigma = Math.sqrt(ss / kept.length);
      if (sigma === 0) break;
      const next = kept.filter(i => Math.abs(s[i] - (inter + slope * (i - c))) <= 2.5 * sigma);
      if (next.length === kept.length || next.length < npix * 0.5) break;
      kept = next;
    }
    const c = npix / 2;
    let z1 = Math.max(median + (slope / contrast) * (0 - c), s[0]);
    let z2 = Math.min(median + (slope / contrast) * (npix - 1 - c), s[npix - 1]);
    if (z2 <= z1) { z1 = s[0]; z2 = s[npix - 1] || z1 + 1; }
    return [z1, z2];
  }

  // Returns [lo,hi], or null for 'user' (caller keeps current limits).
  function limits(mode, data, dataMin, dataMax) {
    switch (mode) {
      case 'user':   return null;
      case 'minmax': return [dataMin, dataMax > dataMin ? dataMax : dataMin + 1];
      case 'zscale': return zscale(data, 0.25);
      case 'zmax':   return [zscale(data, 0.25)[0], dataMax > dataMin ? dataMax : dataMin + 1];
      case '99.5':   return percentile(data, 0.25, 99.75);
      case '99':     return percentile(data, 0.5, 99.5);
      case '98':     return percentile(data, 1, 99);
      case '95':     return percentile(data, 2.5, 97.5);
      case '90':     return percentile(data, 5, 95);
      default:       return zscale(data, 0.25);
    }
  }

  global.Scale = { makeTransfer, limits, names: Object.keys(STATIC).concat('histequ') };
})(window);
