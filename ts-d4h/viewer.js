/* Drag-to-rotate viewer for the Manim renders (tanabe-sugano-rendered.html). Frames: ts-d4h/manim/<preset>/
   <elevation>_<azimuth>.webp with a manifest.json, written by TS_D4h/manim/ts_surfaces.py (scene Turntable). */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  var CAPS = {
    d6: 'd<sup>6</sup>, Dq/B = 2, over Ds/B &times; Dt/B: the 8 lowest surfaces, energies from the ground state. Colour marks the spin multiplicity, as on the interactive page.',
    d7cone: 'd<sup>7</sup>, Ds = 0, over Dq/B &times; Dt/Dq: the two <sup>2</sup>E<sub>g</sub> states from <sup>2</sup>T<sub>1g</sub> and <sup>2</sup>T<sub>2g</sub>, drawn relative to their mean &Emacr;. They touch in a cone at Dq/B = 0.488, Dt = 0 (the dot), on the O<sub>h</sub> axis (dashed).'
  };
  var st = { p: 'd6', az: 0, el: 1 }, M = null, cache = {}, drag = null;

  function readHash() {
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var p = kv.split('='), k = p[0], v = decodeURIComponent(p[1] || '');
      if (k === 'p' && CAPS[v]) st.p = v;
      else if ((k === 'az' || k === 'el') && /^\d+$/.test(v)) st[k] = +v;
    });
  }
  function writeHash() {
    if (history.replaceState) history.replaceState(null, '', '#p=' + st.p + '&az=' + st.az + '&el=' + st.el);
  }
  function src(j, i) { return 'ts-d4h/manim/' + st.p + '/' + j + '_' + i + '.webp'; }
  function show() {
    if (!M) return;
    st.az = ((st.az % M.nt) + M.nt) % M.nt;
    st.el = Math.max(0, Math.min(M.phis.length - 1, st.el));
    $('mv-img').src = src(st.el, st.az);
    $('mv-img').alt = 'Rendered surfaces, azimuth ' + Math.round(st.az * 360 / M.nt) + ' degrees from the default view, elevation ' + (90 - M.phis[st.el]) + ' degrees';
    writeHash();
    window.TSViewer = { st: st, M: M, src: $('mv-img').getAttribute('src') };
  }
  // preload: the current elevation first, then the others; a bar shows progress
  function preload() {
    var list = [], done = 0, key = st.p;
    for (var d = 0; d < M.phis.length; d++) {
      var j = (st.el + d) % M.phis.length;
      for (var i = 0; i < M.nt; i++) list.push(src(j, i));
    }
    var bar = $('mv-load'), n = list.length;
    bar.hidden = false;
    (function next(k) {
      if (key !== st.p) return;
      if (k >= n) { bar.hidden = true; status(M.nt * M.phis.length + ' frames loaded'); return; }
      var u = list[k];
      if (cache[u]) { done++; return next(k + 1); }
      var im = new Image();
      im.onload = im.onerror = function () { cache[u] = im; done++; bar.firstChild.style.width = (100 * done / n) + '%'; next(k + 1); };
      im.src = u;
    })(0);
  }
  function status(t, bad) { var e = $('mv-status'); e.textContent = t; e.className = 'ss-status' + (bad ? ' bad' : ' ok'); }

  function load(p, keepView) {
    st.p = p;
    if (!keepView) { st.az = 0; st.el = 1; }
    status('Loading.');
    fetch('ts-d4h/manim/' + p + '/manifest.json').then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (m) {
      if (st.p !== p) return;
      M = m;
      $('mv-stage').style.aspectRatio = m.width + ' / ' + m.height;            // frames carry their own aspect
      $('mv-legend').innerHTML = m.legend.map(function (L) {
        return '<span><span class="sw" style="background:' + L.color + '"></span>' + L.label + '</span>';
      }).join('');
      $('mv-cap').innerHTML = CAPS[p];
      $('mv-preset').value = p;
      show(); preload();
    }).catch(function (e) { status('Could not load the frames (' + e.message + ').', true); });
  }

  // pointer drag: sideways turns (48 steps across ~90 % of the image width), up/down tilts (one level per 50 px)
  var stage = $('mv-stage');
  stage.addEventListener('pointerdown', function (ev) {
    if (!M) return;
    drag = { x: ev.clientX, y: ev.clientY, az: st.az, el: st.el };
    if (stage.setPointerCapture) try { stage.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic events */ }
    stage.classList.add('drag');
  });
  stage.addEventListener('pointermove', function (ev) {
    if (!drag) return;
    var w = stage.clientWidth || 800, step = 0.9 * w / M.nt;
    var az = drag.az - Math.round((ev.clientX - drag.x) / step), el = drag.el + Math.round((ev.clientY - drag.y) / 50);
    if (az !== st.az || el !== st.el) { st.az = az; st.el = el; show(); }
  });
  function end() { drag = null; stage.classList.remove('drag'); }
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('keydown', function (ev) {
    var k = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (!k || !M) return;
    ev.preventDefault(); st.az += k[0]; st.el += k[1]; show();
  });
  document.querySelectorAll('[data-tilt]').forEach(function (b) {
    b.addEventListener('click', function () { st.el += +b.getAttribute('data-tilt'); show(); });
  });
  $('mv-reset').addEventListener('click', function () { st.az = 0; st.el = 1; show(); });
  $('mv-preset').addEventListener('change', function () { load($('mv-preset').value); });

  readHash();
  load(st.p, true);
})();
