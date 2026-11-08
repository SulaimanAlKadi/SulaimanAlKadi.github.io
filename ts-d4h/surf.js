/* D4h Tanabe-Sugano page, section 2: energy surfaces over a plane in (Dq, Ds, Dt), one Plotly surface per
   (2S+1, Gamma, k) state, with a toggle panel. d^n and C/B come from section 1 (app.js, which provides
   window.TSFmt). Sweeps run in their own worker so they never cancel the 1D cut. */
(function () {
  'use strict';
  var TS = window.TSD4h, F = window.TSFmt;
  function $(id) { return document.getElementById(id); }
  var sync = /[?&]sync\b/.test(location.search), useWorker = !sync && typeof Worker !== 'undefined';
  var worker = null, busy = false, reqId = 0, last = null, timer = null, sel = null, hashSel = null;

  // hash keys of this section (prefixed so they never collide with section 1)
  var PLANES = {
    dq: { q: 2, a: [-2, 2], b: [-1, 1], qn: 'Dq/B', an: 'Ds/B', bn: 'Dt/B' },
    ratio: { q: 0.3, a: [0.2, 4], b: [-0.5, 0.5], qn: 'Ds/Dq', an: 'Dq/B', bn: 'Dt/Dq' },
    custom: { an: 's (along u)', bn: 't (along v)' }
  };
  var DEF = { pl: 'dq', pq: '', pa0: '', pa1: '', pb0: '', pb1: '', po: '2,0,0', pu: '0,2,0', pv: '0,0,1', pg: 61, pz: '',
              pgs: 1, pgrp: 'spin', pN: 8, pci: 1, go: 0, psel: '', pop: 1 };

  function readHash() {
    var s = JSON.parse(JSON.stringify(DEF));
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var p = kv.split('='), k = p[0];
      if (k in s) s[k] = decodeURIComponent(p[1] || '');
    });
    if (!PLANES[s.pl]) s.pl = 'dq';
    return s;
  }
  function planeDefaults(pl) {
    var P = PLANES[pl];
    $('s3-q-name').textContent = P.qn || ''; $('s3-a-name').textContent = P.an; $('s3-b-name').textContent = P.bn;
    document.querySelectorAll('.s3-std').forEach(function (e) { e.hidden = pl === 'custom'; });
    document.querySelectorAll('.s3-cus').forEach(function (e) { e.hidden = pl !== 'custom'; });
    if (pl !== 'custom') {
      $('s3-q').value = P.q; $('s3-a0').value = P.a[0]; $('s3-a1').value = P.a[1]; $('s3-b0').value = P.b[0]; $('s3-b1').value = P.b[1];
    }
  }
  function toControls(s) {
    $('s3-plane').value = s.pl;
    planeDefaults(s.pl);
    [['pq', 's3-q'], ['pa0', 's3-a0'], ['pa1', 's3-a1'], ['pb0', 's3-b0'], ['pb1', 's3-b1']].forEach(function (m) {
      if (s[m[0]] !== '') $(m[1]).value = s[m[0]];
    });
    $('s3-o').value = s.po; $('s3-u').value = s.pu; $('s3-v').value = s.pv;
    $('s3-g').value = s.pg; $('s3-z').value = s.pz; $('s3-gs').checked = +s.pgs === 1; $('s3-grp').value = s.pgrp; $('s3-N').value = s.pN;
    $('s3-ci').checked = +s.pci === 1;
    $('s3-op').value = s.pop;
  }
  function num(id, def) { var v = parseFloat($(id).value); return isFinite(v) ? v : def; }
  function vec(id, def) {
    var v = $(id).value.split(/[\s,;]+/).filter(Boolean).map(Number);
    return v.length === 3 && v.every(isFinite) ? v : def;
  }
  function fromControls() {
    var pl = $('s3-plane').value, P = PLANES[pl];
    var s = {
      n: +$('ts-n').value, CB: num('ts-cb', 4.5), pl: pl, g: Math.round(Math.min(101, Math.max(11, num('s3-g', 61)))),
      op: Math.min(1, Math.max(0.2, num('s3-op', 1))),
      z: $('s3-z').value.trim() === '' ? '' : num('s3-z', ''), gs: $('s3-gs').checked, grp: $('s3-grp').value,
      N: Math.max(1, Math.round(num('s3-N', 8))), ci: $('s3-ci').checked
    };
    if (pl === 'custom') { s.o = vec('s3-o', [2, 0, 0]); s.u = vec('s3-u', [0, 2, 0]); s.v = vec('s3-v', [0, 0, 1]); }
    else { s.q = num('s3-q', P.q); s.a = [num('s3-a0', P.a[0]), num('s3-a1', P.a[1])]; s.b = [num('s3-b0', P.b[0]), num('s3-b1', P.b[1])]; }
    return s;
  }
  function writeHash(s) {
    var v = { pl: s.pl, pg: s.g, pz: s.z, pgs: s.gs ? 1 : 0, pgrp: s.grp, pN: s.N, pci: s.ci ? 1 : 0, go: 1, pop: s.op,
              psel: sel ? Object.keys(sel).sort().join(',') : hashSel || '' }, parts = [];
    if (s.pl === 'custom') { v.po = s.o.join(','); v.pu = s.u.join(','); v.pv = s.v.join(','); }
    else { v.pq = s.q; v.pa0 = s.a[0]; v.pa1 = s.a[1]; v.pb0 = s.b[0]; v.pb1 = s.b[1]; }
    Object.keys(v).forEach(function (k) { if (String(v[k]) !== String(DEF[k])) parts.push(k + '=' + encodeURIComponent(v[k])); });
    F.setHash(Object.keys(DEF), parts);
  }

  function plane(s) {                                    // grid coordinates -> field (worker.js map format)
    if (s.pl === 'dq') return { map: TS.maps.fixedDq(s.q), a: [s.a[0], s.a[1], s.g], b: [s.b[0], s.b[1], s.g] };
    if (s.pl === 'ratio') return { map: TS.maps.ratioPlane(s.q), a: [s.a[0], s.a[1], s.g], b: [s.b[0], s.b[1], s.g] };
    return { map: { Dq: [s.o[0], s.u[0], s.v[0], 0], Ds: [s.o[1], s.u[1], s.v[1], 0], Dt: [s.o[2], s.u[2], s.v[2], 0] },
             a: [0, 1, s.g], b: [0, 1, s.g] };
  }
  function request(s) {
    var p = plane(s);
    return { id: ++reqId, n: s.n, CB: s.CB, map: p.map, a: p.a, b: p.b, opts: { parents: true, cfg: true, subtractGround: s.gs, ci: s.ci } };
  }

  function status(t, cls) { var e = $('s3-status'); e.textContent = t; e.className = 'ss-status' + (cls ? ' ' + cls : ''); }
  function progress(f) { var p = $('s3-prog'); p.hidden = f === null; if (f !== null) p.value = f; }

  function makeWorker() {
    var w = new Worker('ts-d4h/worker.js?v=4');
    w.onmessage = function (ev) {
      var m = ev.data;
      if (m.id !== reqId) return;
      if (m.type === 'progress') { progress(m.done / m.total); status('Computing ' + Math.round(100 * m.done / m.total) + ' %'); return; }
      busy = false; progress(null);
      if (m.type === 'error') { status('Error: ' + m.message.split('\n')[0], 'bad'); return; }
      draw(m, w.pendingState);
    };
    w.onerror = function () { w.terminate(); worker = null; busy = false; useWorker = false; progress(null); run(); };
    return w;
  }

  function run() {
    var s = fromControls(), req = request(s);
    writeHash(s);
    if (!useWorker) {
      try { draw(TS.sweep(req), s); } catch (e) { status('Error: ' + e.message, 'bad'); }
      return;
    }
    if (busy && worker) { worker.terminate(); worker = null; }
    worker = worker || makeWorker();
    worker.pendingState = s;
    busy = true; progress(0); status('Computing.');
    worker.postMessage(req);
  }
  function schedule() { if (!last) return; clearTimeout(timer); timer = setTimeout(run, 300); }

  // ---------------------------------------------------------------- data -> surfaces
  function fieldAt(pl, a, b) {
    var m = pl.map;
    function at(c) { return c[0] + c[1] * a + c[2] * b + c[3] * a * b; }
    return { Dq: at(m.Dq), Ds: at(m.Ds), Dt: at(m.Dt) };
  }

  function draw(res, s) {
    var np = res.np, pl = plane(s), pc = F.counter(res.parentNames), sc = F.counter(res.surfaces.map(function (S) { return S.key; }));
    var near = 0, best = Infinity;                       // grid point closest to Ds = Dt = 0
    for (var ib = 0; ib < res.nb; ib++) for (var ia = 0; ia < res.na; ia++) {
      var f = fieldAt(pl, res.a[ia], res.b[ib]), d = Math.abs(f.Ds) + Math.abs(f.Dt);
      if (d < best - 1e-12) { best = d; near = ib * res.na + ia; }
    }
    var mults = [], groundSet = {};
    for (var t = 0; t < np; t++) groundSet[res.groundRow[t]] = 1;
    var surf = res.surfaces.map(function (S) {
      var lo = Infinity, hi = -Infinity, i0 = S.row * np;
      for (var t = 0; t < np; t++) { lo = Math.min(lo, res.E[i0 + t]); hi = Math.max(hi, res.E[i0 + t]); }
      if (mults.indexOf(S.mult) < 0) mults.push(S.mult);
      var pn = res.parentNames[res.parent[i0 + near]], pw = res.parentW[i0 + near];
      return { key: S.key, row: S.row, mult: S.mult, irrep: S.irrep, html: F.keyHTML(S.key, sc), min: lo, max: hi, ground: !!groundSet[S.row],
               parent: pn, parentHTML: F.keyHTML(pn, pc), parentW: pw };
    });
    mults.sort(function (x, y) { return y - x; });
    var prev = last && last.res.n === res.n ? sel : null;
    if (!last && hashSel) { prev = {}; hashSel.split(',').forEach(function (k) { prev[k] = 1; }); }
    hashSel = null;
    last = { res: res, s: s, surf: surf, mults: mults, pc: pc, sc: sc };
    sel = {};
    if (prev) surf.forEach(function (u) { if (prev[u.key]) sel[u.key] = 1; });
    if (!prev || !Object.keys(sel).length) lowest(s.N);
    else { buildList(); plot(); }
    status('d' + res.n + ', ' + res.na + ' x ' + res.nb + ' grid, ' + surf.length + ' surfaces' +
           (res.cis ? ', ' + res.cis.length + ' conical intersection' + (res.cis.length === 1 ? '' : 's') : ''), 'ok');
  }

  // ---------------------------------------------------------------- selection
  function lowest(N) {
    sel = {};
    last.surf.slice().sort(function (x, y) { return x.min - y.min; }).slice(0, N).forEach(function (u) { sel[u.key] = 1; });
    buildList(); plot();
  }
  function setSel(keys, on) { keys.forEach(function (k) { if (on) sel[k] = 1; else delete sel[k]; }); }

  function groups() {
    var by = last.s.grp, g = {}, order = [];
    last.surf.forEach(function (u) {
      var id = by === 'irrep' ? u.irrep : 'm' + u.mult;
      if (!g[id]) {
        var title = by === 'irrep' ? '&Gamma; = ' + u.irrep.charAt(0) + '<sub>' + u.irrep.slice(1) + '</sub>' : F.SPIN[u.mult];
        g[id] = { title: title, items: [], min: Infinity };
        order.push(id);
      }
      g[id].items.push(u); g[id].min = Math.min(g[id].min, u.min);
    });
    return order.map(function (id) { return g[id]; }).sort(function (x, y) { return by === 'irrep' ? x.min - y.min : 0; });
  }

  function buildList() {
    var box = $('s3-list'), html = [], gs = groups();
    gs.forEach(function (G, gi) {
      html.push('<fieldset><legend><label><input type="checkbox" data-g="' + gi + '"><span>' + G.title + ' <span class="gs">' + G.items.length + '</span></span></label></legend>');
      G.items.forEach(function (u) {
        var col = F.COLORS[last.mults.indexOf(u.mult)];
        html.push('<label title="min E/B ' + u.min.toFixed(2) + '"><input type="checkbox" data-k="' + u.key + '"' +
                  (sel[u.key] ? ' checked' : '') + '><span class="sw" style="background:' + col + '"></span><span>' + u.html +
                  (u.ground ? ' <span class="gs">ground</span>' : '') + '</span></label>');
      });
      html.push('</fieldset>');
    });
    box.innerHTML = html.join('');
    box._groups = gs;
    syncGroupBoxes();
  }
  function syncGroupBoxes() {
    var box = $('s3-list');
    box.querySelectorAll('input[data-g]').forEach(function (cb) {
      var items = box._groups[+cb.getAttribute('data-g')].items, on = items.filter(function (u) { return sel[u.key]; }).length;
      cb.checked = on === items.length; cb.indeterminate = on > 0 && on < items.length;
    });
  }

  // ---------------------------------------------------------------- plot
  // MATLAB surf / Desmos-style rendering: orthographic camera, opaque lit surfaces, each shaded dark -> light
  // along E within its spin hue (one shared energy scale), thin mesh lines, a clean box. Only the shown surfaces
  // become traces (the CI markers are the last trace).
  function mix(hex, to, t) {
    var a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16), out = '#';
    [16, 8, 0].forEach(function (sh) {
      var x = (a >> sh) & 255, y = (b >> sh) & 255;
      out += ('0' + Math.round(x + (y - x) * t).toString(16)).slice(-2);
    });
    return out;
  }
  function ramp(col) { return [[0, mix(col, '#000000', 0.1)], [1, mix(col, '#ffffff', 0.62)]]; }
  function mesh(v, n) {                                  // contour lines every k grid steps, about 12 per axis
    var k = Math.max(1, Math.round((n - 1) / 12)), step = (v[n - 1] - v[0]) / (n - 1);
    return { start: v[0], end: v[n - 1] + 1e-9 * Math.abs(step), size: k * step };
  }
  function plot() {
    var res = last.res, s = last.s, np = res.np, na = res.na, nb = res.nb, P = PLANES[s.pl];
    var U = F.units(), A = F.axis(P.an, U), Bx = F.axis(P.bn, U), Ez = F.eAxis(U, s.gs), f = U.B, traces = [];
    var xs = Array.prototype.map.call(res.a, function (x) { return x * A.f; }), ys = Array.prototype.map.call(res.b, function (x) { return x * Bx.f; });
    var shown = last.surf.filter(function (u) { return sel[u.key]; }), cap = s.z === '' ? Infinity : s.z;
    var lo = Math.min.apply(null, last.surf.map(function (u) { return u.min; }));
    var hi = Math.min(cap, Math.max.apply(null, shown.length ? shown.map(function (u) { return u.max; }) : [lo + 1]));
    var mx = mesh(xs, na), my = mesh(ys, nb), op = +s.op;
    shown.forEach(function (u) {
      var col = F.COLORS[last.mults.indexOf(u.mult)], line = mix(col, '#000000', 0.45), z = [], cd = [], i0 = u.row * np;
      for (var ib = 0; ib < nb; ib++) {
        var zr = new Array(na), cr = new Array(na);
        for (var ia = 0; ia < na; ia++) {
          var i = i0 + ib * na + ia, e = res.E[i];
          zr[ia] = e * f;
          cr[ia] = F.cfgHTML(F.D4_ORB, res.cfgList[res.cfg[i]]) + ' (' + res.cfgW[i].toFixed(2) + ')';
        }
        z.push(zr); cd.push(cr);
      }
      traces.push({
        type: 'surface', uid: 's' + u.key.replace('#', '_'), meta: u.key, x: xs, y: ys, z: z, customdata: cd, name: u.html, showscale: false,
        colorscale: ramp(col), cauto: false, cmin: lo * f, cmax: (hi > lo ? hi : lo + 1) * f, opacity: op,
        lighting: { ambient: 0.6, diffuse: 0.68, specular: 0.25, roughness: 0.4, fresnel: 0.05 },
        lightposition: { x: -2e4, y: -3e4, z: 1e5 },
        contours: {
          x: Object.assign({ show: true, color: line, width: 1, highlight: false }, mx),
          y: Object.assign({ show: true, color: line, width: 1, highlight: false }, my),
          z: { highlight: false }
        },
        hovertemplate: '<b>' + u.html + '</b><br>' + A.hov('x') + '<br>' + Bx.hov('y') + '<br>' + Ez.hov('z') + '<br>%{customdata}<extra></extra>'
      });
    });
    traces.push(ciTrace());
    ciTable();
    var ax = { gridcolor: '#e4e4e4', linecolor: '#8c8c8c', showline: true, zeroline: false, showspikes: false, backgroundcolor: '#fafafa',
               showbackground: true, ticks: 'outside', tickcolor: '#8c8c8c', ticklen: 4, tickfont: { size: 11 } };
    // an E cap clips through the z range (smooth cut; nulling values left saw-tooth holes at grid resolution)
    var narrow = ($('s3-plot').clientWidth || window.innerWidth) < 600;
    var zax = { title: { text: narrow ? (U.cm ? 'E (cm⁻¹)' : 'E/B') : Ez.text } };   // phones: short title
    if (s.z !== '' && s.z > lo) zax.range = [(lo - 0.02 * (s.z - lo)) * f, s.z * f];
    var H = narrow ? 400 : window.innerWidth <= 820 ? 460 : 640, k = F.orthoScale($('s3-plot'), H, 1.45);
    var layout = {
      height: H, margin: { l: 0, r: 0, t: 10, b: 0 }, paper_bgcolor: '#fff', uirevision: s.pl + '|' + res.n,
      font: { family: 'Lato, Segoe UI, Helvetica, Arial, sans-serif', size: 12, color: F.INK },
      scene: {
        xaxis: Object.assign({ title: { text: A.text } }, ax), yaxis: Object.assign({ title: { text: Bx.text } }, ax),
        zaxis: Object.assign(zax, ax), dragmode: 'turntable',
        aspectmode: 'manual', aspectratio: { x: k, y: k, z: 0.83 * k },          // orthographic: the aspect ratio sets the size
        camera: { eye: { x: 1.12, y: -1.32, z: 0.78 }, projection: { type: 'orthographic' } }
      },
      hoverlabel: { bgcolor: '#fff', bordercolor: F.RULE, font: { color: F.INK, size: 12 } }
    };
    var ready = Plotly.react($('s3-plot'), traces, layout, { responsive: true, displaylogo: false });   // async for gl3d
    window.TSPage3D = { res: res, s: s, surf: last.surf, sel: sel, traces: traces, ready: ready };
    writeHash(s);
  }
  function restyle() { plot(); syncGroupBoxes(); }

  // ---------------------------------------------------------------- conical intersections
  // markers for the cones whose two surfaces are both shown; open circles = on the Oh axis (Ds = Dt = 0)
  function ciZ(c) { return last.s.gs ? c.Erel : c.E; }
  function ciPair(c) { return F.keyHTML(c.lower, last.sc) + ' / ' + F.keyHTML(c.upper, last.sc); }
  function ciTrace() {
    var t = { type: 'scatter3d', mode: 'markers', x: [], y: [], z: [], text: [], showlegend: false, name: 'conical intersections',
              marker: { size: 5, color: F.INK, symbol: [], line: { color: '#fff', width: 1 } },
              hovertemplate: '%{text}<extra></extra>' };
    var cap = last.s.z === '' ? Infinity : last.s.z, U = F.units(), P = PLANES[last.s.pl], A = F.axis(P.an, U), Bx = F.axis(P.bn, U);
    (last.res.cis || []).forEach(function (c) {
      if (!sel[c.lower] || !sel[c.upper] || ciZ(c) > cap) return;
      t.x.push(c.a * A.f); t.y.push(c.b * Bx.f); t.z.push(ciZ(c) * U.B); t.marker.symbol.push(c.onAxis ? 'circle-open' : 'diamond');
      t.text.push('<b>Conical intersection</b><br>' + ciPair(c) + '<br>' + (U.cm ? 'E = ' : 'E/B = ') + F.eAxis(U).fmt(ciZ(c), 3) + '<br>Dq, Ds, Dt = ' +
                  [c.Dq, c.Ds, c.Dt].map(function (x) { return U.cm ? (x * U.B).toFixed(1) : x.toFixed(4); }).join(', ') + (U.cm ? ' cm⁻¹' : ' B') + (c.onAxis ? '<br>on the O<sub>h</sub> axis' : ''));
    });
    return t;
  }
  function ciTable() {
    var box = $('s3-cis'), cis = last.res.cis;
    if (!cis) { box.innerHTML = '<p class="muted">Conical-intersection search is off.</p>'; return; }
    if (!cis.length) { box.innerHTML = '<p class="muted">No conical intersections between same-symmetry states on this plane.</p>'; return; }
    var U = F.units(), f = function (x) { x = Math.abs(x) < 5e-10 ? 0 : x; return U.cm ? (x * U.B).toFixed(1) : x.toFixed(4); }, rows = cis.map(function (c, i) {
      return '<tr data-ci="' + i + '" title="Show both surfaces"><td>' + ciPair(c) + '</td><td>' + f(c.Dq) + '</td><td>' + f(c.Ds) + '</td><td>' + f(c.Dt) + '</td><td>' +
             (U.cm ? (ciZ(c) * U.B).toFixed(1) : ciZ(c).toFixed(3)) + '</td><td>' +
             (c.onAxis ? 'O<sub>h</sub> axis' : '') + '</td></tr>';
    });
    var un = U.cm ? ' (cm<sup>&minus;1</sup>)' : '/B';
    box.innerHTML = '<table class="t s3-citab"><thead><tr><th>Pair</th><th>Dq' + un + '</th><th>Ds' + un + '</th><th>Dt' + un + '</th><th>' +
      (U.cm ? 'E' + un : 'E/B') + (last.s.gs ? ' (from ground)' : '') + '</th><th></th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }

  // ---------------------------------------------------------------- export: the shown surfaces on the grid, units shown
  function surfCSV() {
    var res = last.res, s = last.s, np = res.np, U = F.units(), P = PLANES[s.pl], A = F.axis(P.an, U), Bx = F.axis(P.bn, U);
    var pl = plane(s), un = U.cm ? ' (cm-1)' : '/B', on = last.surf.filter(function (u) { return sel[u.key]; }), g = F.g10;
    var asc = function (t) { return t.replace('⁻¹', '-1'); };
    var rows = [[asc(A.text), asc(Bx.text), 'Dq' + un, 'Ds' + un, 'Dt' + un].concat(on.map(function (u) {
      return 'E(' + F.keyText(u.key, last.sc) + ')' + (s.gs ? ' from ground' : '');
    })).join(',')];
    for (var ib = 0; ib < res.nb; ib++) for (var ia = 0; ia < res.na; ia++) {
      var t = ib * res.na + ia, fl = fieldAt(pl, res.a[ia], res.b[ib]);
      rows.push([g(res.a[ia] * A.f), g(res.b[ib] * Bx.f), g(fl.Dq * U.B), g(fl.Ds * U.B), g(fl.Dt * U.B)].concat(on.map(function (u) {
        return g(res.E[u.row * np + t] * U.B);
      })).join(','));
    }
    return rows.join('\n') + '\n';
  }

  // ---------------------------------------------------------------- wiring
  function init() {
    if (!window.Plotly || !F) return;
    var h = readHash();
    toControls(h);
    hashSel = h.psel || null;
    window.TSExport.surf = surfCSV;
    $('s3-csv').addEventListener('click', function () { if (last) F.saveText('d' + last.res.n + '_surfaces.csv', surfCSV()); });
    $('s3-png').addEventListener('click', function () { if (last) F.savePNG($('s3-plot'), 'd' + last.res.n + '_surfaces'); });
    $('ts-u').addEventListener('change', function () { if (last) plot(); });
    $('ts-bcm').addEventListener('input', function () { if (last && $('ts-u').value === 'cm') plot(); });
    $('s3-plane').addEventListener('change', function () { planeDefaults($('s3-plane').value); schedule(); });
    ['s3-q', 's3-a0', 's3-a1', 's3-b0', 's3-b1', 's3-o', 's3-u', 's3-v', 's3-g', 's3-gs'].forEach(function (id) {
      $(id).addEventListener('change', schedule);
    });
    ['ts-n', 'ts-cb'].forEach(function (id) { $(id).addEventListener('change', schedule); });
    $('s3-z').addEventListener('change', function () { if (last) { last.s = fromControls(); writeHash(last.s); plot(); } });
    var rz = null;
    window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { if (last) plot(); }, 250); });
    $('s3-op').addEventListener('input', function () { if (last) { last.s.op = Math.min(1, Math.max(0.2, num('s3-op', 1))); plot(); } });
    $('s3-grp').addEventListener('change', function () { if (last) { last.s.grp = $('s3-grp').value; writeHash(last.s); buildList(); } });
    $('s3-go').addEventListener('click', run);
    $('s3-ci').addEventListener('change', schedule);
    $('s3-cis').addEventListener('click', function (ev) {
      var tr = ev.target.closest && ev.target.closest('tr[data-ci]');
      if (!tr || !last || !last.res.cis) return;
      var c = last.res.cis[+tr.getAttribute('data-ci')];
      setSel([c.lower, c.upper], true); buildList(); restyle();
    });
    $('s3-all').addEventListener('click', function () { if (!last) return; setSel(last.surf.map(function (u) { return u.key; }), true); buildList(); restyle(); });
    $('s3-none').addEventListener('click', function () { if (!last) return; sel = {}; buildList(); restyle(); });
    $('s3-low').addEventListener('click', function () { if (!last) return; last.s.N = Math.max(1, Math.round(num('s3-N', 8))); writeHash(last.s); lowest(last.s.N); });
    $('s3-gsr').addEventListener('click', function () {
      if (!last) return;
      sel = {}; setSel(last.surf.filter(function (u) { return u.ground; }).map(function (u) { return u.key; }), true);
      buildList(); restyle();
    });
    $('s3-list').addEventListener('change', function (ev) {
      var cb = ev.target, k = cb.getAttribute('data-k'), g = cb.getAttribute('data-g');
      if (k) setSel([k], cb.checked);
      else if (g !== null) setSel($('s3-list')._groups[+g].items.map(function (u) { return u.key; }), cb.checked);
      if (g !== null) $('s3-list').querySelectorAll('fieldset')[+g].querySelectorAll('input[data-k]').forEach(function (x) { x.checked = cb.checked; });
      restyle();
    });
    if (+h.go === 1) run();
  }
  init();
})();
