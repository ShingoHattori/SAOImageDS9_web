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

  // ---- regions ----
  const regions = new Regions(viewer, { onChange: renderRegionList });

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

  // ---- file loading ----
  function loadArrayBuffer(buf, name) {
    let parsed;
    try { parsed = FITS.parse(buf); }
    catch (err) { alert('FITS の解析に失敗しました: ' + err.message); return; }
    hdus = parsed;
    const imageHdus = hdus.filter(h => h.isImage);
    if (!imageHdus.length) { alert('表示可能な画像 HDU が見つかりませんでした。'); return; }

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
    $('headerBtn').disabled = false;

    sel.value = imageHdus[0].index;
    showHdu(imageHdus[0].index);

    $('stFile').textContent = name + `  —  ${imageHdus.length} image HDU(s)`;
    $('canvasWrap').classList.add('has-image');
    document.title = `${name} — DS9 Web Viewer`;
  }

  function showHdu(index) {
    stopPlay();
    const hdu = hdus[index];
    if (!hdu || !hdu.isImage) return;
    currentHdu = hdu;
    spectral = WCS.spectral(hdu.header.map);
    // start a cube near the middle so a spectral line is likely in view
    currentPlane = hdu.depth > 1 ? Math.floor(hdu.depth / 2) : 0;

    const image = hdu.loadImage(currentPlane);
    if (!image) { alert('画像データの読み込みに失敗しました。'); return; }
    const wcs = WCS.build(hdu.header.map);

    viewer.scale = $('scaleSelect').value;
    viewer.limitMode = $('limitSelect').value === 'user' ? 'zscale' : $('limitSelect').value;
    if ($('limitSelect').value === 'user') $('limitSelect').value = 'zscale';
    viewer.cmap = $('cmapSelect').value;
    viewer.invert = $('invertChk').checked;
    viewer.lockScale = $('lockChk').checked;
    viewer.setImage(image, wcs);

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

  // ---- scale / colormap controls ----
  $('hduSelect').addEventListener('change', e => showHdu(+e.target.value));

  $('scaleSelect').addEventListener('change', e => {
    viewer.scale = e.target.value; viewer.renderImage(); viewer.draw();
  });
  $('limitSelect').addEventListener('change', e => {
    if (e.target.value === 'user') return;             // user = keep manual values
    viewer.limitMode = e.target.value; viewer.recomputeLimits();
    viewer.renderImage(); viewer.draw(); syncLimitInputs(); updateStatus();
  });
  function applyManualLimits() {
    const lo = parseFloat($('lowInput').value), hi = parseFloat($('highInput').value);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
    viewer.low = lo; viewer.high = hi; viewer.limitMode = 'user';
    $('limitSelect').value = 'user';
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
  $('fileInput').addEventListener('change', e => { if (e.target.files[0]) readFile(e.target.files[0]); });

  const wrap = $('canvasWrap');
  ['dragenter', 'dragover'].forEach(ev =>
    wrap.addEventListener(ev, e => { e.preventDefault(); wrap.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev =>
    wrap.addEventListener(ev, e => { e.preventDefault(); wrap.classList.remove('dragover'); }));
  wrap.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });

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
  const q = params.get('file');
  if (q) {
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
      })
      .catch(() => {});
  }

  window.app = { viewer, panels, regions };   // for debugging / tests
})();
