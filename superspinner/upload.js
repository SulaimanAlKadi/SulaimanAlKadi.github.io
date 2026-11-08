/* SuperSpinner: analyse your own spectrum.
   JavaScript ports of the package's file readers (Bruker BES3T .DSC/.DTA, Bruker ESP/WinEPR
   .par/.spc, two-column text) feeding the shared engine in demo.js. Files are read in the
   browser and never leave it. */
(function () {
  'use strict';
  var root = document.getElementById('ss-upload');
  if (!root || !window.SuperSpinner) return;
  var SS = window.SuperSpinner;
  var $ = function (s) { return root.querySelector(s); };
  var drop = $('#up-drop'), fileIn = $('#up-files'), nuIn = $('#up-nu'), maIn = $('#up-ma'), unitSel = $('#up-unit'), nucSel = $('#up-nuc');
  var ttaChk = $('#up-tta'), runBtn = $('#up-run'), statusEl = $('#up-status'), canvas = $('#up-canvas'), noteEl = $('#up-note');
  var fitChk = $('#up-fit'), table = $('#up-table tbody'), notesEl = $('#up-notes'), esText = $('#up-es-text'), copyBtn = $('#up-copy'), esBox = $('#up-es');
  var spec = null, last = null, rawFiles = null;
  function status(t, cls) { statusEl.textContent = t; statusEl.className = 'ss-status' + (cls ? ' ' + cls : ''); }

  // ------------------------------------------------------------------ readers
  function parseKeyValues(text, bes3t) {
    var p = {};
    text.split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      if (bes3t && /^[#*.\x1a]/.test(line)) return;
      var m = line.match(/^([A-Za-z0-9_]+)\s+(.*)$/); if (!m) return;
      var k = m[1], v = m[2].trim();
      if (v.length > 1 && v[0] === "'" && v[v.length - 1] === "'") v = v.slice(1, -1);
      else if (/^[-+0-9.eE]+$/.test(v) && !isNaN(parseFloat(v))) v = parseFloat(v);
      p[k] = v;
    });
    return p;
  }
  function readArray(buffer, fmt, little) {
    var dv = new DataView(buffer), size = { f8: 8, f4: 4, i4: 4, i2: 2, i1: 1 }[fmt], n = Math.floor(buffer.byteLength / size), out = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var o = i * size;
      out[i] = fmt === 'f8' ? dv.getFloat64(o, little) : fmt === 'f4' ? dv.getFloat32(o, little) : fmt === 'i4' ? dv.getInt32(o, little) : fmt === 'i2' ? dv.getInt16(o, little) : dv.getInt8(o);
    }
    return out;
  }
  function loadBES3T(dscText, dtaBuf, xgfBuf) {
    var p = parseKeyValues(dscText, true);
    var fmt = { D: 'f8', F: 'f4', I: 'i4', S: 'i2', C: 'i1' }[String(p.IRFMT || 'D')] || 'f8';
    var little = !String(p.BSEQ || 'BIG').toUpperCase().startsWith('BIG');
    var raw = readArray(dtaBuf, fmt, little);
    var xpts = parseInt(p.XPTS || raw.length, 10), ypts = parseInt(p.YPTS || 1, 10) || 1;
    var cplx = String(p.IKKF || 'REAL').toUpperCase().startsWith('CPLX');
    if (cplx) { var re = new Float64Array(Math.floor(raw.length / 2)); for (var i = 0; i < re.length; i++) re[i] = raw[2 * i]; raw = re; }
    var B;
    if (String(p.XTYP || 'IDX').toUpperCase() === 'IGD') {
      if (!xgfBuf) throw new Error('this file has a non-linear field axis; drop the .XGF file as well');
      B = readArray(xgfBuf, 'f8', little);
    } else {
      var xmin = +p.XMIN || 0, xwid = +p.XWID || 1; B = new Float64Array(xpts);
      for (var k = 0; k < xpts; k++) B[k] = xmin + xwid * k / Math.max(xpts - 1, 1);
    }
    var xunit = String(p.XUNI || 'G').replace(/'/g, '').toUpperCase();
    var B_mT = Array.from(B).map(function (b) { return xunit.startsWith('G') ? b / 10 : (xunit === 'T' ? b * 1000 : b); });
    var y = ypts > 1 ? Array.from(raw.slice(0, xpts)) : Array.from(raw);
    if (y.length !== B_mT.length) { var n = Math.min(y.length, B_mT.length); y = y.slice(0, n); B_mT = B_mT.slice(0, n); }
    var nu = p.MWFQ != null ? +p.MWFQ / 1e9 : null, ma = p.B0MA != null ? +p.B0MA * 1000 : null;
    return { B_mT: B_mT, y: y, nu_GHz: nu, modamp_mT: ma, title: String(p.TITL || ''), params: p, kind: 'Bruker BES3T' };
  }
  function loadESP(parText, spcBuf) {
    var p = {};
    parText.split(/\r?\n/).forEach(function (line) { var m = line.trim().match(/^(\S+)\s+(.*)$/); if (m) { var v = m[2].trim(); p[m[1]] = /^[-+0-9.eE]+$/.test(v) && !isNaN(parseFloat(v)) ? parseFloat(v) : v; } });
    var dos = ('DOS' in p) || /DOS/.test(String(p.DOS || ''));
    var y = Array.from(readArray(spcBuf, dos ? 'f4' : 'i4', dos));
    var n = y.length, B = new Array(n), k;
    if ('GST' in p && 'GSI' in p) for (k = 0; k < n; k++) B[k] = +p.GST + (+p.GSI) * k / Math.max(n - 1, 1);
    else { var c = +(p.HCF != null ? p.HCF : (p.GST || 0)), sw = +(p.HSW != null ? p.HSW : (p.GSI || 0)); for (k = 0; k < n; k++) B[k] = c - sw / 2 + sw * k / Math.max(n - 1, 1); }
    return { B_mT: B.map(function (b) { return b / 10; }), y: y, nu_GHz: typeof p.MF === 'number' ? p.MF : null, modamp_mT: typeof p.RMA === 'number' ? p.RMA / 10 : null, params: p, kind: 'Bruker ESP/WinEPR' };
  }
  function loadASCII(text, unit) {
    var rows = [], nu = null;
    text.split(/\r?\n/).forEach(function (line) {
      var s = line.trim(); if (!s) return;
      if (nu == null) { var m = s.match(/(?:MWFQ|freq\w*)\D*([0-9.]+(?:e[+-]?\d+)?)/i); if (m) { var v = parseFloat(m[1]); nu = v > 1e6 ? v / 1e9 : (v > 1e3 ? v / 1e3 : v); } }
      var toks = s.split(/[,\s;\t]+/).filter(function (t) { return t !== ''; }), vals = [];
      for (var i = 0; i < toks.length; i++) { var f = Number(toks[i]); if (!isFinite(f)) return; vals.push(f); }
      if (vals.length >= 2) rows.push(vals);
    });
    if (!rows.length) throw new Error('no numeric rows found in the text file');
    var B = rows.map(function (r) { return r[0]; }), y = rows.map(function (r) { return r[1]; });
    var bmax = Math.max.apply(null, B), u = (unit || '').toUpperCase();
    if (!u) u = bmax > 1500 ? 'G' : (bmax < 3 ? 'T' : 'MT');
    return { B_mT: B.map(function (b) { return u === 'G' ? b / 10 : (u === 'T' ? b * 1000 : b); }), y: y, nu_GHz: nu, modamp_mT: null, kind: 'text (' + (u === 'MT' ? 'mT' : u) + ')' };
  }
  function readFile(f, asText) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(new Error('could not read ' + f.name)); }; if (asText) r.readAsText(f, 'latin1'); else r.readAsArrayBuffer(f); }); }

  async function ingest(files) {
    rawFiles = files;
    var byExt = {}; files.forEach(function (f) { var m = f.name.match(/\.([^.]+)$/); byExt[(m ? m[1] : '').toLowerCase()] = f; });
    var s;
    if (byExt.dsc && byExt.dta) s = loadBES3T(await readFile(byExt.dsc, true), await readFile(byExt.dta, false), byExt.xgf ? await readFile(byExt.xgf, false) : null);
    else if (byExt.par && byExt.spc) s = loadESP(await readFile(byExt.par, true), await readFile(byExt.spc, false));
    else if (byExt.dsc || byExt.dta) throw new Error('Bruker BES3T needs both the .DSC and the .DTA file; drop them together');
    else if (byExt.par || byExt.spc) throw new Error('Bruker ESP needs both the .par and the .spc file; drop them together');
    else if (byExt.mat) throw new Error('.mat is not supported in the browser; export the field and spectrum as two-column text');
    else s = loadASCII(await readFile(files[0], true), unitSel.value);
    s.name = files.map(function (f) { return f.name; }).join(' + ');
    spec = s; last = null;
    if (s.nu_GHz) nuIn.value = s.nu_GHz.toFixed(5);
    if (s.modamp_mT) maIn.value = s.modamp_mT.toFixed(3);
    var bmin = Math.min.apply(null, s.B_mT), bmax = Math.max.apply(null, s.B_mT);
    status(s.name + ': ' + s.kind + ', ' + s.B_mT.length + ' points, ' + bmin.toFixed(1) + '–' + bmax.toFixed(1) + ' mT' +
      (s.nu_GHz ? ', ν = ' + s.nu_GHz.toFixed(4) + ' GHz' : ', frequency not in file: enter it below') + (s.modamp_mT ? ', ModAmp ' + s.modamp_mT.toFixed(3) + ' mT' : '') + '.');
    runBtn.disabled = false;
  }
  function handleFiles(list) {
    var files = Array.from(list || []); if (!files.length) return;
    ingest(files).catch(function (e) { status('Could not read the file: ' + e.message, 'bad'); runBtn.disabled = true; spec = null; });
  }
  fileIn.addEventListener('change', function () { handleFiles(fileIn.files); fileIn.value = ''; });
  var chooseBtn = $('#up-choose'), exampleBtn = $('#up-example');
  if (chooseBtn) chooseBtn.addEventListener('click', function () { fileIn.click(); });
  drop.addEventListener('click', function (e) { if (e.target === fileIn) return; fileIn.click(); });
  if (exampleBtn) exampleBtn.addEventListener('click', function () {
    status('Loading the example…');
    fetch('superspinner/example_CuII.txt').then(function (r) { if (!r.ok) throw new Error('example file not found'); return r.text(); })
      .then(function (text) { return ingest([new File([text], 'example_CuII.txt', { type: 'text/plain' })]); })
      .catch(function (e) { status('Could not load the example: ' + e.message, 'bad'); });
  });
  ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hot'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hot'); }); });
  drop.addEventListener('drop', function (e) { handleFiles(e.dataTransfer.files); });
  unitSel.addEventListener('change', function () { if (rawFiles) handleFiles(rawFiles); });

  // nucleus choices from the model's class list
  function fillNuclei() {
    var m = SS.meta(); if (!m || nucSel.options.length > 1) return;
    m.nuc_names.forEach(function (n) { if (n === 'none') return; var o = document.createElement('option'); o.value = n; o.textContent = n; nucSel.appendChild(o); });
  }

  // ------------------------------------------------------------------ analyse
  async function analyse() {
    if (!spec) return;
    var nu = parseFloat(nuIn.value);
    if (!(nu > 1 && nu < 400)) { status('Enter the microwave frequency in GHz.', 'bad'); nuIn.focus(); return; }
    runBtn.disabled = true;
    try {
      if (!SS.isReady()) await SS.load(status);
      fillNuclei();
      status('Analyzing…');
      var s = { B_mT: spec.B_mT, y: spec.y, nu_GHz: nu };
      var ma = parseFloat(maIn.value), opt = { tta: ttaChk.checked ? 8 : 1, modamp: ma > 0 ? ma : 0, hintNuc: nucSel.value || null };
      var res = await SS.predict(s, opt);
      var fit = SS.reconstruct(res.pr, nu, ma > 0 ? ma : 0.1);
      last = { pre: res.pre, pr: res.pr, fit: fit, nu: nu };
      render();
      status('Done: ' + res.pr.passes + ' forward pass' + (res.pr.passes > 1 ? 'es' : '') + ' in ' + res.pr.ms.toFixed(0) + ' ms. Nothing left your browser.', 'ok');
    } catch (e) {
      console.error(e); status('Analysis failed: ' + (e && e.message || e), 'bad');
    } finally { runBtn.disabled = false; }
  }
  function pm(v, s, d) { return v.toFixed(d) + ' ± ' + s.toFixed(d); }
  function render() {
    if (!last) return;
    var pr = last.pr, m = SS.meta(), i, tr = [];
    SS.renderPlot(canvas, last.pre, pr, last.fit, fitChk.checked);
    var pn = pr.nucP[pr.nucIdx];
    tr.push('<tr><th>Center</th><td>' + pr.nucName + (pr.hinted ? ' (given)' : ' (' + Math.round(100 * pn) + '%)') + '</td></tr>');
    tr.push('<tr><th>Family</th><td>' + pr.famName + ' (' + Math.round(100 * Math.max.apply(null, pr.famP)) + '%)</td></tr>');
    for (i = 0; i < 3; i++) tr.push('<tr><th>g<sub>' + (i + 1) + '</sub></th><td>' + pm(pr.g[i], pr.gs[i], 4) + ' <span class="src">' + pr.gsrc[i] + '</span></td></tr>');
    if (pr.nucName !== 'none') for (i = 0; i < 3; i++) tr.push('<tr><th>A<sub>' + (i + 1) + '</sub> / MHz</th><td>' + pm(pr.A[i], pr.As[i], 0) + ' <span class="src">' + pr.asrc[i] + '</span></td></tr>');
    tr.push('<tr><th>FWHM Gaussian / Lorentzian, mT</th><td>' + pr.lwG.toFixed(3) + ' / ' + pr.lwL.toFixed(3) + '</td></tr>');
    tr.push('<tr><th>g-strain</th><td>' + pr.gS.map(function (v) { return v.toFixed(4); }).join(', ') + '</td></tr>');
    tr.push('<tr><th>H-strain / MHz</th><td>' + pr.HS.map(function (v) { return v.toFixed(0); }).join(', ') + '</td></tr>');
    if (pr.nucName !== 'none') tr.push('<tr><th>A-strain / MHz</th><td>' + pr.AS.map(function (v) { return v.toFixed(0); }).join(', ') + '</td></tr>');
    if (pr.shfName !== 'none' && pr.nshf > 0 && Math.max.apply(null, pr.shfP) > 0.5) tr.push('<tr><th>Ligand superhyperfine</th><td>' + pr.nshf + ' × ' + pr.shfName + ' (' + Math.round(100 * Math.max.apply(null, pr.shfP)) + '%)</td></tr>');
    var imps = []; pr.imp.forEach(function (p, k) { if (p >= 0.3) imps.push(m.impurity_names[k] + ' (p = ' + p.toFixed(2) + ')'); });
    tr.push('<tr><th>Secondary species</th><td>' + (imps.length ? imps.join('; ') : 'none detected (max p = ' + Math.max.apply(null, pr.imp).toFixed(2) + ')') + '</td></tr>');
    tr.push('<tr><th>Estimated SNR</th><td>' + (pr.snr < 10 ? pr.snr.toFixed(1) : Math.round(pr.snr)) + '</td></tr>');
    tr.push('<tr><th>Confidence</th><td>grade ' + pr.quality.grade + '</td></tr>');
    table.innerHTML = tr.join('');
    notesEl.innerHTML = pr.quality.notes.length ? pr.quality.notes.map(function (n) { return '<div class="note">' + n + '</div>'; }).join('') : '<div class="note ok">No acquisition warnings.</div>';
    noteEl.textContent = (spec.name || '') + ' · window ' + ((SS.constants.B0 + last.pre.lo * SS.constants.DB) * last.nu / SS.constants.NU_REF).toFixed(1) + '–' + ((SS.constants.B0 + last.pre.hi * SS.constants.DB) * last.nu / SS.constants.NU_REF).toFixed(1) + ' mT · ' + Math.round(100 * last.pre.coverage) + '% of the canonical range covered';
    esText.textContent = SS.toEasySpin(pr);
    esBox.hidden = false;
  }
  runBtn.addEventListener('click', analyse);
  fitChk.addEventListener('change', render);
  window.addEventListener('resize', render);
  copyBtn.addEventListener('click', function () { navigator.clipboard && navigator.clipboard.writeText(esText.textContent).then(function () { copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500); }); });

  // self-test: demo.html?up=auto fetches a two-column test file given by &file= and analyses it
  var qs = new URLSearchParams(location.search);
  if (qs.get('up') === 'auto' && qs.get('file')) {
    fetch(qs.get('file')).then(function (r) { return r.text(); }).then(async function (text) {
      var f = new File([text], 'self_test.txt', { type: 'text/plain' });
      await ingest([f]); await analyse();
      var pr = last && last.pr; document.title = 'UP ' + (pr ? pr.nucName + ' ' + pr.g.map(function (v) { return v.toFixed(4); }).join('/') + ' A ' + pr.A.map(function (v) { return v.toFixed(0); }).join('/') + ' grade ' + pr.quality.grade + ' ' + pr.ms.toFixed(0) + 'ms' : 'FAILED ' + statusEl.textContent);
    }).catch(function (e) { document.title = 'UP FAILED ' + e.message; });
  }
})();
