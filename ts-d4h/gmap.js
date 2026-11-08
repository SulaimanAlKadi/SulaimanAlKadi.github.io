/* D4h Tanabe-Sugano page, section 3: the ground state on a voxel grid over (Dq, Ds, Dt)/B. Domains are coloured
   by the lowest (2S+1, Gamma) level, boundaries are zero isosurfaces of E_Gamma - min over the other blocks, and
   a slice heatmap shows one plane; clicking a voxel or cell opens the fixed-ratio cut through it in section 1
   (window.TSCut from app.js). d^n and C/B come from section 1. */
(function () {
  'use strict';
  var TS = window.TSD4h, F = window.TSFmt;
  // validated on all pairs (dataviz validator); a sixth or later domain folds into grey, still labelled
  var DCOL = ['#a62e40', '#2a78d6', '#1baf7a', '#eda100', '#5a3d8c'], OTHER = '#8a8a8a';
  var IRR = ['A1g', 'A2g', 'B1g', 'B2g', 'Eg'], AX = { q: 'Dq/B', s: 'Ds/B', t: 'Dt/B' };
  var DEF = { gq0: 0.5, gq1: 3.5, gs0: -1.5, gs1: 1.5, gt0: -0.75, gt1: 0.75, gn: 21, gv: 'both', gax: 't', gi: '', ggo: 0 };
  function $(id) { return document.getElementById(id); }
  var sync = /[?&]sync\b/.test(location.search), useWorker = !sync && typeof Worker !== 'undefined';
  var worker = null, busy = false, reqId = 0, last = null, timer = null;

  function readHash() {
    var s = JSON.parse(JSON.stringify(DEF));
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var p = kv.split('='), k = p[0];
      if (k in s) s[k] = decodeURIComponent(p[1] || '');
    });
    return s;
  }
  function num(id, def) { var v = parseFloat($(id).value); return isFinite(v) ? v : def; }
  function toControls(h) {
    ['q0', 'q1', 's0', 's1', 't0', 't1', 'n'].forEach(function (k) { $('gm-' + k).value = h['g' + k]; });
    $('gm-view').value = AX[h.gax] ? h.gv : 'both'; $('gm-ax').value = AX[h.gax] ? h.gax : 't';
  }
  function fromControls() {
    return {
      n: +$('ts-n').value, CB: num('ts-cb', 4.5), q: [num('gm-q0', 0.5), num('gm-q1', 3.5)], s: [num('gm-s0', -1.5), num('gm-s1', 1.5)],
      t: [num('gm-t0', -0.75), num('gm-t1', 0.75)], g: Math.round(Math.min(41, Math.max(5, num('gm-n', 21)))),
      view: $('gm-view').value, ax: $('gm-ax').value, i: Math.round(num('gm-i', -1))
    };
  }
  function writeHash(s) {
    var v = { gq0: s.q[0], gq1: s.q[1], gs0: s.s[0], gs1: s.s[1], gt0: s.t[0], gt1: s.t[1], gn: s.g, gv: s.view, gax: s.ax, gi: s.i, ggo: 1 };
    var parts = [];
    Object.keys(v).forEach(function (k) { if (String(v[k]) !== String(DEF[k])) parts.push(k + '=' + encodeURIComponent(v[k])); });
    F.setHash(Object.keys(DEF), parts);
  }
  function status(t, cls) { var e = $('gm-status'); e.textContent = t; e.className = 'ss-status' + (cls ? ' ' + cls : ''); }
  function progress(f) { var p = $('gm-prog'); p.hidden = f === null; if (f !== null) p.value = f; }

  function request(s) {
    return { cmd: 'ground', id: ++reqId, n: s.n, CB: s.CB, q: [s.q[0], s.q[1], s.g], s: [s.s[0], s.s[1], s.g], t: [s.t[0], s.t[1], s.g] };
  }
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
    if (!useWorker) {
      try { draw(TS.groundMap(req), s); } catch (e) { status('Error: ' + e.message, 'bad'); }
      return;
    }
    if (busy && worker) { worker.terminate(); worker = null; }
    worker = worker || makeWorker();
    worker.pendingState = s;
    busy = true; progress(0); status('Computing.');
    worker.postMessage(req);
  }
  function schedule() { if (!last) return; clearTimeout(timer); timer = setTimeout(run, 300); }

  // ---------------------------------------------------------------- data
  function idx(res, v) { var iq = v % res.nq, r = (v - iq) / res.nq, is = r % res.ns; return [iq, is, (r - is) / res.ns]; }
  function fieldOf(res, v) { var i = idx(res, v); return { Dq: res.q[i[0]], Ds: res.s[i[1]], Dt: res.t[i[2]] }; }

  function draw(res, s) {
    var count = new Array(res.keys.length).fill(0);
    for (var v = 0; v < res.nv; v++) count[res.ground[v]]++;
    var present = [];
    count.forEach(function (c, k) { if (c) present.push(k); });
    present.sort(function (a, b) {                          // canonical order: colour follows the term, not its size
      var pa = F.parseKey(res.keys[a]), pb = F.parseKey(res.keys[b]);
      return pb.mult - pa.mult || IRR.indexOf(pa.irrep) - IRR.indexOf(pb.irrep);
    });
    var pos = {}, dom = present.map(function (k, j) {
      var p = F.parseKey(res.keys[k]);
      pos[k] = j;
      return { k: k, key: res.keys[k], html: F.termHTML(p.mult, p.irrep), count: count[k], frac: count[k] / res.nv, color: DCOL[j] || OTHER };
    });
    var h = last ? null : readHash();
    last = { res: res, s: s, dom: dom, pos: pos, off: {} };
    var ax = $('gm-ax').value, nmax = { q: res.nq, s: res.ns, t: res.nt }[ax] - 1, sl = $('gm-i');
    sl.max = nmax;
    var want = h ? (h.gi !== '' ? +h.gi : -1) : s.i;          // first map: the hash's slice, else the middle
    sl.value = want >= 0 && want <= nmax ? want : Math.round(nmax / 2);
    plot3d(); plot2d(); legend();
    writeHash(fromControls());
    status('d' + res.n + ', ' + res.nq + ' x ' + res.ns + ' x ' + res.nt + ' voxels, ' + dom.length + ' ground term' + (dom.length === 1 ? '' : 's'), 'ok');
  }

  function legend() {                                    // also the 3D view's legend: a box hides a domain there
    $('gm-legend').innerHTML = last.dom.map(function (d) {
      return '<label title="Show in the 3D view"><input type="checkbox" data-key="' + d.key + '"' + (last.off[d.key] ? '' : ' checked') +
             '><span class="sw" style="background:' + d.color + '"></span><span>' + d.html + '</span><span class="pct">' + (100 * d.frac).toFixed(1) + ' %</span></label>';
    }).join('');
  }

  var AXSTYLE = { gridcolor: '#e4e4e4', linecolor: '#8c8c8c', showline: true, zeroline: false, showspikes: false, backgroundcolor: '#fafafa',
                  showbackground: true, ticks: 'outside', tickcolor: '#8c8c8c', ticklen: 4, tickfont: { size: 11 } };   // as in section 2
  function plot3d() {
    var res = last.res, view = $('gm-view').value, nv = res.nv, X = new Array(nv), Y = new Array(nv), Z = new Array(nv), traces = [];
    var U = F.units(), aq = F.axis(AX.q, U), as = F.axis(AX.s, U), at = F.axis(AX.t, U);
    for (var v = 0; v < nv; v++) { var f = fieldOf(res, v); X[v] = f.Dq * U.B; Y[v] = f.Ds * U.B; Z[v] = f.Dt * U.B; }
    var nk = res.keys.length, size = Math.max(2, Math.round(60 / res.nq));
    last.dom.forEach(function (d) {
      if (view !== 'iso') {
        var vx = [], vy = [], vz = [], cd = [];
        for (var v = 0; v < nv; v++) if (res.ground[v] === d.k) { vx.push(X[v]); vy.push(Y[v]); vz.push(Z[v]); cd.push(v); }
        traces.push({ type: 'scatter3d', mode: 'markers', x: vx, y: vy, z: vz, customdata: cd, name: d.html, legendgroup: d.key, visible: !last.off[d.key],
                      marker: { size: size, color: d.color, opacity: view === 'vox' ? 0.55 : 0.18 },
                      hovertemplate: '<b>' + d.html + '</b> ground<br>' + aq.hov('x') + '<br>' + as.hov('y') + '<br>' + at.hov('z') + '<br>click: open the cut<extra></extra>' });
      }
      if (view !== 'vox' && last.dom.length > 1) {
        var val = new Array(nv);
        for (var w = 0; w < nv; w++) {
          var other = Infinity;
          for (var k = 0; k < nk; k++) if (k !== d.k) other = Math.min(other, res.low[k * nv + w]);
          val[w] = res.low[d.k * nv + w] - other;
        }
        traces.push({ type: 'isosurface', x: X, y: Y, z: Z, value: val, isomin: 0, isomax: 0, surface: { count: 1 },
                      caps: { x: { show: false }, y: { show: false }, z: { show: false } }, colorscale: [[0, d.color], [1, d.color]],
                      showscale: false, opacity: 0.55, name: d.html, legendgroup: d.key, visible: !last.off[d.key],
                      lighting: { ambient: 0.6, diffuse: 0.68, specular: 0.2, roughness: 0.45 }, lightposition: { x: -2e4, y: -3e4, z: 1e5 }, hoverinfo: 'skip' });
      }
    });
    var H = window.innerWidth <= 820 ? 420 : 560, k = F.orthoScale($('gm-3d'), H, 1.35);
    var layout = {
      height: H, margin: { l: 0, r: 0, t: 10, b: 0 }, paper_bgcolor: '#fff', uirevision: 'gm', showlegend: false,
      font: { family: 'Lato, Segoe UI, Helvetica, Arial, sans-serif', size: 12, color: F.INK },
      scene: { xaxis: Object.assign({ title: { text: aq.text } }, AXSTYLE), yaxis: Object.assign({ title: { text: as.text } }, AXSTYLE),
               zaxis: Object.assign({ title: { text: at.text } }, AXSTYLE), aspectmode: 'manual', aspectratio: { x: k, y: k, z: k },
               camera: { eye: { x: 1.15, y: -1.25, z: 0.8 }, projection: { type: 'orthographic' } } },
      hoverlabel: { bgcolor: '#fff', bordercolor: F.RULE, font: { color: F.INK, size: 12 } }
    };
    var gd = $('gm-3d');
    Plotly.react(gd, traces, layout, { responsive: true, displaylogo: false });
    if (!gd._gmBound) {
      gd._gmBound = true;
      gd.on('plotly_click', function (ev) {
        var p = ev && ev.points && ev.points[0];
        if (p && p.customdata !== undefined && p.data.type === 'scatter3d') openAt(+p.customdata);
      });
    }
    publish();
  }

  // the slice: which voxel index is at (column ix, row iy) of the current slice
  function sliceGeom() {
    var res = last.res, ax = $('gm-ax').value, i = +$('gm-i').value;
    if (ax === 'q') return { xa: 's', ya: 't', nx: res.ns, ny: res.nt, v: function (x, y) { return (y * res.ns + x) * res.nq + i; } };
    if (ax === 's') return { xa: 'q', ya: 't', nx: res.nq, ny: res.nt, v: function (x, y) { return (y * res.ns + i) * res.nq + x; } };
    return { xa: 'q', ya: 's', nx: res.nq, ny: res.ns, v: function (x, y) { return (i * res.ns + y) * res.nq + x; } };
  }
  function plot2d() {
    var res = last.res, g = sliceGeom(), ax = $('gm-ax').value, i = +$('gm-i').value, nd = last.dom.length;
    var axv = { q: res.q, s: res.s, t: res.t }, U = F.units(), A = {};
    ['q', 's', 't'].forEach(function (k) { A[k] = F.axis(AX[k], U); });
    $('gm-iv').textContent = A[ax].text.replace(/ \(cm⁻¹\)$/, '') + ' = ' + A[ax].fmt(axv[ax][i], 3) + (U.cm ? ' cm⁻¹' : '');
    var z = [], text = [], cd = [];
    for (var y = 0; y < g.ny; y++) {
      var zr = [], tr = [], cr = [];
      for (var x = 0; x < g.nx; x++) {
        var v = g.v(x, y), d = last.dom[last.pos[res.ground[v]]], f = fieldOf(res, v);
        zr.push(last.pos[res.ground[v]]); cr.push(v);
        tr.push('<b>' + d.html + '</b> ground<br>' + [['q', f.Dq], ['s', f.Ds], ['t', f.Dt]].map(function (p) {
          return (U.cm ? AX[p[0]].replace('/B', '') : AX[p[0]]) + ' = ' + A[p[0]].fmt(p[1], 3) + (U.cm ? ' cm⁻¹' : '');
        }).join('<br>'));
      }
      z.push(zr); text.push(tr); cd.push(cr);
    }
    var cs = [];
    last.dom.forEach(function (d, j) { cs.push([j / nd, d.color]); cs.push([(j + 1) / nd, d.color]); });
    var sc = function (k) { return Array.prototype.map.call(axv[k], function (x) { return x * U.B; }); };
    var trace = { type: 'heatmap', x: sc(g.xa), y: sc(g.ya), z: z, text: text, customdata: cd,
                  zmin: -0.5, zmax: nd - 0.5, colorscale: cs, showscale: false, hovertemplate: '%{text}<br>click: open the cut<extra></extra>' };
    var layout = {
      height: window.innerWidth <= 820 ? 420 : 560, margin: { l: 60, r: 12, t: 12, b: 50 }, paper_bgcolor: '#fff', plot_bgcolor: '#fff',
      font: { family: 'Lato, Segoe UI, Helvetica, Arial, sans-serif', size: 12, color: F.INK },
      xaxis: { title: { text: A[g.xa].text }, linecolor: F.RULE, ticks: 'outside', tickcolor: F.RULE },
      yaxis: { title: { text: A[g.ya].text }, linecolor: F.RULE, ticks: 'outside', tickcolor: F.RULE },
      hoverlabel: { bgcolor: '#fff', bordercolor: F.RULE, font: { color: F.INK, size: 12 } }
    };
    var gd = $('gm-2d');
    Plotly.react(gd, [trace], layout, { responsive: true, displaylogo: false });
    if (!gd._gmBound) {
      gd._gmBound = true;
      gd.on('plotly_click', function (ev) {
        var p = ev && ev.points && ev.points[0];
        if (p && p.pointIndex) openAt(+cd2(p.pointIndex));
      });
    }
    last.slice = { z: z, cd: cd, geom: g };
    publish();
  }
  function cd2(pi) { return last.slice.cd[pi[0]][pi[1]]; }                       // heatmap pointIndex = [row, col]

  function openAt(v) {
    var f = fieldOf(last.res, v);
    return window.TSCut && window.TSCut.open(f.Dq, f.Ds, f.Dt);
  }
  function publish() { window.TSPage3G = { res: last.res, s: last.s, dom: last.dom, pos: last.pos, slice: last.slice, openAt: openAt, fieldOf: fieldOf }; }

  // ---------------------------------------------------------------- export: one row per voxel, units shown
  function groundCSV() {
    var res = last.res, U = F.units(), un = U.cm ? ' (cm-1)' : '/B', g = F.g10, rows = ['Dq' + un + ',Ds' + un + ',Dt' + un + ',ground term'];
    for (var v = 0; v < res.nv; v++) {
      var f = fieldOf(res, v), p = F.parseKey(res.keys[res.ground[v]]);
      rows.push([g(f.Dq * U.B), g(f.Ds * U.B), g(f.Dt * U.B), p.mult + p.irrep].join(','));
    }
    return rows.join('\n') + '\n';
  }

  // ---------------------------------------------------------------- wiring
  function init() {
    if (!window.Plotly || !F) return;
    var h = readHash();
    toControls(h);
    window.TSExport.ground = groundCSV;
    $('gm-csv').addEventListener('click', function () { if (last) F.saveText('d' + last.res.n + '_ground_map.csv', groundCSV()); });
    $('gm-png3').addEventListener('click', function () { if (last) F.savePNG($('gm-3d'), 'd' + last.res.n + '_ground_map_3d'); });
    $('gm-png2').addEventListener('click', function () { if (last) F.savePNG($('gm-2d'), 'd' + last.res.n + '_ground_map_slice'); });
    var rz = null;
    window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { if (last) plot3d(); }, 250); });
    $('gm-legend').addEventListener('change', function (ev) {
      var k = ev.target.getAttribute('data-key'), gd = $('gm-3d'), idx = [];
      if (!k || !last) return;
      last.off[k] = !ev.target.checked;
      gd.data.forEach(function (t, i) { if (t.legendgroup === k) idx.push(i); });
      if (idx.length) Plotly.restyle(gd, { visible: ev.target.checked }, idx);
    });
    $('ts-u').addEventListener('change', function () { if (last) { plot3d(); plot2d(); } });
    $('ts-bcm').addEventListener('input', function () { if (last && $('ts-u').value === 'cm') { plot3d(); plot2d(); } });
    ['gm-q0', 'gm-q1', 'gm-s0', 'gm-s1', 'gm-t0', 'gm-t1', 'gm-n', 'ts-n', 'ts-cb'].forEach(function (id) { $(id).addEventListener('change', schedule); });
    $('gm-go').addEventListener('click', run);
    $('gm-view').addEventListener('change', function () { if (last) { plot3d(); writeHash(fromControls()); } });
    $('gm-ax').addEventListener('change', function () {
      if (!last) return;
      var r = last.res, n = { q: r.nq, s: r.ns, t: r.nt }[$('gm-ax').value] - 1;
      $('gm-i').max = n; $('gm-i').value = Math.round(n / 2);
      plot2d(); writeHash(fromControls());
    });
    $('gm-i').addEventListener('input', function () { if (last) { plot2d(); writeHash(fromControls()); } });
    if (+h.ggo === 1) run();
  }
  init();
})();
