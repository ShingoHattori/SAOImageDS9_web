/* wcs.js — minimal celestial WCS for cursor readout (gnomonic / TAN only).
 *
 * Supports the common RA---TAN / DEC--TAN case with either a CD matrix or
 * CDELT + CROTA2. Returns null when the header is not a recognised sky WCS;
 * the viewer then simply omits the RA/Dec readout. This is not a full WCS
 * implementation — just enough for "where am I pointing" feedback.
 */
(function (global) {
  'use strict';

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function build(h) {
    const t1 = (h.CTYPE1 || '').toString();
    const t2 = (h.CTYPE2 || '').toString();
    if (!/TAN/.test(t1) || !/TAN/.test(t2)) return null;
    if (h.CRPIX1 == null || h.CRPIX2 == null || h.CRVAL1 == null || h.CRVAL2 == null) return null;

    const crpix1 = h.CRPIX1, crpix2 = h.CRPIX2;
    const crval1 = h.CRVAL1, crval2 = h.CRVAL2;

    // CD matrix (deg/pixel). Prefer CDi_j, else CDELT/CROTA2.
    let cd11, cd12, cd21, cd22;
    if (h.CD1_1 != null || h.CD2_2 != null) {
      cd11 = h.CD1_1 || 0; cd12 = h.CD1_2 || 0;
      cd21 = h.CD2_1 || 0; cd22 = h.CD2_2 || 0;
    } else {
      const cdelt1 = h.CDELT1 || 0, cdelt2 = h.CDELT2 || 0;
      const rot = (h.CROTA2 || 0) * D2R;
      const cosr = Math.cos(rot), sinr = Math.sin(rot);
      cd11 = cdelt1 * cosr;  cd12 = -cdelt2 * sinr;
      cd21 = cdelt1 * sinr;  cd22 = cdelt2 * cosr;
    }

    const ra0 = crval1 * D2R, dec0 = crval2 * D2R;
    const sind0 = Math.sin(dec0), cosd0 = Math.cos(dec0);

    // pixel (1-based FITS) -> RA/Dec (deg)
    return function pixToSky(px, py) {
      const dx = px - crpix1, dy = py - crpix2;
      // intermediate world coords (deg) then to radians
      const xi = (cd11 * dx + cd12 * dy) * D2R;
      const eta = (cd21 * dx + cd22 * dy) * D2R;
      // inverse gnomonic
      const r = Math.sqrt(xi * xi + eta * eta);
      const c = Math.atan(r);
      let ra, dec;
      if (r === 0) { ra = ra0; dec = dec0; }
      else {
        const sinc = Math.sin(c), cosc = Math.cos(c);
        dec = Math.asin(cosc * sind0 + (eta * sinc * cosd0) / r);
        ra = ra0 + Math.atan2(xi * sinc, r * cosd0 * cosc - eta * sind0 * sinc);
      }
      let raDeg = ((ra * R2D) % 360 + 360) % 360;
      return { ra: raDeg, dec: dec * R2D };
    };
  }

  function fmtRA(deg) {
    let h = deg / 15;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    const ss = ((h - hh) * 60 - mm) * 60;
    return `${pad(hh)}:${pad(mm)}:${ss.toFixed(2).padStart(5,'0')}`;
  }
  function fmtDec(deg) {
    const sign = deg < 0 ? '-' : '+';
    deg = Math.abs(deg);
    const dd = Math.floor(deg);
    const mm = Math.floor((deg - dd) * 60);
    const ss = ((deg - dd) * 60 - mm) * 60;
    return `${sign}${pad(dd)}:${pad(mm)}:${ss.toFixed(1).padStart(4,'0')}`;
  }
  const pad = n => String(n).padStart(2, '0');

  // Equatorial (FK5/J2000, deg) -> Galactic (l,b in deg).
  const AGP = 192.85948 * D2R, DGP = 27.12825 * D2R, LCP = 122.93192 * D2R;
  function eq2gal(raDeg, decDeg) {
    const a = raDeg * D2R, d = decDeg * D2R;
    const b = Math.asin(Math.sin(DGP)*Math.sin(d) + Math.cos(DGP)*Math.cos(d)*Math.cos(a - AGP));
    let l = LCP - Math.atan2(Math.cos(d)*Math.sin(a - AGP),
                             Math.cos(DGP)*Math.sin(d) - Math.sin(DGP)*Math.cos(d)*Math.cos(a - AGP));
    let lDeg = ((l * R2D) % 360 + 360) % 360;
    return { l: lDeg, b: b * R2D };
  }

  // ---- spectral / velocity axis (NAXIS3) for data cubes ----
  const C = 299792.458; // speed of light, km/s

  function spectral(h) {
    if ((h.NAXIS || 0) < 3 || (h.NAXIS3 || 1) <= 1) return null;
    const ctype = (h.CTYPE3 || '').toString().toUpperCase();
    const cunit = (h.CUNIT3 || '').toString().trim();
    const crpix = h.CRPIX3 != null ? h.CRPIX3 : 1;
    const crval = h.CRVAL3 != null ? h.CRVAL3 : 1;
    const cdelt = h.CD3_3 != null ? h.CD3_3 : (h.CDELT3 != null ? h.CDELT3 : 1);
    const restfrq = h.RESTFRQ != null ? h.RESTFRQ : (h.RESTFREQ != null ? h.RESTFREQ : null);

    const kind =
      /^(VELO|VRAD|VOPT|FELO|VELOCITY)/.test(ctype) ? 'velocity' :
      /^FREQ/.test(ctype) ? 'freq' :
      /^WAVE/.test(ctype) ? 'wave' : 'other';

    // world coordinate of a 0-based plane along NAXIS3 (FITS pixel = plane+1)
    function world(plane) { return crval + (plane + 1 - crpix) * cdelt; }

    function label(plane) {
      const w = world(plane);
      if (kind === 'velocity') {
        const kms = /km\/?s/i.test(cunit) ? w : w / 1000; // default m/s -> km/s
        return `v = ${kms.toFixed(2)} km/s`;
      }
      if (kind === 'freq') {
        let s = `ν = ${(w / 1e9).toFixed(6)} GHz`;
        if (restfrq) s += `  (v = ${(C * (restfrq - w) / restfrq).toFixed(2)} km/s)`;
        return s;
      }
      if (kind === 'wave') {
        const um = /um|micron/i.test(cunit) ? w : w * 1e6; // default m -> micron
        return `λ = ${um.toFixed(4)} µm`;
      }
      return `${ctype || 'axis3'} = ${w.toPrecision(6)}${cunit ? ' ' + cunit : ''}`;
    }

    return { kind, ctype, cunit, world, label };
  }

  global.WCS = { build, fmtRA, fmtDec, eq2gal, spectral };
})(window);
