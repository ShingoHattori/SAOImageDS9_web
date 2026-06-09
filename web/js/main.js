/* main.js — wire the UI to the viewer (scale params, colormap, cube/velocity). */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const viewer = new Viewer($('view'));
  const panels = new Panels(viewer, {
    panner: $('pannerCanvas'),
    magnifier: $('magCanvas'),
    colorbar: $('colorbarCanvas'),
    pixtable: $('pixtable'),
    cbLow: $('cbLow'),
    cbHigh: $('cbHigh'),
  });
  let hdus = [];
  let currentHdu = null;
  let currentPlane = 0;
  let spectral = null;       // WCS spectral-axis helper or null
  let playTimer = null;
  let lastReadout = null;    // remember cursor info for coord-system switches

  viewer.onChange = () => panels.updateView();

  // ---- regions + overlays + plots ----
  const regions = new Regions(viewer, { onChange: renderRegionList });
  const overlays = new Overlays(viewer);
  const plots = new Plots(viewer, {
    modal: $('plotModal'), canvas: $('plotCanvas'), type: $('plotType'),
    title: $('plotTitle'),
  }, () => {
    const r = regions.selected;     // radial profile centres on a circle region
    return (r && r.type === 'circle') ? { ix: r.x, iy: r.y, maxR: r.r * 1.4 } : null;
  }, () => {
    const r = regions.selected;     // projection runs along a line region
    return (r && r.type === 'line') ? { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 } : null;
  });
  $('plotBtn').addEventListener('click', () => plots.toggle());
  $('plotType').addEventListener('change', () => plots.render());
  $('plotClose').addEventListener('click', () => plots.close());
  $('plotExport').addEventListener('click', () => plots.exportData());
  // histogram: click sets Low, Shift+click sets High (DS9 Scale-Parameters style)
  $('plotCanvas').addEventListener('click', e => {
    if ($('plotType').value !== 'histogram' || !plots._histAxis) return;
    const cv = $('plotCanvas'), rect = cv.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (cv.width / rect.width);
    const a = plots._histAxis;
    const val = a.lo + (px - a.x0) / (a.x1 - a.x0) * a.span;
    if (e.shiftKey) { if (val > viewer.low) viewer.high = val; }
    else { if (val < viewer.high) viewer.low = val; }
    viewer.limitMode = 'user'; $('limitSelect').value = 'user';
    overlays.contour.segs = null;
    viewer.renderImage(); viewer.draw(); syncLimitInputs(); updateStatus(); plots.render();
  });
  $('plotModal').addEventListener('click', e => { if (e.target.id === 'plotModal') plots.close(); });
  // compose the overlay stack: grid/contour → regions → crosshair
  viewer.overlay = (ctx) => {
    overlays.drawFields(ctx);
    regions.draw(ctx);
    overlays.drawCrosshair(ctx);
  };

  $('ovContour').addEventListener('change', e => {
    overlays.contour.on = e.target.checked;
    if (e.target.checked) overlays.contour.segs = null;
    viewer.draw();
  });
  $('ovLevels').addEventListener('change', e => {
    overlays.contour.levels = Math.max(1, Math.min(20, +e.target.value || 5));
    overlays.contour.segs = null;
    viewer.draw();
  });
  $('ovGrid').addEventListener('change', e => {
    overlays.grid.on = e.target.checked;
    if (e.target.checked) overlays.grid.lines = null;
    viewer.draw();
  });
  $('ovCross').addEventListener('change', e => {
    overlays.cross.on = e.target.checked;
    viewer.draw();
  });

  // ---- image processing: smoothing / binning ----
  function reprocessImage(refit) {
    viewer.reprocess();
    if (refit) viewer.zoomFit();
    overlays.invalidate();
    syncLimitInputs();
    updateStatus();
    viewer.draw();
  }
  $('smoothChk').addEventListener('change', e => { viewer.smooth.on = e.target.checked; reprocessImage(false); });
  $('smoothType').addEventListener('change', e => { viewer.smooth.type = e.target.value; if (viewer.smooth.on) reprocessImage(false); });
  $('smoothRadius').addEventListener('change', e => {
    viewer.smooth.radius = Math.max(0.5, +e.target.value || 2);
    if (viewer.smooth.on) reprocessImage(false);
  });
  $('binSelect').addEventListener('change', e => { viewer.binFactor = +e.target.value || 1; reprocessImage(true); });

  // ---- orientation (flip / rotate) ----
  $('flipX').addEventListener('click', () => viewer.flip('x'));
  $('flipY').addEventListener('click', () => viewer.flip('y'));
  $('rotate90').addEventListener('click', () => viewer.rotate90(1));
  $('orientReset').addEventListener('click', () => viewer.resetOrient());

  document.querySelectorAll('#regionbar .rb-tools button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#regionbar .rb-tools button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      regions.setTool(btn.dataset.tool);
    });
  });
  $('regionColor').addEventListener('change', e => {
    regions.color = e.target.value;
    if (regions.selected) { regions.selected.color = e.target.value; viewer.draw(); renderRegionList(); }
  });
  $('regionDelete').addEventListener('click', () => { if (regions.selected) regions.remove(regions.selected); });
  $('regionClear').addEventListener('click', () => regions.clear());
  $('regionExport').addEventListener('click', () => {
    const blob = new Blob([regions.toDS9()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (document.title.split(' — ')[0] || 'regions') + '.reg';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('regionImport').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => regions.fromDS9(reader.result);
    reader.readAsText(f);
    e.target.value = '';
  });

  function regionSummary(r) {
    const n = v => Math.round(v * 10) / 10;
    if (r.type === 'circle')  return `circle  (${n(r.x)},${n(r.y)}) r=${n(r.r)}`;
    if (r.type === 'ellipse') return `ellipse (${n(r.x)},${n(r.y)}) ${n(r.a)}×${n(r.b)}`;
    if (r.type === 'box')     return `box     (${n(r.x)},${n(r.y)}) ${n(r.w)}×${n(r.h)}`;
    if (r.type === 'line')    return `line    (${n(r.x1)},${n(r.y1)})→(${n(r.x2)},${n(r.y2)})`;
    if (r.type === 'point')   return `point   (${n(r.x)},${n(r.y)})`;
    if (r.type === 'polygon') return `polygon ${r.pts.length} pts`;
    return r.type;
  }
  function renderRegionList() {
    const ul = $('regionList');
    ul.innerHTML = '';
    if (!regions.list.length) {
      ul.innerHTML = '<li class="empty">(no regions)</li>';
      return;
    }
    regions.list.forEach(r => {
      const li = document.createElement('li');
      if (r === regions.selected) li.classList.add('sel');
      const sw = document.createElement('span');
      sw.className = 'swatch'; sw.style.background = r.color;
      li.appendChild(sw);
      li.appendChild(document.createTextNode(regionSummary(r)));
      li.addEventListener('click', () => regions.select(r));
      ul.appendChild(li);
    });
    renderRegionStats();
    if (plots.open) plots.render();    // projection/radial follow the selection
  }
  function renderRegionStats() {
    const el = $('regionStats');
    const s = (viewer.image && regions.selected) ? regions.stats(viewer.image) : null;
    if (!s) { el.innerHTML = '<span class="empty">（領域を選択：circle/box/ellipse/polygon）</span>'; return; }
    if (!s.npix) { el.innerHTML = '<span class="empty">領域内に有効画素なし</span>'; return; }
    const f = v => !Number.isFinite(v) ? '–'
      : (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0)) ? v.toExponential(3) : (Math.round(v * 1000) / 1000).toString();
    el.textContent =
      `npix     ${s.npix}\n` +
      `sum      ${f(s.sum)}\n` +
      `mean     ${f(s.mean)}\n` +
      `median   ${f(s.median)}\n` +
      `stddev   ${f(s.stddev)}\n` +
      `min/max  ${f(s.min)} / ${f(s.max)}\n` +
      `centroid ${f(s.centroidX)}, ${f(s.centroidY)}`;
  }
  renderRegionList();

  // ---- status-bar readout ----
  viewer.onReadout = (info) => {
    lastReadout = info;
    if (!info || info.x === null) {
      $('stPos').textContent = 'x: –  y: –';
      $('stValue').textContent = 'value: –';
      $('stWcs').textContent = '';
    } else {
      $('stPos').textContent = `x: ${info.x.toFixed(1)}  y: ${info.y.toFixed(1)}`;
      const v = info.value;
      $('stValue').textContent = 'value: ' + (Number.isFinite(v) ? formatValue(v) : 'NaN');
      $('stWcs').textContent = formatCoord(info);
    }
    panels.drawMagnifier(info);
    panels.drawPixelTable(info);
    if (info && info.inside) overlays.setCursor(info.ix, info.iy);
    plots.setCursor(info);
    updateStatus();
  };

  // Format the cursor coordinate per the selected system (DS9-like).
  function formatCoord(info) {
    const sys = $('coordSys').value;
    if (sys === 'image') return `image  ${info.x.toFixed(2)}  ${info.y.toFixed(2)}`;
    if (!info.sky) return '';
    if (sys === 'galactic') {
      const g = WCS.eq2gal(info.sky.ra, info.sky.dec);
      return `gal  l ${g.l.toFixed(4)}  b ${g.b.toFixed(4)}`;
    }
    if (sys === 'fk5deg') return `fk5  ${info.sky.ra.toFixed(5)}  ${info.sky.dec.toFixed(5)}`;
    return `fk5  α ${WCS.fmtRA(info.sky.ra)}  δ ${WCS.fmtDec(info.sky.dec)}`;
  }
  $('coordSys').addEventListener('change', () => {
    if (lastReadout && lastReadout.x !== null) $('stWcs').textContent = formatCoord(lastReadout);
  });

  function formatValue(v) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-3) return v.toExponential(4);
    return Number.isInteger(v) ? String(v) : v.toFixed(4);
  }

  function updateStatus() {
    $('stZoom').textContent = `zoom: ${viewer.zoom >= 1
      ? viewer.zoom.toFixed(2) + '×' : '1/' + (1 / viewer.zoom).toFixed(1) + '×'}`;
    $('stLimits').textContent = `low/high: ${formatValue(viewer.low)} / ${formatValue(viewer.high)}`;
  }

  function syncLimitInputs() {
    $('lowInput').value = Number(viewer.low.toPrecision(6));
    $('highInput').value = Number(viewer.high.toPrecision(6));
  }

  // ---- frames ----
  // Each loaded file is a DS9-style "frame" holding its own HDUs, view, scale
  // and regions. Switching frames saves the active state and restores the next.
  let frames = [];
  let activeFrame = null;
  let lockFrames = false;     // share scale/colormap/pan-zoom across frames
  let blinkTimer = null;
  let wcsAlign = null;        // captured sky centre for WCS-aligned frame lock
  let tableState = null;      // { hdus, hdu, name } for the current binary table

  // Align the view to a captured sky position/scale (WCS lock). Returns false
  // when alignment isn't possible (then the caller keeps the pixel-shared view).
  function applyWcsAlign(newWcs) {
    if (!wcsAlign || !newWcs || !newWcs.skyToPix) return false;
    const p = newWcs.skyToPix(wcsAlign.ra, wcsAlign.dec);   // FITS pixel
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    const o = viewer._orient(p.x - 0.5, p.y - 0.5);
    viewer.cx = o.vx; viewer.cy = o.vy;
    if (newWcs.pixscale) viewer.zoom = wcsAlign.zoom * (wcsAlign.scale / newWcs.pixscale);
    viewer.draw();
    return true;
  }

  function snapshotState() {
    return { zoom: viewer.zoom, cx: viewer.cx, cy: viewer.cy,
      scale: viewer.scale, limitMode: viewer.limitMode, cmap: viewer.cmap,
      invert: viewer.invert, low: viewer.low, high: viewer.high,
      contrast: viewer.contrast, bias: viewer.bias, lockScale: viewer.lockScale };
  }
  function saveActiveFrame() {
    if (!activeFrame) return;
    if (currentHdu) activeFrame.hduIndex = currentHdu.index;
    activeFrame.plane = currentPlane;
    activeFrame.state = snapshotState();
    activeFrame.regions = regions.list;
    activeFrame.regionSel = regions.selected;
  }
  function applyStateToControls(st) {
    $('scaleSelect').value = st.scale;
    $('limitSelect').value = st.limitMode;
    $('cmapSelect').value = st.cmap;
    $('invertChk').checked = st.invert;
    $('lockChk').checked = st.lockScale;
  }
  function initViewerFromControls() {
    viewer.scale = $('scaleSelect').value;
    viewer.limitMode = $('limitSelect').value === 'user' ? 'zscale' : $('limitSelect').value;
    if ($('limitSelect').value === 'user') $('limitSelect').value = 'zscale';
    viewer.cmap = $('cmapSelect').value;
    viewer.invert = $('invertChk').checked;
    viewer.lockScale = $('lockChk').checked;
  }
  function populateHduSelect() {
    const sel = $('hduSelect');
    sel.innerHTML = '';
    hdus.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h.index;
      opt.disabled = !h.isImage;
      const dim = h.depth > 1 ? `${h.width}×${h.height}×${h.depth}` : `${h.width}×${h.height}`;
      opt.textContent = `#${h.index} ${h.type}` +
        (h.isImage ? ` (${dim}, BITPIX ${h.bitpix})` : ' [no image]');
      sel.appendChild(opt);
    });
    sel.disabled = false;
  }

  // ---- file loading: each file becomes a new frame ----
  function loadArrayBuffer(buf, name) {
    let parsed;
    try { parsed = FITS.parse(buf); }
    catch (err) { alert('FITS の解析に失敗しました: ' + err.message); return; }
    const imageHdus = parsed.filter(h => h.isImage);
    const tableHdus = parsed.filter(h => h.isTable && h.columns && h.columns.some(c => c.numeric));
    if (!imageHdus.length && !tableHdus.length) { alert('表示可能な画像 HDU / テーブルが見つかりませんでした。'); return; }
    if (imageHdus.length) {
      saveActiveFrame();
      const frame = { type: 'image', name, hdus: parsed, hduIndex: imageHdus[0].index,
        plane: 0, state: null, regions: [], regionSel: null };
      frames.push(frame);
      activateFrame(frame);
    }
    if (tableHdus.length) setupTableBar(tableHdus, name);
    else $('tablebar').classList.add('hidden');
  }

  // ---- binary tables / event data ----
  function setupTableBar(tableHdus, name) {
    tableState = { hdus: tableHdus, hdu: tableHdus[0], name };
    const sel = $('tableHduSel'); sel.innerHTML = '';
    tableHdus.forEach((h, i) => { const o = document.createElement('option'); o.value = i; o.textContent = `#${h.index} (${h.nrows} rows)`; sel.appendChild(o); });
    sel.value = 0;
    populateTableCols(tableHdus[0]);
    $('tablebar').classList.remove('hidden');
  }
  function populateTableCols(hdu) {
    tableState.hdu = hdu;
    const numCols = hdu.columns.filter(c => c.numeric);
    const fill = (id, preferred) => {
      const s = $(id); s.innerHTML = '';
      numCols.forEach(c => { const o = document.createElement('option'); o.value = c.name; o.textContent = c.name + (c.unit ? ` [${c.unit}]` : ''); s.appendChild(o); });
      const m = preferred && numCols.find(c => c.name.toUpperCase() === preferred);
      if (m) s.value = m.name;
    };
    fill('tableX', 'X'); fill('tableY', 'Y'); fill('tableCol');
    if (!numCols.some(c => c.name.toUpperCase() === 'X') && numCols[0]) $('tableX').value = numCols[0].name;
    if (!numCols.some(c => c.name.toUpperCase() === 'Y') && numCols[1]) $('tableY').value = numCols[1].name;
    $('tableInfo').textContent = `${hdu.nrows} rows, ${hdu.columns.length} cols`;
  }
  function buildEventImage(hdu, xName, yName) {
    const X = hdu.readColumn(xName), Y = hdu.readColumn(yName);
    if (!X || !Y) return null;
    const xc = hdu.columns.find(c => c.name === xName), yc = hdu.columns.find(c => c.name === yName);
    let xmin = xc.tlmin, xmax = xc.tlmax, ymin = yc.tlmin, ymax = yc.tlmax;
    if (xmin == null || xmax == null) { xmin = Infinity; xmax = -Infinity; for (const v of X) { if (v < xmin) xmin = v; if (v > xmax) xmax = v; } }
    if (ymin == null || ymax == null) { ymin = Infinity; ymax = -Infinity; for (const v of Y) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; } }
    const TARGET = 512;
    const rangeX = (xmax - xmin) || 1, rangeY = (ymax - ymin) || 1;
    const block = Math.max(rangeX, rangeY) / TARGET || 1;
    const W = Math.max(1, Math.ceil(rangeX / block)), H = Math.max(1, Math.ceil(rangeY / block));
    const data = new Float64Array(W * H);
    for (let i = 0; i < X.length; i++) {
      const cx = Math.floor((X[i] - xmin) / block), cy = Math.floor((Y[i] - ymin) / block);
      if (cx >= 0 && cx < W && cy >= 0 && cy < H) data[cy * W + cx]++;
    }
    let min = Infinity, max = -Infinity; for (const v of data) { if (v < min) min = v; if (v > max) max = v; }
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    return { width: W, height: H, data, min, max };
  }
  function makeImageFrameFromImage(img, name) {
    const pseudo = { index: 0, isImage: true, isTable: false, type: 'IMAGE',
      width: img.width, height: img.height, depth: 1, bitpix: -64, naxis: 2, columns: null,
      header: { map: { NAXIS: 2, NAXIS1: img.width, NAXIS2: img.height, BITPIX: -64 }, cards: ['(binned event image)'] },
      loadImage: () => img, readColumn: () => null };
    saveActiveFrame();
    const frame = { type: 'image', name, hdus: [pseudo], hduIndex: 0, plane: 0, state: null, regions: [], regionSel: null };
    frames.push(frame);
    activateFrame(frame);
  }
  function doTableBin() {
    if (!tableState) return;
    const img = buildEventImage(tableState.hdu, $('tableX').value, $('tableY').value);
    if (!img) { alert('ビニングに失敗しました（数値列を選択してください）'); return; }
    makeImageFrameFromImage(img, `${tableState.name} [${$('tableX').value}×${$('tableY').value}]`);
  }
  $('tableHduSel').addEventListener('change', e => populateTableCols(tableState.hdus[+e.target.value]));
  $('tableBin').addEventListener('click', doTableBin);
  $('tablePlotCol').addEventListener('click', () => {
    if (!tableState) return;
    const name = $('tableCol').value, v = tableState.hdu.readColumn(name);
    if (v) plots.columnHistogram(v, name);
  });

  function activateFrame(frame) {
    stopPlay();
    activeFrame = frame;
    regions.list = frame.regions;
    regions.selected = frame.regionSel || null;
    $('headerBtn').disabled = false;
    $('plotBtn').disabled = false;

    if (frame.type === 'rgb') activateRGBFrame(frame);
    else if (frame.type === '3d') activate3DFrame(frame);
    else activateImageFrame(frame);
    $('proj3d').classList.toggle('hidden', frame.type !== '3d');

    overlays.invalidate();
    syncLimitInputs();
    updateStatus();
    $('canvasWrap').classList.add('has-image');
    document.title = `${frame.name} — DS9 Web Viewer`;
    renderRegionList();
    updateFrameBar();
    viewer.draw();
  }

  function activateImageFrame(frame) {
    viewer.mode = 'image';
    hdus = frame.hdus;
    populateHduSelect();
    $('hduSelect').disabled = false;
    currentHdu = hdus[frame.hduIndex] || hdus.find(h => h.isImage);
    currentPlane = frame.plane || 0;
    spectral = WCS.spectral(currentHdu.header.map);
    const image = currentHdu.loadImage(currentPlane);
    const wcs = WCS.build(currentHdu.header.map);
    $('hduSelect').value = currentHdu.index;

    if (frame.state && lockFrames) { viewer.swapImage(image, wcs); applyWcsAlign(wcs); }
    else if (frame.state) { viewer.restore(image, wcs, frame.state); applyStateToControls(frame.state); }
    else { initViewerFromControls(); viewer.setImage(image, wcs); }

    setupCube(currentHdu);
    $('stFile').textContent = `${frame.name}  —  ${hdus.filter(h => h.isImage).length} image HDU(s)`;
  }

  function activateRGBFrame(frame) {
    hdus = []; currentHdu = null; spectral = null;
    $('hduSelect').disabled = true; $('cubeBar').classList.add('hidden');
    viewer.scale = $('scaleSelect').value;
    viewer.setRGB(frame.channels, frame.wcs);
    if (frame.state) { viewer.zoom = frame.state.zoom; viewer.cx = frame.state.cx; viewer.cy = frame.state.cy; viewer.draw(); }
    $('stFile').textContent = `${frame.name}  —  RGB (R/G/B channels)`;
  }

  function activate3DFrame(frame) {
    hdus = []; currentHdu = null; spectral = null;
    $('hduSelect').disabled = true; $('cubeBar').classList.add('hidden');
    viewer.mode = '3d';
    viewer.scale = $('scaleSelect').value;
    viewer.cmap = $('cmapSelect').value;
    viewer.invert = $('invertChk').checked;
    if (frame.view3d) viewer.view3d = frame.view3d;
    viewer.setVolume(frame.vol, frame.wcs);
    if (frame.state) { viewer.zoom = frame.state.zoom; viewer.cx = frame.state.cx; viewer.cy = frame.state.cy; viewer.draw(); }
    const vol = frame.vol;
    $('stFile').textContent = `${frame.name}  —  3D MIP ${vol.w}×${vol.h}×${vol.d}（ドラッグで回転）`;
  }

  // Build a volume (Float32, index z*w*h + y*w + x) from a cube image HDU.
  function buildVolume(hdu) {
    const w = hdu.width, h = hdu.height, d = hdu.depth;
    const data = new Float32Array(w * h * d);
    let min = Infinity, max = -Infinity;
    for (let z = 0; z < d; z++) {
      const pl = hdu.loadImage(z);
      data.set(pl.data, z * w * h);
      if (pl.min < min) min = pl.min;
      if (pl.max > max) max = pl.max;
    }
    return { data, w, h, d, min, max };
  }
  function make3DFrame(vol, wcs, name) {
    saveActiveFrame();
    const frame = { type: '3d', name, vol, wcs, view3d: { yaw: 0.6, pitch: 0.5 },
      state: null, regions: [], regionSel: null };
    frames.push(frame);
    activateFrame(frame);
  }
  $('new3d').addEventListener('click', () => {
    if (currentHdu && currentHdu.depth > 1) make3DFrame(buildVolume(currentHdu), null, activeFrame.name + ' 3D');
    else create3DFromDemo().catch(() => alert('3D 化できるキューブがありません（demo の読み込みにも失敗）'));
  });
  async function create3DFromDemo() {
    const buf = await fetch('samples/cube.fits').then(r => r.arrayBuffer());
    const hdu = FITS.parse(buf).find(h => h.isImage);
    make3DFrame(buildVolume(hdu), null, 'cube 3D');
  }
  $('proj3d').addEventListener('change', e => {
    viewer.view3d.method = e.target.value;
    viewer._render3D(); viewer.draw();
  });

  function gotoFrameIndex(i) {
    if (!frames.length) return;
    i = (i % frames.length + frames.length) % frames.length;
    const target = frames[i];
    if (target === activeFrame) return;
    // capture sky centre of the current view for WCS-aligned lock
    wcsAlign = null;
    if (lockFrames && viewer.wcs && viewer.wcs.skyToPix) {
      const ctr = viewer.screenToImage(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2);
      const s = viewer.wcs(ctr.ix + 0.5, ctr.iy + 0.5);
      wcsAlign = { ra: s.ra, dec: s.dec, zoom: viewer.zoom, scale: viewer.wcs.pixscale };
    }
    saveActiveFrame();
    activateFrame(target);
  }
  function deleteActiveFrame() {
    if (!activeFrame) return;
    const i = frames.indexOf(activeFrame);
    frames.splice(i, 1);
    activeFrame = null;
    if (frames.length) activateFrame(frames[Math.min(i, frames.length - 1)]);
    else {
      regions.clear();
      viewer.image = null; viewer.draw();
      $('canvasWrap').classList.remove('has-image');
      $('stFile').textContent = 'no file';
      $('cubeBar').classList.add('hidden');
      updateFrameBar();
    }
  }
  function updateFrameBar() {
    const tabs = $('frameTabs');
    tabs.innerHTML = '';
    frames.forEach((f, i) => {
      const tab = document.createElement('span');
      tab.className = 'ftab' + (f === activeFrame ? ' active' : '');
      const badge = f.type === 'rgb' ? 'RGB' : f.type === '3d' ? '3D' : null;
      tab.innerHTML = (badge ? `<span class="badge">${badge}</span>` : '') +
        `#${i + 1} ${shortName(f.name)}<span class="fclose" title="削除">×</span>`;
      tab.addEventListener('click', e => {
        if (e.target.classList.contains('fclose')) { stopBlink(); exitTile(); removeFrame(f); }
        else { stopBlink(); exitTile(); gotoFrameIndex(i); }
      });
      tabs.appendChild(tab);
    });
  }
  function shortName(n) { return n.length > 16 ? n.slice(0, 14) + '…' : n; }
  function removeFrame(f) {
    const i = frames.indexOf(f);
    if (i < 0) return;
    if (f === activeFrame) { deleteActiveFrame(); return; }
    frames.splice(i, 1);
    updateFrameBar();
  }

  // ---- blink ----
  function startBlink() {
    if (frames.length < 2) return;
    exitTile();
    $('frameBlink').classList.add('active');
    $('frameSingle').classList.remove('active');
    blinkTimer = setInterval(() => {
      gotoFrameIndex(frames.indexOf(activeFrame) + 1);
    }, 600);
  }
  function stopBlink() {
    if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null; }
    $('frameBlink').classList.remove('active');
    if (!viewer.tileMode) $('frameSingle').classList.add('active');
  }

  // ---- tile: render every frame into a grid ----
  function enterTile() {
    if (!frames.length) return;
    stopBlink();
    saveActiveFrame();
    viewer.tiles = frames.map((f, i) => {
      const hdu = f.hdus[f.hduIndex] || f.hdus.find(h => h.isImage);
      const img = hdu.loadImage(f.plane || 0);
      const st = f.state || snapshotState();
      const canvas = document.createElement('canvas');
      window.renderColormap(canvas, img, st);
      return { canvas, label: `#${i + 1} ${f.name}`, active: f === activeFrame };
    });
    viewer.tileMode = true;
    $('frameTile').classList.add('active');
    $('frameSingle').classList.remove('active');
    viewer.draw();
  }
  function exitTile() {
    if (!viewer.tileMode) return;
    viewer.tileMode = false;
    viewer.tiles = [];
    $('frameTile').classList.remove('active');
    $('frameSingle').classList.add('active');
    viewer.draw();
  }
  viewer.onTileClick = (idx) => {
    const f = frames[idx];
    exitTile();
    if (f && f !== activeFrame) gotoFrameIndex(idx);
  };

  // HDU change within the active frame (fresh display using current controls)
  function showHdu(index) {
    stopPlay();
    const hdu = hdus[index];
    if (!hdu || !hdu.isImage) return;
    currentHdu = hdu;
    if (activeFrame) activeFrame.hduIndex = index;
    spectral = WCS.spectral(hdu.header.map);
    currentPlane = hdu.depth > 1 ? Math.floor(hdu.depth / 2) : 0;

    const image = hdu.loadImage(currentPlane);
    if (!image) { alert('画像データの読み込みに失敗しました。'); return; }
    const wcs = WCS.build(hdu.header.map);

    initViewerFromControls();
    viewer.setImage(image, wcs);

    overlays.invalidate();
    setupCube(hdu);
    syncLimitInputs();
    updateStatus();
  }

  // ---- cube / velocity ----
  function setupCube(hdu) {
    const bar = $('cubeBar');
    if (hdu.depth <= 1) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const slider = $('cubeSlider');
    slider.min = 0;
    slider.max = hdu.depth - 1;
    slider.value = currentPlane;
    updateCubeLabel();
  }

  function updateCubeLabel() {
    if (!currentHdu || currentHdu.depth <= 1) return;
    $('cubeLabel').textContent = `ch ${currentPlane + 1}/${currentHdu.depth}`;
    $('cubeVel').textContent = spectral ? spectral.label(currentPlane) : '';
  }

  function setPlane(plane) {
    if (!currentHdu) return;
    plane = Math.max(0, Math.min(currentHdu.depth - 1, plane));
    if (plane === currentPlane && viewer.image) return;
    currentPlane = plane;
    const image = currentHdu.loadImage(plane);
    viewer.setPlane(image);
    overlays.invalidate();
    $('cubeSlider').value = plane;
    updateCubeLabel();
    if (!viewer.lockScale) syncLimitInputs();
    updateStatus();
  }

  function stepPlane(d) { setPlane(currentPlane + d); }

  function startPlay() {
    if (!currentHdu || currentHdu.depth <= 1) return;
    $('cubePlay').classList.add('playing');
    playTimer = setInterval(() => {
      const next = currentPlane + 1 >= currentHdu.depth ? 0 : currentPlane + 1;
      setPlane(next);
    }, 150);
  }
  function stopPlay() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    $('cubePlay').classList.remove('playing');
  }
  function togglePlay() { playTimer ? stopPlay() : startPlay(); }

  $('cubeFirst').addEventListener('click', () => { stopPlay(); setPlane(0); });
  $('cubePrev').addEventListener('click', () => { stopPlay(); stepPlane(-1); });
  $('cubeNext').addEventListener('click', () => { stopPlay(); stepPlane(1); });
  $('cubeLast').addEventListener('click', () => { stopPlay(); setPlane(currentHdu.depth - 1); });
  $('cubePlay').addEventListener('click', togglePlay);
  $('cubeSlider').addEventListener('input', e => { stopPlay(); setPlane(+e.target.value); });

  // ---- frame controls ----
  $('framePrev').addEventListener('click', () => { stopBlink(); exitTile(); gotoFrameIndex(frames.indexOf(activeFrame) - 1); });
  $('frameNext').addEventListener('click', () => { stopBlink(); exitTile(); gotoFrameIndex(frames.indexOf(activeFrame) + 1); });
  $('frameDelete').addEventListener('click', () => { stopBlink(); exitTile(); deleteActiveFrame(); });
  $('frameSingle').addEventListener('click', () => { stopBlink(); exitTile(); });
  $('frameTile').addEventListener('click', () => { viewer.tileMode ? exitTile() : enterTile(); });
  $('frameBlink').addEventListener('click', () => { blinkTimer ? stopBlink() : startBlink(); });
  $('frameLock').addEventListener('change', e => {
    lockFrames = e.target.checked;
    if (lockFrames) saveActiveFrame();   // current view/scale becomes the shared one
  });

  // ---- RGB frames ----
  const rgbDraft = { red: null, green: null, blue: null };
  $('newRgb').addEventListener('click', () => $('rgbModal').classList.remove('hidden'));
  $('rgbClose').addEventListener('click', () => $('rgbModal').classList.add('hidden'));
  $('rgbModal').addEventListener('click', e => { if (e.target.id === 'rgbModal') $('rgbModal').classList.add('hidden'); });

  function parseFirstImage(buf) {
    const hs = FITS.parse(buf);
    const hdu = hs.find(h => h.isImage);
    return hdu ? { image: hdu.loadImage(0), wcs: WCS.build(hdu.header.map) } : null;
  }
  function setRgbChannel(ch, image, wcs, name) {
    const [lo, hi] = Scale.limits('zscale', image.data, image.min, image.max);
    rgbDraft[ch] = { image, wcs, low: lo, high: hi };
    document.querySelector(`.rgb-name[data-ch="${ch}"]`).textContent = name;
    document.querySelector(`.rgbLow[data-ch="${ch}"]`).value = Number(lo.toPrecision(6));
    document.querySelector(`.rgbHigh[data-ch="${ch}"]`).value = Number(hi.toPrecision(6));
  }
  document.querySelectorAll('.rgbFile').forEach(inp => {
    inp.addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      const ch = e.target.dataset.ch;
      const reader = new FileReader();
      reader.onload = () => { const r = parseFirstImage(reader.result); r ? setRgbChannel(ch, r.image, r.wcs, f.name) : alert('画像 HDU が見つかりません'); };
      reader.readAsArrayBuffer(f);
    });
  });
  function makeRgbFrame(channels, wcs, name) {
    saveActiveFrame();
    const frame = { type: 'rgb', name, channels, wcs, state: null, regions: [], regionSel: null };
    frames.push(frame);
    activateFrame(frame);
    $('rgbModal').classList.add('hidden');
  }
  $('rgbCreate').addEventListener('click', () => {
    const channels = {}; let ref = null, wcs = null;
    ['red', 'green', 'blue'].forEach(ch => {
      const d = rgbDraft[ch]; if (!d) return;
      const lo = parseFloat(document.querySelector(`.rgbLow[data-ch="${ch}"]`).value);
      const hi = parseFloat(document.querySelector(`.rgbHigh[data-ch="${ch}"]`).value);
      channels[ch] = { image: d.image, low: Number.isFinite(lo) ? lo : d.low, high: Number.isFinite(hi) ? hi : d.high };
      if (!ref) { ref = d.image; wcs = d.wcs; }
    });
    if (!ref) { alert('少なくとも1チャンネルにファイルを割り当ててください'); return; }
    makeRgbFrame(channels, wcs, 'rgb');
  });
  // demo: build an RGB from 3 velocity channels of the sample cube
  async function createDemoRGB() {
    const buf = await fetch('samples/cube.fits').then(r => r.arrayBuffer());
    const hdu = FITS.parse(buf).find(h => h.isImage);
    const wcs = WCS.build(hdu.header.map);
    const mk = pl => { const im = hdu.loadImage(pl); const [lo, hi] = Scale.limits('99.5', im.data, im.min, im.max); return { image: im, low: lo, high: hi }; };
    makeRgbFrame({ red: mk(6), green: mk(16), blue: mk(24) }, wcs, 'cube RGB');
  }
  $('rgbDemo').addEventListener('click', () => createDemoRGB().catch(() => alert('demo の読み込みに失敗')));

  // ---- scale / colormap controls ----
  $('hduSelect').addEventListener('change', e => showHdu(+e.target.value));

  $('scaleSelect').addEventListener('change', e => {
    viewer.scale = e.target.value; overlays.contour.segs = null;
    viewer.renderImage(); viewer.draw();
  });
  $('limitSelect').addEventListener('change', e => {
    if (e.target.value === 'user') return;             // user = keep manual values
    viewer.limitMode = e.target.value; viewer.recomputeLimits();
    overlays.contour.segs = null;
    viewer.renderImage(); viewer.draw(); syncLimitInputs(); updateStatus();
  });
  function applyManualLimits() {
    const lo = parseFloat($('lowInput').value), hi = parseFloat($('highInput').value);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
    viewer.low = lo; viewer.high = hi; viewer.limitMode = 'user';
    $('limitSelect').value = 'user';
    overlays.contour.segs = null;
    viewer.renderImage(); viewer.draw(); updateStatus();
  }
  $('lowInput').addEventListener('change', applyManualLimits);
  $('highInput').addEventListener('change', applyManualLimits);

  $('cmapSelect').addEventListener('change', e => {
    viewer.cmap = e.target.value; viewer.renderImage(); viewer.draw();
  });
  $('invertChk').addEventListener('change', e => {
    viewer.invert = e.target.checked; viewer.renderImage(); viewer.draw();
  });
  $('lockChk').addEventListener('change', e => { viewer.lockScale = e.target.checked; });

  $('zoomInBtn').addEventListener('click', () => { viewer.setZoom(1.3); updateStatus(); });
  $('zoomOutBtn').addEventListener('click', () => { viewer.setZoom(1/1.3); updateStatus(); });
  $('zoomFitBtn').addEventListener('click', () => { viewer.zoomFit(); viewer.draw(); updateStatus(); });
  $('zoom1Btn').addEventListener('click', () => { viewer.zoomTo(1); updateStatus(); });

  // ---- header modal ----
  $('headerBtn').addEventListener('click', () => {
    if (!currentHdu) return;
    $('headerText').textContent = currentHdu.header.cards.join('\n');
    $('headerModal').classList.remove('hidden');
  });
  $('headerClose').addEventListener('click', () => $('headerModal').classList.add('hidden'));
  $('headerModal').addEventListener('click', e => {
    if (e.target.id === 'headerModal') $('headerModal').classList.add('hidden');
  });

  // ---- file input + drag & drop ----
  function readFile(file) {
    const reader = new FileReader();
    reader.onload = () => loadArrayBuffer(reader.result, file.name);
    reader.onerror = () => alert('ファイルの読み込みに失敗しました。');
    reader.readAsArrayBuffer(file);
  }
  function readFileAsync(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result); r.onerror = rej;
      r.readAsArrayBuffer(file);
    });
  }
  // Open one or many files; each becomes a frame (then "tile" shows them all).
  async function openFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const f of files) {
      try { loadArrayBuffer(await readFileAsync(f), f.name); } catch (_) {}
    }
    if (files.length > 1) enterTile();    // multiple at once → show the tile
  }
  $('fileInput').addEventListener('change', e => openFiles(e.target.files));

  const wrap = $('canvasWrap');
  ['dragenter', 'dragover'].forEach(ev =>
    wrap.addEventListener(ev, e => { e.preventDefault(); wrap.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev =>
    wrap.addEventListener(ev, e => { e.preventDefault(); wrap.classList.remove('dragover'); }));
  wrap.addEventListener('drop', e => { if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files); });

  // wheel over the image steps cube channels (DS9-like cursor navigation)
  $('view').addEventListener('wheel', e => {
    if (e.shiftKey && currentHdu && currentHdu.depth > 1) {
      e.preventDefault(); stopPlay(); stepPlane(e.deltaY < 0 ? 1 : -1);
    }
  }, { passive: false });

  // keyboard: +/- zoom, f fit, arrows step channels
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (e.key === '+' || e.key === '=') { viewer.setZoom(1.3); updateStatus(); }
    else if (e.key === '-') { viewer.setZoom(1/1.3); updateStatus(); }
    else if (e.key === 'f') { viewer.zoomFit(); viewer.draw(); updateStatus(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { stopPlay(); stepPlane(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { stopPlay(); stepPlane(-1); }
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (regions.selected) { e.preventDefault(); regions.remove(regions.selected); }
    }
    else if (e.key === 'Escape') {
      regions._finishPoly(false);
      regions.setTool('pointer');
      document.querySelectorAll('#regionbar .rb-tools button').forEach(b =>
        b.classList.toggle('active', b.dataset.tool === 'pointer'));
    }
  });

  // ---- ?file=…&ch=… query for quick demos ----
  const params = new URLSearchParams(location.search);
  function applyOverlayParam() {
    const o = params.get('overlay'); if (!o) return;
    const set = o.split(',');
    if (set.includes('contour')) { $('ovContour').checked = true; overlays.contour.on = true; overlays.contour.segs = null; }
    if (set.includes('grid'))    { $('ovGrid').checked = true; overlays.grid.on = true; overlays.grid.lines = null; }
    if (set.includes('cross') && viewer.image) {
      $('ovCross').checked = true; overlays.cross.on = true;
      overlays.cross.ix = viewer.image.width * 0.5; overlays.cross.iy = viewer.image.height * 0.55;
    }
    viewer.draw();
  }
  function applyImageParam() {
    const s = params.get('smooth'), b = params.get('bin');
    if (s) { $('smoothChk').checked = true; viewer.smooth.on = true; viewer.smooth.radius = +s || 2; $('smoothRadius').value = viewer.smooth.radius; }
    if (b) { $('binSelect').value = b; viewer.binFactor = +b || 1; }
    if (s || b) { viewer.reprocess(); viewer.zoomFit(); overlays.invalidate(); syncLimitInputs(); updateStatus(); viewer.draw(); }
    const o = params.get('orient');
    if (o) {
      o.split(',').forEach(t => {
        if (t === 'flipx') viewer.orient.flipX = true;
        else if (t === 'flipy') viewer.orient.flipY = true;
        else if (t === 'rot90') viewer.orient.rot = 90;
        else if (t === 'rot180') viewer.orient.rot = 180;
        else if (t === 'rot270') viewer.orient.rot = 270;
      });
      viewer.zoomFit(); viewer.draw();
    }
  }
  const q = params.get('file');
  const framesParam = params.get('frames');
  if (params.get('rgb') === 'demo') createDemoRGB().catch(() => {});
  if (params.get('cube3d')) create3DFromDemo().then(() => {
    const m = params.get('proj3d');
    if (m) { $('proj3d').value = m; viewer.view3d.method = m; viewer._render3D(); viewer.draw(); }
  }).catch(() => {});
  if (framesParam) {
    (async () => {
      for (const u of framesParam.split(',')) {
        try { const buf = await fetch(u).then(r => r.arrayBuffer()); loadArrayBuffer(buf, u.split('/').pop()); }
        catch (_) {}
      }
      if (params.get('lock')) { $('frameLock').checked = true; lockFrames = true; saveActiveFrame(); }
      const fi = parseInt(params.get('frame'), 10);
      if (Number.isFinite(fi)) gotoFrameIndex(fi);
      if (params.get('tile')) enterTile();
    })();
  } else if (q) {
    fetch(q).then(r => r.arrayBuffer())
      .then(buf => {
        loadArrayBuffer(buf, q.split('/').pop());
        const ch = parseInt(params.get('ch'), 10);
        if (Number.isFinite(ch)) setPlane(ch);
        // ?probe=col,row simulates a cursor (for screenshot/testing)
        const probe = params.get('probe');
        if (probe) {
          const [c, r] = probe.split(',').map(Number);
          const s = viewer.imageToScreen(c + 0.5, r + 0.5);
          viewer._emitReadout(s.sx, s.sy);
        }
        // ?addregions=1 drops a demo set of regions (for screenshot/testing)
        if (params.get('addregions') && viewer.image) {
          const w = viewer.image.width, h = viewer.image.height, u = Math.min(w, h);
          regions.add({ type:'circle',  x:w*0.30, y:h*0.65, r:u*0.12, color:'green' });
          regions.add({ type:'ellipse', x:w*0.68, y:h*0.62, a:u*0.16, b:u*0.09, angle:0.5, color:'cyan' });
          regions.add({ type:'box',     x:w*0.50, y:h*0.30, w:u*0.22, h:u*0.14, angle:0.3, color:'yellow' });
          regions.add({ type:'line',    x1:w*0.15, y1:h*0.15, x2:w*0.45, y2:h*0.30, color:'red' });
          regions.add({ type:'point',   x:w*0.82, y:h*0.20, color:'magenta' });
          regions.add({ type:'polygon', pts:[{x:w*0.10,y:h*0.45},{x:w*0.25,y:h*0.40},{x:w*0.22,y:h*0.55},{x:w*0.08,y:h*0.58}], color:'orange' });
          regions.select(null);
          const sidx = parseInt(params.get('select'), 10);
          if (Number.isFinite(sidx) && regions.list[sidx]) regions.select(regions.list[sidx]);
        }
        if (params.get('tablebin') && tableState) doTableBin();
        const pc = params.get('plotcol');
        if (pc && tableState) { const v = tableState.hdu.readColumn(pc); if (v) plots.columnHistogram(v, pc); }
        applyImageParam();
        applyOverlayParam();
        const plotType = params.get('plot');
        if (plotType) { $('plotType').value = plotType; plots.show(); }
      })
      .catch(() => {});
  }

  window.app = { viewer, panels, regions };   // for debugging / tests
})();
