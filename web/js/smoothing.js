/* smoothing.js — image-domain processing: Gaussian/boxcar smoothing and
 * block binning. Each returns a new image object {data,width,height,min,max}
 * of physical values. NaN pixels are treated as missing (weighted so they
 * don't poison neighbours).
 */
(function (global) {
  'use strict';

  function finishStats(data, width, height) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    return { data, width, height, min, max };
  }

  // Separable convolution with a 1-D kernel; NaN-aware (renormalises weights).
  function convolveSeparable(image, kernel) {
    const { width: w, height: h, data } = image;
    const r = (kernel.length - 1) >> 1;
    const tmp = new Float64Array(w * h);
    // horizontal
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let acc = 0, wsum = 0;
        for (let k = -r; k <= r; k++) {
          let xx = x + k; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
          const v = data[row + xx];
          if (Number.isFinite(v)) { const kw = kernel[k + r]; acc += kw * v; wsum += kw; }
        }
        tmp[row + x] = wsum ? acc / wsum : NaN;
      }
    }
    // vertical
    const out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0, wsum = 0;
        for (let k = -r; k <= r; k++) {
          let yy = y + k; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
          const v = tmp[yy * w + x];
          if (Number.isFinite(v)) { const kw = kernel[k + r]; acc += kw * v; wsum += kw; }
        }
        out[y * w + x] = wsum ? acc / wsum : NaN;
      }
    }
    return finishStats(out, w, h);
  }

  function gaussianKernel(sigma) {
    sigma = Math.max(0.5, sigma);
    const r = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float64Array(2 * r + 1);
    for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    return k;
  }

  const Smooth = {
    gaussian(image, sigma) { return convolveSeparable(image, gaussianKernel(sigma)); },
    boxcar(image, radius) {
      const r = Math.max(1, Math.round(radius));
      return convolveSeparable(image, new Float64Array(2 * r + 1).fill(1));
    },
    // Block-average binning by an integer factor (NaN-aware).
    bin(image, factor) {
      const f = Math.max(1, Math.round(factor));
      if (f === 1) return image;
      const { width: w, height: h, data } = image;
      const nw = Math.floor(w / f), nh = Math.floor(h / f);
      const out = new Float64Array(nw * nh);
      for (let by = 0; by < nh; by++) {
        for (let bx = 0; bx < nw; bx++) {
          let acc = 0, cnt = 0;
          for (let dy = 0; dy < f; dy++) {
            const row = (by * f + dy) * w;
            for (let dx = 0; dx < f; dx++) {
              const v = data[row + bx * f + dx];
              if (Number.isFinite(v)) { acc += v; cnt++; }
            }
          }
          out[by * nw + bx] = cnt ? acc / cnt : NaN;
        }
      }
      return finishStats(out, nw, nh);
    },
  };

  global.Smooth = Smooth;
})(window);
