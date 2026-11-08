/* D4h Tanabe-Sugano page: controls, sweep requests and the 1D cut plot. Conventions: TS_D4h/PLAN.md.
   Sweeps run in ts-d4h/worker.js (falls back to the main thread; ?sync forces it, for headless checks). */
(function () {
  'use strict';
  var TS = window.TSD4h;
  var COLORS = ['#a62e40', '#2a78d6', '#1baf7a'];      // highest spin of the d^n first; validated on all pairs
  var SPIN = { 1: 'Singlets', 2: 'Doublets', 3: 'Triplets', 4: 'Quartets', 5: 'Quintets', 6: 'Sextets' };
  var INK = '#3a3a3a', GRID = '#e9e9e9', RULE = '#d9d9d9';
  var PARENT_MIN = 0.75;                                 // show an Oh parent only above this weight
  var DEF = { n: 2, cb: 4.5, rs: 0, rt: 0, dq: 4, pts: 301, emax: 80, x: 'delta', gs: 1, lab: 1, hide: [],
              mode: 'ts', cq: 2, cs: 1, ct: 0.6, u: 'B', bcm: 800 };

  function $(id) { return document.getElementById(id); }
  var sync = /[?&]sync\b/.test(location.search), useWorker = !sync && typeof Worker !== 'undefined';
  var worker = null, busy = false, reqId = 0, pending = null, last = null, timer = null;

  // ---------------------------------------------------------------- labels
  function termHTML(mult, irrep) {                       // 4, 'T1g' -> <sup>4</sup>T<sub>1g</sub>
    return '<sup>' + mult + '</sup>' + irrep.charAt(0) + '<sub>' + irrep.slice(1) + '</sub>';
  }
  function parseKey(key) {                               // '4T1g#2' -> {mult, irrep, rank}
    var m = /^(\d+)([A-Z]\d?g)#(\d+)$/.exec(key);
    return { mult: +m[1], irrep: m[2], rank: +m[3] };
  }
  function counter(keys) {                               // how many levels share each (mult, irrep)
    var c = {};
    keys.forEach(function (k) { var p = parseKey(k), id = p.mult + p.irrep; c[id] = Math.max(c[id] || 0, p.rank); });
    return c;
  }
  function keyHTML(key, counts) {
    var p = parseKey(key);
    return termHTML(p.mult, p.irrep) + (counts[p.mult + p.irrep] > 1 ? ' (' + p.rank + ')' : '');
  }
  function keyText(key, counts) {                        // plain text for CSV headers: 4T1g(2)
    var p = parseKey(key);
    return p.mult + p.irrep + (counts[p.mult + p.irrep] > 1 ? '(' + p.rank + ')' : '');
  }
  function cfgHTML(names, occ) {
    var s = [];
    occ.forEach(function (o, i) { if (o) s.push(names[i] + '<sup>' + o + '</sup>'); });
    return s.join(' ') || 'empty shell';
  }
  var D4_ORB = ['b<sub>2g</sub>', 'e<sub>g</sub>', 'a<sub>1g</sub>', 'b<sub>1g</sub>'], OH_ORB = ['t<sub>2g</sub>', 'e<sub>g</sub>'];

  // ---------------------------------------------------------------- state <-> controls <-> URL hash
  function readHash() {
    var s = JSON.parse(JSON.stringify(DEF));
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var p = kv.split('='), k = p[0], v = decodeURIComponent(p[1] || '');
      if (!(k in s)) return;
      if (k === 'x') s.x = v === 'dq' ? 'dq' : 'delta';
      else if (k === 'mode') s.mode = v === 'corr' ? 'corr' : 'ts';
      else if (k === 'u') s.u = v === 'cm' ? 'cm' : 'B';
      else if (k === 'hide') s.hide = v ? v.split(',').map(Number) : [];
      else if (k === 'emax' && v === '') s.emax = '';
      else if (isFinite(+v)) s[k] = +v;
    });
    s.n = Math.min(9, Math.max(1, Math.round(s.n)));
    return s;
  }
  function toControls(s) {
    $('ts-n').value = s.n; $('ts-cb').value = s.cb; $('ts-rs').value = s.rs; $('ts-rt').value = s.rt;
    $('ts-dq').value = s.dq; $('ts-pts').value = s.pts; $('ts-emax').value = s.emax; $('ts-x').value = s.x;
    $('ts-gs').checked = !!s.gs; $('ts-lab').checked = !!s.lab;
    $('ts-mode').value = s.mode; $('ts-cq').value = s.cq; $('ts-cs').value = s.cs; $('ts-ct').value = s.ct;
    $('ts-u').value = s.u; $('ts-bcm').value = s.bcm;
    modeUI(s.mode);
  }
  function modeUI(mode) {
    document.querySelectorAll('.ts-only').forEach(function (e) { e.hidden = mode !== 'ts'; });
    document.querySelectorAll('.corr-only').forEach(function (e) { e.hidden = mode !== 'corr'; });
  }
  function num(id, def, lo, hi) {
    var v = parseFloat($(id).value);
    if (!isFinite(v)) return def;
    return Math.min(hi === undefined ? Infinity : hi, Math.max(lo === undefined ? -Infinity : lo, v));
  }
  function fromControls(prev) {
    var emax = $('ts-emax').value.trim() === '' ? '' : num('ts-emax', 80, 1);
    var n = +$('ts-n').value;
    return {
      n: n, cb: num('ts-cb', 4.5, 0), rs: num('ts-rs', 0), rt: num('ts-rt', 0), dq: num('ts-dq', 4, 0.1, 50),
      pts: Math.round(num('ts-pts', 301, 21, 2001)), emax: emax, x: $('ts-x').value, gs: $('ts-gs').checked ? 1 : 0,
      lab: $('ts-lab').checked ? 1 : 0, hide: prev && prev.n === n ? prev.hide : [],
      mode: $('ts-mode').value, cq: num('ts-cq', 2, 0), cs: num('ts-cs', 1), ct: num('ts-ct', 0.6), u: $('ts-u').value,
      bcm: num('ts-bcm', 800, 1)
    };
  }
  // the hash is shared with the 3D section (surf.js): each writer replaces only its own keys
  function setHash(own, parts) {
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      if (kv && own.indexOf(kv.split('=')[0]) < 0) parts.push(kv);
    });
    if (history.replaceState) history.replaceState(null, '', parts.length ? '#' + parts.join('&') : location.pathname + location.search);
  }
  function writeHash(s) {
    var parts = [];
    Object.keys(DEF).forEach(function (k) {
      var v = k === 'hide' ? s.hide.join(',') : s[k];
      if (String(v) !== String(k === 'hide' ? DEF.hide.join(',') : DEF[k])) parts.push(k + '=' + encodeURIComponent(v));
    });
    setHash(Object.keys(DEF), parts);
  }

  // ---------------------------------------------------------------- sweep requests
  function request(s) {
    if (s.mode === 'corr') {                             // a in [0, 1] runs tau = 2a - 1 from -1 to 1
      return {
        id: ++reqId, n: s.n, CB: s.cb, map: TS.maps.line({ Dq: s.cq, Ds: -s.cs, Dt: -s.ct }, { Dq: s.cq, Ds: s.cs, Dt: s.ct }),
        a: [0, 1, s.pts], opts: { parents: true, cfg: true, subtractGround: !!s.gs }
      };
    }
    return {
      id: ++reqId, n: s.n, CB: s.cb, map: TS.maps.ratioCut(s.rs, s.rt), a: [0, s.dq, s.pts],
      opts: { parents: true, cfg: true, subtractGround: !!s.gs, oh: s.rs === 0 && s.rt === 0 }
    };
  }
  function status(t, cls) { var e = $('ts-status'); e.textContent = t; e.className = 'ss-status' + (cls ? ' ' + cls : ''); }

  function makeWorker() {
    var w = new Worker('ts-d4h/worker.js?v=4');
    w.onmessage = function (ev) {
      var m = ev.data;
      if (m.id !== reqId) return;                        // superseded
      if (m.type === 'progress') { status('Computing ' + Math.round(100 * m.done / m.total) + ' %'); return; }
      busy = false;
      if (m.type === 'error') { status('Error: ' + m.message.split('\n')[0], 'bad'); return; }
      draw(m, pending);
    };
    w.onerror = function () {                            // e.g. file:// pages cannot start workers
      w.terminate(); worker = null; busy = false; useWorker = false; run();
    };
    return w;
  }

  function run() {
    var s = fromControls(last && last.s);
    writeHash(s);
    var req = request(s);
    pending = s;
    if (!useWorker) {
      try { draw(TS.sweep(req), s); } catch (e) { status('Error: ' + e.message, 'bad'); }
      return;
    }
    if (busy && worker) { worker.terminate(); worker = null; }
    worker = worker || makeWorker();
    busy = true;
    status('Computing.');
    worker.postMessage(req);
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 150); }

  // ---------------------------------------------------------------- plot
  function curves(res) {
    var np = res.np, out = [];
    if (res.ohNames) {
      var oc = counter(res.ohNames);
      res.ohNames.forEach(function (nm, h) {
        var p = parseKey(nm), y = res.ohE.subarray(h * np, (h + 1) * np), cd = new Array(np);
        for (var t = 0; t < np; t++) {
          cd[t] = cfgHTML(OH_ORB, res.ohCfgList[res.ohCfg[h * np + t]]) + ' (' + res.ohCfgW[h * np + t].toFixed(2) + ')';
        }
        out.push({ key: nm, mult: p.mult, html: keyHTML(nm, oc), txt: keyText(nm, oc), y: y, cd: cd });
      });
      return out;
    }
    var sc = counter(res.surfaces.map(function (S) { return S.key; }));
    res.surfaces.forEach(function (S) {
      var y = res.E.subarray(S.row * np, (S.row + 1) * np), cd = new Array(np);
      for (var t = 0; t < np; t++) {
        var i = S.row * np + t;
        cd[t] = cfgHTML(D4_ORB, res.cfgList[res.cfg[i]]) + ' (' + res.cfgW[i].toFixed(2) + ')';
      }
      out.push({ key: S.key, mult: S.mult, html: keyHTML(S.key, sc), txt: keyText(S.key, sc), y: y, cd: cd });
    });
    return out;
  }

  function spinToggles(mults, s) {
    var box = $('ts-spins');
    box.innerHTML = '';
    mults.forEach(function (m, i) {
      var lab = document.createElement('label'), cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = s.hide.indexOf(m) < 0;
      cb.addEventListener('change', function () {
        var h = last.s.hide.filter(function (x) { return x !== m; });
        if (!cb.checked) h.push(m);
        last.s.hide = h; writeHash(last.s); render();
      });
      var sw = document.createElement('span');
      sw.className = 'sw'; sw.style.background = COLORS[i];
      lab.appendChild(cb); lab.appendChild(sw); lab.appendChild(document.createTextNode(SPIN[m] || m + '-plets'));
      box.appendChild(lab);
    });
  }

  function draw(res, s) {
    var cv = curves(res), mults = [];
    cv.forEach(function (c) { if (mults.indexOf(c.mult) < 0) mults.push(c.mult); });
    mults.sort(function (a, b) { return b - a; });
    last = { res: res, s: s, cv: cv, mults: mults };
    spinToggles(mults, s);
    render();
    status('d' + res.n + (s.mode === 'corr' ? ', correlation at Dq/B = ' + s.cq : '') + ', ' + res.np + ' points, ' + cv.length +
           ' curves' + (res.ohNames ? ' (Oh levels)' : ''), 'ok');
  }

  function render() {
    var res = last.res, s = last.s, cv = last.cv, mults = last.mults, np = res.np;
    // units: energies (and the TS x axis) times B in cm-1 mode; Plotly titles do not decode entities, so use \u
    var cm = s.u === 'cm', yu = cm ? s.bcm : 1, corr = s.mode === 'corr', xs = new Array(np), xf = s.x === 'dq' ? 1 : 10, xname, xhov, ename;
    for (var t = 0; t < np; t++) xs[t] = corr ? 2 * res.a[t] - 1 : xf * yu * res.a[t];
    if (corr) { xname = 'distortion τ (Ds, Dt = τ × right-end values)'; xhov = 'τ = %{x:.3f}'; }
    else {
      xname = (s.x === 'dq' ? 'Dq' : 'Δ') + (cm ? ' (cm⁻¹)' : '/B');
      xhov = xname.replace(/ \(cm.*\)/, '') + ' = %{x:' + (cm ? '.0f}' : '.2f}') + (cm ? ' cm⁻¹' : '');
    }
    ename = cm ? 'E (cm⁻¹' + (s.gs ? ', from the ground state)' : ')') : (s.gs ? 'E/B (from the ground state)' : 'E/B');
    var ehov = cm ? 'E = %{y:.0f} cm⁻¹' : 'E/B = %{y:.2f}';
    var seen = {}, traces = [], ymin = Infinity, ymax = -Infinity;
    cv.forEach(function (c) {
      var mi = mults.indexOf(c.mult), on = s.hide.indexOf(c.mult) < 0, y = new Array(np);
      for (var t = 0; t < np; t++) y[t] = c.y[t] * yu;
      var tr = {
        type: 'scatter', mode: 'lines', x: xs, y: y, name: c.html,
        legendgroup: 'm' + c.mult, line: { color: COLORS[mi], width: 2 }, customdata: c.cd, visible: on,
        hovertemplate: '<b>' + c.html + '</b><br>' + ehov + '<br>' + xhov + '<br>%{customdata}<extra></extra>'
      };
      if (!seen[c.mult]) { tr.legendgrouptitle = { text: SPIN[c.mult] || '' }; seen[c.mult] = 1; }
      traces.push(tr);
      if (on) for (t = 0; t < np; t++) { ymin = Math.min(ymin, y[t]); ymax = Math.max(ymax, y[t]); }
    });
    if (!isFinite(ymin)) { ymin = 0; ymax = 1; }
    var top = s.emax === '' ? ymax : s.emax * yu, pad = 0.02 * (top - ymin || 1);
    var yr = [ymin - pad, top + pad];
    // phone width: no Plotly legend (the spin toggles above carry the colours, the end labels the terms)
    var gd = $('ts-plot'), narrow = (gd.clientWidth || window.innerWidth) < 600, H = narrow ? 500 : 620;
    var mg = narrow ? { l: 50, r: s.lab ? 62 : 10, t: 16, b: 50 } : { l: 64, r: 10, t: 16, b: 54 };
    var layout = {
      height: H, margin: mg, paper_bgcolor: '#fff', plot_bgcolor: '#fff', showlegend: !narrow,
      font: { family: 'Lato, Segoe UI, Helvetica, Arial, sans-serif', size: narrow ? 12 : 13, color: INK },
      xaxis: { title: { text: xname }, range: [xs[0], xs[np - 1]], gridcolor: GRID, linecolor: RULE, zeroline: false, ticks: 'outside', tickcolor: RULE },
      yaxis: { title: { text: ename }, range: yr, gridcolor: GRID, linecolor: RULE, zeroline: false, ticks: 'outside', tickcolor: RULE },
      legend: { x: 1.09, xanchor: 'left', y: 1, yanchor: 'top', font: { size: 12 }, groupclick: 'toggleitem', tracegroupgap: 8 },
      hovermode: 'closest', hoverlabel: { bgcolor: '#fff', bordercolor: RULE, font: { color: INK, size: 12 } },
      annotations: s.lab ? labels(traces, yr, H - mg.t - mg.b) : []
    };
    wasNarrow = narrow;
    function vline(x, text) {
      layout.shapes = [{ type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1, line: { color: INK, width: 1, dash: 'dot' } }];
      layout.annotations.push({ xref: 'x', yref: 'paper', x: x, y: 1, yanchor: 'top', xanchor: 'left', xshift: 3, text: text,
                                showarrow: false, bgcolor: '#fff', font: { size: 11, color: INK } });
    }
    if (corr) vline(0, 'O<sub>h</sub>');
    else if (cutMark && cutMark.rs === s.rs && cutMark.rt === s.rt && cutMark.dq <= s.dq) vline(xf * yu * cutMark.dq, cutMark.text);
    Plotly.react(gd, traces, layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] });
    if (!gd._tsBound) {                                  // legend clicks change visibility: relabel
      gd._tsBound = true;
      gd.on('plotly_restyle', function () {
        if (!last.s.lab) return;
        var L = gd.layout, keep = (L.annotations || []).filter(function (a) { return a.xref === 'x'; });
        Plotly.relayout(gd, { annotations: labels(gd.data, L.yaxis.range, L.height - L.margin.t - L.margin.b).concat(keep) });
      });
    }
    window.TSPage = { res: res, s: s, traces: traces, keys: cv.map(function (c) { return c.key; }), narrow: narrow };
  }
  var wasNarrow = null;

  // ---------------------------------------------------------------- export (what is drawn, in the units shown)
  function g10(x) { return String(+x.toPrecision(10)); }
  function cutCSV() {
    var res = last.res, s = last.s, np = res.np, f = s.u === 'cm' ? s.bcm : 1, un = s.u === 'cm' ? ' (cm-1)' : '/B';
    var gd = $('ts-plot'), on = last.cv.filter(function (c, i) { return gd.data[i] && gd.data[i].visible === true; });
    var head = (s.mode === 'corr' ? ['tau'] : []).concat(['Dq' + un, 'Ds' + un, 'Dt' + un], on.map(function (c) {
      return 'E(' + c.txt + ')' + (s.gs ? ' from ground' : '');
    }));
    var rows = [head.join(',')];
    for (var t = 0; t < np; t++) {
      var a = res.a[t], tau = 2 * a - 1, fld = s.mode === 'corr' ? [s.cq, tau * s.cs, tau * s.ct] : [a, s.rs * a, s.rt * a];
      var r = (s.mode === 'corr' ? [g10(tau)] : []).concat(fld.map(function (x) { return g10(x * f); }), on.map(function (c) { return g10(c.y[t] * f); }));
      rows.push(r.join(','));
    }
    return rows.join('\n') + '\n';
  }
  function saveText(name, text) {
    var a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
  }
  function savePNG(gd, name) { return Plotly.downloadImage(gd, { format: 'png', filename: name, scale: 2 }); }
  // orthographic 3D scenes are sized by their aspect ratio: about 0.776 x ratio x height px; keep the box within
  // ~80 % of the plot width (phones; the axis titles need the rest), up to the desktop value
  function orthoScale(gd, H, kmax) { var W = gd.clientWidth || window.innerWidth; return Math.min(kmax, 0.8 * W / (0.776 * H)); }
  function units() { var cm = $('ts-u').value === 'cm'; return { cm: cm, B: cm ? num('ts-bcm', 800, 1) : 1 }; }
  // axis name in B ('Ds/B') -> its form in the units shown; ratios (Dt/Dq) and s, t are unchanged
  function axis(name, U) {
    var byB = U.cm && /\/B$/.test(name), base = name.replace(/\/B$/, '');
    return { text: byB ? base + ' (cm⁻¹)' : name, f: byB ? U.B : 1,
             hov: function (v) { return byB ? base + ' = %{' + v + ':.0f} cm⁻¹' : name + ' = %{' + v + ':.2f}'; },
             fmt: function (x, d) { return byB ? (x * U.B).toFixed(1) : x.toFixed(d); } };
  }
  function eAxis(U, gs) {
    return { text: U.cm ? 'E (cm⁻¹' + (gs ? ', from the ground state)' : ')') : (gs ? 'E/B (from the ground state)' : 'E/B'),
             hov: function (v) { return U.cm ? 'E = %{' + v + ':.0f} cm⁻¹' : 'E/B = %{' + v + ':.2f}'; },
             fmt: function (x, d) { return U.cm ? (x * U.B).toFixed(1) + ' cm⁻¹' : x.toFixed(d); } };
  }

  // direct labels at the right end of every visible curve, pushed apart to 13 px
  function labels(traces, yr, hpx) {
    var gap = 13 * (yr[1] - yr[0]) / hpx, items = [];
    traces.forEach(function (tr) {
      if (tr.visible !== true && tr.visible !== undefined) return;
      var y = tr.y[tr.y.length - 1];
      if (y >= yr[0] && y <= yr[1]) items.push({ y: y, text: tr.name });
    });
    items.sort(function (a, b) { return a.y - b.y; });
    for (var i = 1; i < items.length; i++) items[i].y = Math.max(items[i].y, items[i - 1].y + gap);
    if (items.length && items[items.length - 1].y > yr[1]) {
      items[items.length - 1].y = yr[1];
      for (i = items.length - 2; i >= 0; i--) items[i].y = Math.min(items[i].y, items[i + 1].y - gap);
    }
    return items.filter(function (it) { return it.y >= yr[0] - 1e-9; }).map(function (it) {
      return { xref: 'paper', x: 1, xanchor: 'left', xshift: 4, yref: 'y', y: it.y, text: it.text, showarrow: false,
               font: { size: 11, color: INK } };
    });
  }

  window.TSFmt = {                                       // shared with surf.js
    COLORS: COLORS, SPIN: SPIN, INK: INK, GRID: GRID, RULE: RULE, PARENT_MIN: PARENT_MIN, D4_ORB: D4_ORB,
    termHTML: termHTML, parseKey: parseKey, counter: counter, keyHTML: keyHTML, keyText: keyText, cfgHTML: cfgHTML, setHash: setHash,
    units: units, axis: axis, orthoScale: orthoScale, eAxis: eAxis, g10: g10, saveText: saveText, savePNG: savePNG
  };
  window.TSExport = { cut: cutCSV };                     // surf.js and gmap.js add theirs

  // open the fixed-ratio cut through (Dq, Ds, Dt) in this section and mark Dq (used by the ground-state map)
  var cutMark = null;
  function toTop() { var sec = $('ts-cut'); if (sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  window.TSCut = {
    open: function (Dq, Ds, Dt, text) {
      if (!(Dq > 0)) return false;
      var rs = +(Ds / Dq).toFixed(4), rt = +(Dt / Dq).toFixed(4);
      $('ts-mode').value = 'ts'; modeUI('ts');
      $('ts-rs').value = rs; $('ts-rt').value = rt;
      if (Dq > num('ts-dq', 4, 0.1, 50)) $('ts-dq').value = Math.ceil(Dq * 1.25 * 2) / 2;
      cutMark = { rs: rs, rt: rt, dq: Dq, text: text || 'point from the map' };
      run(); toTop();
      return true;
    },
    corr: function (Dq, Ds, Dt) {                        // correlation diagram whose right end is (Dq, Ds, Dt)
      $('ts-mode').value = 'corr'; modeUI('corr');
      $('ts-cq').value = +Dq.toFixed(4); $('ts-cs').value = +Ds.toFixed(4); $('ts-ct').value = +Dt.toFixed(4);
      run(); toTop();
      return true;
    }
  };

  // ---------------------------------------------------------------- AOM panel (trans-MA4L2, L on z)
  function aom() {
    var u = $('aom-u').value === 'cm' ? num('ts-bcm', 800, 1) : 1;
    var e = ['aom-se', 'aom-pe', 'aom-sa', 'aom-pa'].map(function (id) { return num(id, 0) / u; });
    var f = TS.aomToCF(e[0], e[1], e[2], e[3]), o = TS.orbitalEnergies(f.Dq, f.Ds, f.Dt), bcm = num('ts-bcm', 800, 1);
    function both(x) { return x.toFixed(3) + ' B (' + Math.round(x * bcm) + ' cm⁻¹)'; }
    $('aom-out').textContent = 'Dq = ' + both(f.Dq) + ', Ds = ' + both(f.Ds) + ', Dt = ' + both(f.Dt) + '.  Orbital energies from the barycenter: ' +
      ['b1g', 'a1g', 'b2g', 'eg'].map(function (k) { return k + ' ' + (o[k] >= 0 ? '+' : '') + o[k].toFixed(2) + ' B'; }).join(', ') +
      (f.Dq > 0 ? '' : '  (Dq must be positive for a cut)');
    $('aom-out').className = 'ss-status' + (f.Dq > 0 ? '' : ' bad');
    var parts = [];
    Object.keys(AOMK).forEach(function (k) { var v = $(AOMK[k]).value; if (String(v) !== String(AOMD[k])) parts.push(k + '=' + encodeURIComponent(v)); });
    setHash(Object.keys(AOMK), parts);
    return f;
  }
  var AOMK = { ase: 'aom-se', ape: 'aom-pe', asa: 'aom-sa', apa: 'aom-pa', au: 'aom-u' };
  var AOMD = { ase: 6000, ape: 1000, asa: 4000, apa: 500, au: 'cm' };
  function aomFromHash() {                               // AOM values in the hash also open the panel
    var any = false;
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var p = kv.split('='), k = p[0], v = decodeURIComponent(p[1] || '');
      if (!(k in AOMK)) return;
      if (k === 'au') { if (v !== 'cm' && v !== 'B') return; }
      else if (!isFinite(parseFloat(v))) return;
      $(AOMK[k]).value = v; any = true;
    });
    if (any) $('aom').open = true;
  }

  // ---------------------------------------------------------------- wiring
  function init() {
    if (!window.Plotly) { status('Plotly did not load (it comes from a CDN, so an internet connection is needed).', 'bad'); return; }
    toControls(readHash());
    ['ts-n', 'ts-cb', 'ts-rs', 'ts-rt', 'ts-dq', 'ts-pts', 'ts-emax', 'ts-x', 'ts-gs', 'ts-lab', 'ts-cq', 'ts-cs', 'ts-ct',
     'ts-u', 'ts-bcm'].forEach(function (id) {
      $(id).addEventListener(['ts-n', 'ts-x', 'ts-gs', 'ts-lab', 'ts-u'].indexOf(id) >= 0 ? 'change' : 'input', schedule);
    });
    $('ts-mode').addEventListener('change', function () { modeUI($('ts-mode').value); run(); });
    $('ts-oh').addEventListener('click', function () {
      $('ts-mode').value = 'ts'; modeUI('ts'); $('ts-rs').value = 0; $('ts-rt').value = 0; run();
    });
    ['aom-se', 'aom-pe', 'aom-sa', 'aom-pa', 'aom-u', 'ts-bcm'].forEach(function (id) { $(id).addEventListener('input', aom); });
    $('aom-u').addEventListener('change', aom);
    $('aom-ts').addEventListener('click', function () { var f = aom(); window.TSCut.open(f.Dq, f.Ds, f.Dt, 'AOM point'); });
    $('aom-corr').addEventListener('click', function () { var f = aom(); if (f.Dq > 0) window.TSCut.corr(f.Dq, f.Ds, f.Dt); });
    window.TSAom = aom;
    aomFromHash();
    aom();
    function fname(ext) { var s = last.s; return 'd' + s.n + '_' + (s.mode === 'corr' ? 'correlation' : 'cut') + ext; }
    $('ts-csv').addEventListener('click', function () { if (last && last.res) saveText(fname('.csv'), cutCSV()); });
    $('ts-png').addEventListener('click', function () { if (last && last.res) savePNG($('ts-plot'), fname('')); });
    window.addEventListener('resize', function () {
      if (last && last.res && ($('ts-plot').clientWidth < 600) !== wasNarrow) render();
    });
    var h = readHash();
    last = { s: h };                                    // carries the hidden spins into the first run
    run();
  }
  init();
})();
