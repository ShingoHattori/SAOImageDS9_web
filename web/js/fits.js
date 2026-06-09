/* fits.js — minimal client-side FITS reader.
 *
 * Parses a FITS file (ArrayBuffer) into a list of HDUs. For image HDUs the
 * pixel data is exposed as a Float64Array (physical values, BZERO/BSCALE
 * applied) together with width/height. Only what a basic viewer needs.
 *
 * FITS reference: blocks are 2880 bytes. Headers are 80-char ASCII "cards"
 * terminated by an END card. Image data is big-endian, row-major, with the
 * first axis (NAXIS1) varying fastest. BITPIX selects the sample type.
 */
(function (global) {
  'use strict';

  const BLOCK = 2880;
  const CARD = 80;

  function parseHeader(buf, offset) {
    const cards = [];      // raw 80-char strings (for the header viewer)
    const map = {};        // KEY -> parsed value
    const view = new Uint8Array(buf);
    let pos = offset;
    let end = false;

    while (pos + BLOCK <= buf.byteLength) {
      for (let i = 0; i < BLOCK; i += CARD) {
        let card = '';
        for (let j = 0; j < CARD; j++) card += String.fromCharCode(view[pos + i + j]);
        const key = card.slice(0, 8).trim();
        if (key === 'END') { end = true; cards.push(card.replace(/\s+$/, '')); break; }
        if (card.trim() === '') continue;
        cards.push(card.replace(/\s+$/, ''));
        if (key && key !== 'COMMENT' && key !== 'HISTORY' && card[8] === '=') {
          map[key] = parseValue(card.slice(10));
        }
      }
      pos += BLOCK;
      if (end) break;
    }
    return { map, cards, dataOffset: pos };
  }

  function parseValue(s) {
    // Strip an inline comment that is not inside a quoted string.
    let str = s;
    const q = str.indexOf("'");
    if (q !== -1) {
      const endq = str.indexOf("'", q + 1);
      const value = str.slice(q + 1, endq === -1 ? str.length : endq).trim();
      return value;
    }
    const slash = str.indexOf('/');
    if (slash !== -1) str = str.slice(0, slash);
    str = str.trim();
    if (str === 'T') return true;
    if (str === 'F') return false;
    if (str === '') return '';
    const num = Number(str);
    return Number.isNaN(num) ? str : num;
  }

  const BITPIX = {
    8:   { bytes: 1, read: (dv, o) => dv.getUint8(o) },
    16:  { bytes: 2, read: (dv, o) => dv.getInt16(o, false) },
    32:  { bytes: 4, read: (dv, o) => dv.getInt32(o, false) },
    64:  { bytes: 8, read: (dv, o) => Number(dv.getBigInt64(o, false)) },
    '-32': { bytes: 4, read: (dv, o) => dv.getFloat32(o, false) },
    '-64': { bytes: 8, read: (dv, o) => dv.getFloat64(o, false) },
  };

  function dataUnitSize(h) {
    const naxis = h.NAXIS || 0;
    if (!naxis) return 0;
    let n = 1;
    for (let i = 1; i <= naxis; i++) n *= (h['NAXIS' + i] || 0);
    const bp = BITPIX[String(h.BITPIX)];
    return n * (bp ? bp.bytes : 0) + (h.PCOUNT || 0);   // PCOUNT = table heap
  }

  // BINTABLE column scalar readers (big-endian, first element of each cell).
  const TSIZE = { L:1, X:0, B:1, I:2, J:4, K:8, A:1, E:4, D:8, C:8, M:16, P:8, Q:16 };
  const TREAD = {
    B: (dv,o)=>dv.getUint8(o), I:(dv,o)=>dv.getInt16(o,false), J:(dv,o)=>dv.getInt32(o,false),
    K:(dv,o)=>Number(dv.getBigInt64(o,false)), E:(dv,o)=>dv.getFloat32(o,false),
    D:(dv,o)=>dv.getFloat64(o,false), L:(dv,o)=>dv.getUint8(o),
  };

  function parseColumns(h) {
    const nf = h.TFIELDS || 0;
    const cols = [];
    let offset = 0;
    for (let i = 1; i <= nf; i++) {
      const tform = (h['TFORM' + i] || '').toString().trim();
      const m = tform.match(/^(\d*)([A-Z])/);
      const repeat = m && m[1] ? parseInt(m[1], 10) : 1;
      const type = m ? m[2] : 'A';
      const width = repeat * (TSIZE[type] || 0);
      cols.push({
        index: i - 1, name: (h['TTYPE' + i] || ('col' + i)).toString().trim(),
        type, repeat, offset, width,
        tscal: h['TSCAL' + i] != null ? h['TSCAL' + i] : 1,
        tzero: h['TZERO' + i] != null ? h['TZERO' + i] : 0,
        tlmin: h['TLMIN' + i], tlmax: h['TLMAX' + i],
        unit: (h['TUNIT' + i] || '').toString().trim(),
        numeric: !!TREAD[type],
      });
      offset += width;
    }
    return cols;
  }

  function alignBlock(n) { return Math.ceil(n / BLOCK) * BLOCK; }

  // Read a single 2D plane (`plane`, 0-based along NAXIS3) of an image/cube
  // into a Float64Array of physical values, plus min/max over finite samples.
  function readImage(buf, header, plane) {
    plane = plane | 0;
    const h = header.map;
    const w = h.NAXIS1 | 0;
    const ht = h.NAXIS2 | 0;
    const bp = BITPIX[String(h.BITPIX)];
    if (!bp || !w || !ht) return null;

    const bzero = (h.BZERO != null) ? h.BZERO : 0;
    const bscale = (h.BSCALE != null) ? h.BSCALE : 1;
    const blank = (h.BLANK != null && Number(h.BITPIX) > 0) ? h.BLANK : null;

    const n = w * ht;
    const dv = new DataView(buf, header.dataOffset + plane * n * bp.bytes);
    const out = new Float64Array(n);
    let min = Infinity, max = -Infinity;
    const step = bp.bytes;

    for (let i = 0; i < n; i++) {
      const raw = bp.read(dv, i * step);
      let v;
      if (blank !== null && raw === blank) {
        v = NaN;
      } else {
        v = bzero + bscale * raw;
        if (Number.isFinite(v)) {
          if (v < min) min = v;
          if (v > max) max = v;
        } else {
          v = NaN;
        }
      }
      out[i] = v;
    }
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    return { data: out, width: w, height: ht, min, max };
  }

  // Parse the whole file into HDUs. Image HDUs get { image: {...} } lazily-ish
  // (we read images on demand to keep large multi-extension files cheap).
  function parse(buf) {
    const hdus = [];
    let offset = 0;
    let guard = 0;
    while (offset + BLOCK <= buf.byteLength && guard++ < 1000) {
      const header = parseHeader(buf, offset);
      const h = header.map;
      const naxis = h.NAXIS || 0;
      const xtension = (typeof h.XTENSION === 'string') ? h.XTENSION.trim() : '';
      const isTable = /^BINTABLE$/i.test(xtension);
      const isImage = !isTable && !!(naxis >= 2 && h.NAXIS1 && h.NAXIS2 && BITPIX[String(h.BITPIX)]);

      hdus.push({
        index: hdus.length,
        header,
        isImage,
        isTable,
        type: hdus.length === 0 ? 'PRIMARY' : (xtension || 'EXT'),
        width: h.NAXIS1 || 0,
        height: h.NAXIS2 || 0,
        depth: naxis >= 3 ? (h.NAXIS3 || 1) : 1,   // number of slices (cube)
        bitpix: h.BITPIX,
        naxis,
        columns: isTable ? parseColumns(h) : null,
        nrows: isTable ? (h.NAXIS2 || 0) : 0,
        rowBytes: isTable ? (h.NAXIS1 || 0) : 0,
        _buf: buf,
        _planes: {},
      });

      const dsize = alignBlock(dataUnitSize(h));
      offset = header.dataOffset + dsize;
      if (dsize === 0 && naxis === 0 && hdus.length > 0 && offset >= buf.byteLength) break;
    }

    // attach on-demand loaders
    for (const hdu of hdus) {
      hdu.loadImage = function (plane) {
        if (!this.isImage) return null;
        plane = Math.max(0, Math.min(this.depth - 1, plane | 0));
        if (!this._planes[plane]) this._planes[plane] = readImage(this._buf, this.header, plane);
        return this._planes[plane];
      };
      // Read a scalar numeric column as a Float64Array (TSCAL/TZERO applied).
      hdu.readColumn = function (col) {
        if (!this.isTable) return null;
        const c = typeof col === 'number' ? this.columns[col] : this.columns.find(k => k.name === col);
        if (!c || !c.numeric) return null;
        const dv = new DataView(this._buf, this.header.dataOffset);
        const read = TREAD[c.type], n = this.nrows, rb = this.rowBytes, off = c.offset;
        const out = new Float64Array(n);
        for (let r = 0; r < n; r++) out[r] = c.tzero + c.tscal * read(dv, r * rb + off);
        return out;
      };
    }
    return hdus;
  }

  global.FITS = { parse };
})(window);
