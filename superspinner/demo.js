/* SuperSpinner in the browser.
   Shared engine (window.SuperSpinner): loads the ONNX network with onnxruntime-web, preprocesses a
   spectrum onto the canonical grid, runs the network with optional test-time augmentation, decodes
   the output heads (keypoint heatmaps for g and the outer hyperfine lines, direct regression heads as
   fallback), simulates a first-order powder reconstruction, and draws the plot.
   The held-out-spectrum demo (the #ss-demo block) and the upload panel (upload.js) both use it. */
(function () {
  'use strict';
  var N = 8192, B0 = 50.0, DB = 500.0 / 8191, NU_REF = 9.5, HM = 8, P_HM = 1024;
  var GFAC = 71.44775, MHZ_PER_MT = 13.996245;
  var ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  var BASE = (function () {
    var s = document.currentScript && document.currentScript.src;
    return s ? s.slice(0, s.lastIndexOf('/') + 1) : 'superspinner/';
  })();
  var ISO = {
    none: [], V: [[0.9975, 3.5, 1.0]], Mo: [[0.1592, 2.5, 1.0], [0.0955, 2.5, 1.0211]],
    W: [[0.1431, 0.5, 1.0]], Cu: [[0.6917, 1.5, 1.0], [0.3083, 1.5, 1.0711]], Co: [[1.0, 3.5, 1.0]],
    Cr: [[0.0950, 1.5, 1.0]], Ti: [[0.0744, 2.5, 1.0], [0.0541, 3.5, 1.0]], Nb: [[1.0, 4.5, 1.0]],
    Re: [[0.626, 2.5, 1.0], [0.374, 2.5, 0.9898]], '14N': [[0.9963, 1.0, 1.0]]
  };
  var FAM = { 'd1_early_TM': 'd¹ early metal', 'Cu(II)': 'Cu(II)', 'Co(II)_LS': 'Co(II) low-spin', 'Fe(III)_LS': 'Fe(III) low-spin',
              'Ni(I/III)': 'Ni(I/III)', 'nitroxide': 'nitroxide', 'organic': 'organic radical', 'wildcard': 'other S = ½' };

  var meta = null, bank = null, session = null, loadPromise = null;
  var css = getComputedStyle(document.documentElement);
  var tok = function (n) { return css.getPropertyValue(n).trim(); };

  // ------------------------------------------------------------------ helpers
  var R = Math.random;
  function logu(a, b) { return Math.exp(Math.log(a) + R() * (Math.log(b) - Math.log(a))); }
  function randn() { var u = 1 - R(), v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function choice(ps) { var u = R(), c = 0; for (var i = 0; i < ps.length; i++) { c += ps[i]; if (u < c) return i; } return ps.length - 1; }
  function softmax(a) { var m = -1e30, i; for (i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; var e = [], z = 0; for (i = 0; i < a.length; i++) { e[i] = Math.exp(a[i] - m); z += e[i]; } return e.map(function (v) { return v / z; }); }
  function median(a) { var b = Array.from(a).sort(function (x, y) { return x - y; }); var n = b.length; return n % 2 ? b[(n - 1) / 2] : 0.5 * (b[n / 2 - 1] + b[n / 2]); }

  // ------------------------------------------------------------------ loading
  function load(setStatus) {
    if (loadPromise) return loadPromise;
    setStatus = setStatus || function () {};
    loadPromise = (async function () {
      setStatus('Loading onnxruntime-web…');
      await new Promise(function (res, rej) {
        if (window.ort) return res();
        var s = document.createElement('script'); s.src = ORT_CDN + 'ort.min.js'; s.onload = res; s.onerror = function () { rej(new Error('could not load onnxruntime-web')); };
        document.head.appendChild(s);
      });
      ort.env.wasm.wasmPaths = ORT_CDN;
      ort.env.wasm.numThreads = 1;
      var loadScript = function (src) {
        return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('could not load ' + src)); }; document.head.appendChild(s); });
      };
      var b64ToBytes = function (b64) { var bin = atob(b64), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
      if (location.protocol === 'file:') {
        setStatus('Loading spectrum bank…');
        await loadScript(BASE + 'bank.js');
        meta = window.SS_BANK.meta; bank = new Int16Array(b64ToBytes(window.SS_BANK.bin_b64).buffer);
        setStatus('Loading SuperSpinner (19 MB)…');
        await loadScript(BASE + 'superspinner.onnx.js');
        var modelBytes = b64ToBytes(window.SS_MODEL_B64); window.SS_MODEL_B64 = null;
        session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
      } else {
        setStatus('Loading spectrum bank…');
        var mj = await fetch(BASE + 'bank.json'); meta = await mj.json();
        var bb = await fetch(BASE + 'bank.bin'); bank = new Int16Array(await bb.arrayBuffer());
        setStatus('Loading SuperSpinner (14.5 MB)…');
        session = await ort.InferenceSession.create(BASE + 'superspinner.onnx', { executionProviders: ['wasm'] });
      }
      setStatus('Ready.');
    })();
    return loadPromise;
  }

  // ------------------------------------------------------------------ preprocessing (mirrors grid.resample_to_grid + infer.preprocess)
  // spec = {B_mT: Float64Array ascending or descending, y, nu_GHz}; offset shifts the field axis (TTA)
  function preprocess(spec, offset) {
    offset = offset || 0;
    var B = Array.from(spec.B_mT), y = Array.from(spec.y), i;
    if (B[0] > B[B.length - 1]) { B.reverse(); y.reverse(); }
    var sc = NU_REF / spec.nu_GHz;
    var Bc = B.map(function (b) { return (b + offset) * sc; });
    var diffs = []; for (i = 1; i < Bc.length; i++) diffs.push(Bc[i] - Bc[i - 1]);
    var step = median(diffs);
    if (step > 0 && step < 0.5 * DB) {                      // box filter to grid resolution
      var k = Math.floor(DB / step);
      if (k >= 2) {
        var ys = new Array(y.length), half = Math.floor(k / 2);
        for (i = 0; i < y.length; i++) { var s = 0, c = 0; for (var j = i - half; j < i - half + k; j++) if (j >= 0 && j < y.length) { s += y[j]; c++; } ys[i] = s / k; }
        y = ys;
      }
    }
    var xg = new Float32Array(N), mask = new Float32Array(N), n = Bc.length, p = 0;
    for (i = 0; i < N; i++) {
      var b = B0 + i * DB;
      if (b < Bc[0] || b > Bc[n - 1]) continue;
      while (p < n - 2 && Bc[p + 1] < b) p++;
      var f = (b - Bc[p]) / (Bc[p + 1] - Bc[p] || 1);
      xg[i] = y[p] * (1 - f) + y[p + 1] * f; mask[i] = 1;
    }
    var cnt = 0, mean = 0, lo = -1, hi = -1;
    for (i = 0; i < N; i++) if (mask[i]) { cnt++; mean += xg[i]; if (lo < 0) lo = i; hi = i; }
    if (cnt < 50) throw new Error('the spectrum covers too little of the 50–550 mT (scaled) range');
    mean /= cnt; var ma = 0;
    for (i = 0; i < N; i++) if (mask[i]) { xg[i] -= mean; if (Math.abs(xg[i]) > ma) ma = Math.abs(xg[i]); }
    for (i = 0; i < N; i++) if (mask[i]) xg[i] /= (ma + 1e-12);
    return { x: xg, mask: mask, lo: lo, hi: hi, nu: spec.nu_GHz, coverage: cnt / N };
  }

  function buildInputs(x, mask, nu, modamp, hintNuc) {
    var xx = new Float32Array(3 * N);
    for (var k = 0; k < N; k++) { xx[k] = x[k]; xx[N + k] = mask[k]; xx[2 * N + k] = (B0 + k * DB - 300) / 250; }
    var s = new Float32Array(15);
    s[0] = (nu / NU_REF - 1) * 10;
    if (modamp && modamp > 0) { s[1] = modamp; s[2] = 1; }
    var hi = hintNuc ? meta.nuc_names.indexOf(hintNuc) : -1;
    if (hi >= 0) s[3 + hi] = 1; else s[3 + meta.nuc_names.length] = 1;
    return { x: new ort.Tensor('float32', xx, [1, 3, N]), s: new ort.Tensor('float32', s, [1, 15]) };
  }

  // ------------------------------------------------------------------ decoding (mirrors infer.Predictor.predict)
  function destd(name, v) { var nm = meta.norm[name]; var o = []; for (var i = 0; i < v.length; i++) o[i] = v[i] * nm.std[i] + nm.mean[i]; return o; }
  function itG(t) { return t * 0.3 + 2; }
  function itA(t) { return 5 * Math.pow(10, t) - 5; }
  function itMHz(t) { return Math.max(Math.pow(10, t) - 1, 0); }
  function itGS(t) { return Math.max(Math.pow(10, t) - 5e-4, 0); }
  function decodeHm(logits, off, hmMask) {
    var p = new Float64Array(P_HM), m = -1e30, i;
    for (i = 0; i < P_HM; i++) { p[i] = hmMask[i] < 0.5 ? -1e4 : logits[off + i]; if (p[i] > m) m = p[i]; }
    var z = 0; for (i = 0; i < P_HM; i++) { p[i] = Math.exp(p[i] - m); z += p[i]; }
    var mu = 0; for (i = 0; i < P_HM; i++) { p[i] /= z; mu += p[i] * i; }
    var va = 0; for (i = 0; i < P_HM; i++) va += p[i] * (i - mu) * (i - mu);
    return { mu: mu, sd: Math.sqrt(Math.max(va, 1e-6)), p: p };
  }
  function estimate(name, mu, logvar, inv) {
    var sd = logvar.map(function (v) { return Math.exp(0.5 * v); });
    var val = destd(name, mu), lo = destd(name, mu.map(function (m, i) { return m - sd[i]; })), hi = destd(name, mu.map(function (m, i) { return m + sd[i]; }));
    return { value: val.map(inv), lo: lo.map(inv), hi: hi.map(inv) };
  }
  function decode(avg, mask, nu, hintNuc) {
    var hmMask = new Float32Array(P_HM), i;
    for (i = 0; i < P_HM; i++) { var mm = 0; for (var j = 0; j < HM; j++) if (mask[i * HM + j] > mm) mm = mask[i * HM + j]; hmMask[i] = mm; }
    var nucP = softmax(avg.nuc), famP = softmax(avg.family), shfP = softmax(avg.shf), nshfP = softmax(avg.nshf);
    var nucIdx = hintNuc ? meta.nuc_names.indexOf(hintNuc) : nucP.indexOf(Math.max.apply(null, nucP));
    var gE = estimate('g', avg.g_mu, avg.g_logvar, itG), gDirect = { value: gE.value.slice(), lo: gE.lo.slice(), hi: gE.hi.slice() };
    var g = gE.value.slice(), gLo = gE.lo.slice(), gHi = gE.hi.slice(), gsrc = ['head', 'head', 'head'], hms = [];
    var sB = [];
    for (i = 0; i < 3; i++) {
      var h = decodeHm(avg.g_hm, i * P_HM, hmMask);
      var Bc = B0 + h.mu * HM * DB, sb = h.sd * HM * DB, gv = GFAC * NU_REF / Bc;
      var inside = hmMask[Math.min(P_HM - 1, Math.max(0, Math.round(h.mu)))] > 0.5;
      hms.push({ p: h.p, mu: h.mu, sB: sb, g: gv, inside: inside }); sB.push(sb);
      if (inside && sb < 6) { g[i] = gv; var sg = gv * sb / Bc; gLo[i] = gv - sg; gHi[i] = gv + sg; gsrc[i] = 'heatmap'; }
    }
    var AE = estimate('A', avg.A_mu, avg.A_logvar, itA);
    var A = AE.value.slice(), ALo = AE.lo.slice(), AHi = AE.hi.slice(), asrc = ['head', 'head', 'head'], aOk = [false, false, false];
    var Imax = meta.nuc_imax[nucIdx];
    if (Imax > 0) {
      var lo = [], hi = [];
      for (i = 0; i < 3; i++) lo.push(decodeHm(avg.a_hm, i * P_HM, hmMask));
      for (i = 0; i < 3; i++) hi.push(decodeHm(avg.a_hm, (3 + i) * P_HM, hmMask));
      for (i = 0; i < 3; i++) {
        var dB = (hi[i].mu - lo[i].mu) * HM * DB * (nu / NU_REF);
        var sdl = lo[i].sd * HM * DB, sdh = hi[i].sd * HM * DB;
        var inL = hmMask[Math.min(P_HM - 1, Math.max(0, Math.round(lo[i].mu)))] > 0.5, inH = hmMask[Math.min(P_HM - 1, Math.max(0, Math.round(hi[i].mu)))] > 0.5;
        if (inL && inH && sdl < 6 && sdh < 6 && dB > 0.6) {
          A[i] = Math.max(dB, 0) * g[i] * MHZ_PER_MT / (2 * Imax);
          var sa = Math.sqrt(sdl * sdl + sdh * sdh) * g[i] * MHZ_PER_MT / (2 * Imax);
          ALo[i] = Math.max(A[i] - sa, 0); AHi[i] = A[i] + sa; asrc[i] = 'heatmap'; aOk[i] = true;
        }
      }
    }
    var lw = destd('lw', avg.lw_mu), lwsd = avg.lw_logvar.map(function (v) { return Math.exp(0.5 * v); });
    var lwG = Math.pow(10, lw[0]), lwL = Math.max(Math.pow(10, lw[1]) - 0.05, 0);
    var lwGhi = Math.pow(10, lw[0] + lwsd[0] * meta.norm.lw.std[0]), lwLhi = Math.max(Math.pow(10, lw[1] + lwsd[1] * meta.norm.lw.std[1]) - 0.05, 0);
    var HS = destd('HStrain', avg.HStrain_mu).map(itMHz), gS = destd('gStrain', avg.gStrain_mu).map(itGS), AS = destd('AStrain', avg.AStrain_mu).map(itMHz);
    var snr = Math.pow(10, avg.snr_mu[0] * 0.7 + 1.7);
    var imp = avg.imp_logit.map(function (v) { return 1 / (1 + Math.exp(-v)); });
    return { g: g, gLo: gLo, gHi: gHi, gs: g.map(function (v, k) { return Math.max(gHi[k] - v, v - gLo[k]); }), gsrc: gsrc, gDirect: gDirect, hms: hms, sB: sB,
             A: A, ALo: ALo, AHi: AHi, As: A.map(function (v, k) { return Math.max(AHi[k] - v, v - ALo[k]); }), asrc: asrc, aOk: aOk,
             nucIdx: nucIdx, nucName: meta.nuc_names[nucIdx], nucP: nucP, famP: famP, famName: FAM[meta.family_names[famP.indexOf(Math.max.apply(null, famP))]],
             shfP: shfP, shfName: meta.shf_names[shfP.indexOf(Math.max.apply(null, shfP))], nshf: nshfP.indexOf(Math.max.apply(null, nshfP)),
             lwG: lwG, lwL: lwL, lwGs: lwGhi - lwG, lwLs: lwLhi - lwL, HS: HS, gS: gS, AS: AS, snr: snr, imp: imp, hinted: !!hintNuc };
  }

  // run the network, optionally with field-shift test-time augmentation (infer.py default: 8 shifts of ±0.05 mT)
  async function predict(spec, opt) {
    opt = opt || {};
    var tta = opt.tta || 1, shifts = [0];
    if (tta > 1) { shifts = []; for (var t = 0; t < tta; t++) shifts.push(-0.05 + 0.1 * t / (tta - 1)); }
    var outs = [], pre0 = null, t0 = performance.now();
    for (var si = 0; si < shifts.length; si++) {
      var pre = preprocess(spec, shifts[si]); if (si === 0 || shifts[si] === 0) pre0 = pre0 || pre;
      var inp = buildInputs(pre.x, pre.mask, spec.nu_GHz, opt.modamp, opt.hintNuc);
      var out = await session.run(inp), o = {};
      Object.keys(out).forEach(function (k) { o[k] = Array.from(out[k].data); });
      outs.push(o);
    }
    if (!pre0) pre0 = preprocess(spec, 0);
    var avg = {}, keys = Object.keys(outs[0]);
    keys.forEach(function (k) { var n = outs[0][k].length, a = new Float64Array(n); outs.forEach(function (o) { for (var i = 0; i < n; i++) a[i] += o[k][i] / outs.length; }); avg[k] = Array.from(a); });
    if (outs.length > 1) {                                   // add the TTA spread to the aleatoric variance
      ['g', 'A', 'lw'].forEach(function (b) {
        var n = avg[b + '_mu'].length;
        for (var i = 0; i < n; i++) { var m = avg[b + '_mu'][i], v = 0; outs.forEach(function (o) { v += (o[b + '_mu'][i] - m) * (o[b + '_mu'][i] - m) / outs.length; }); avg[b + '_logvar'][i] = Math.log(Math.exp(avg[b + '_logvar'][i]) + v); }
      });
    }
    var pr = decode(avg, pre0.mask, spec.nu_GHz, opt.hintNuc);
    pr.ms = performance.now() - t0; pr.passes = outs.length;
    pr.quality = quality(pr, pre0, spec.nu_GHz);
    return { pre: pre0, pr: pr };
  }

  // mirrors infer.quality_assessment
  function quality(pr, pre, nu) {
    var notes = [], score = 0, snr = pr.snr, i;
    if (snr < 5) { notes.push('very low SNR (~' + snr.toFixed(0) + '): average more scans; g and A uncertainties are large'); score += 2; }
    else if (snr < 15) { notes.push('low SNR (~' + snr.toFixed(0) + '): parameter uncertainties are dominated by noise'); score += 1; }
    for (i = 0; i < 3; i++) if (pr.sB[i] > 4) { notes.push('g' + (i + 1) + ' turning point is poorly localized (spread ' + pr.sB[i].toFixed(1) + ' mT): broad, strained or overlapping feature'); score += 1; }
    var lo = B0 + pre.lo * DB, hi = B0 + pre.hi * DB;
    for (i = 0; i < 3; i++) { var b = GFAC * NU_REF / pr.g[i]; if (b < lo + 0.03 * (hi - lo) || b > hi - 0.03 * (hi - lo)) { notes.push('g' + (i + 1) + ' lies within 3 % of the sweep edge: widen the field range to capture it'); score += 2; } }
    if (pr.nucName !== 'none' && !(pr.aOk[0] && pr.aOk[1] && pr.aOk[2])) { notes.push('hyperfine outer lines not all resolved inside the window: A on those axes comes from the regression head'); score += 1; }
    var pn = Math.max.apply(null, pr.nucP);
    if (!pr.hinted && pn < 0.6) { notes.push('central nucleus ambiguous (top probability ' + pn.toFixed(2) + '): choose the metal above if it is known'); score += 1; }
    return { grade: score === 0 ? 'A' : (score <= 2 ? 'B' : (score <= 4 ? 'C' : 'D')), score: score, notes: notes };
  }

  // mirrors infer.to_easyspin
  function toEasySpin(pr, nucOverride) {
    var nuc = nucOverride || pr.nucName, r5 = function (v) { return (+v).toFixed(5); }, r2 = function (v) { return (+v).toFixed(2); }, r1 = function (v) { return (+v).toFixed(1); };
    var L = [];
    L.push('Sys.S = 1/2;');
    L.push('Sys.g = [' + pr.g.map(r5).join(' ') + '];');
    L.push('Sys.lw = [' + r2(Math.max(pr.lwG, 0.05)) + ' ' + r2(pr.lwL) + '];   % mT, [Gaussian Lorentzian] FWHM');
    var V = [];
    V.push('Vary.g = [' + pr.g.map(function (v, i) { return r5(Math.max(3 * (pr.gHi[i] - pr.gLo[i]) / 2, 0.003)); }).join(' ') + '];');
    V.push('Vary.lw = [' + r2(Math.max(3 * pr.lwGs, 0.1)) + ' ' + r2(Math.max(3 * pr.lwLs, 0.1)) + '];');
    var NUC_ES = { none: '', V: 'V', Mo: 'Mo', W: 'W', Cu: 'Cu', Co: 'Co', Cr: 'Cr', Ti: 'Ti', Nb: 'Nb', Re: 'Re', '14N': '14N' };
    var SHF_ES = { none: '', '1H': '1H', '14N': '14N', '31P': '31P', '19F': '19F' };
    var nucs = [], Arows = [], Vrows = [];
    var weak = { W: 850, Mo: 300, Cr: 130, Ti: 90 };
    if (nuc !== 'none') {
      nucs.push(NUC_ES[nuc]);
      var Av = pr.A.map(function (v, i) { return Math.max(3 * (pr.AHi[i] - pr.ALo[i]) / 2, 5); });
      if (weak[nuc]) { var pm = weak[nuc]; Arows.push(pr.A.map(function (v) { return r2(Math.max(v, 0.35 * pm)); })); Av = Av.map(function (v) { return Math.max(v, 0.5 * pm); }); }
      else Arows.push(pr.A.map(r2));
      Vrows.push(Av.map(r2));
    }
    if (pr.ashf && pr.shfName !== 'none' && pr.nshf > 0 && Math.max.apply(null, pr.shfP) > 0.5) {
      for (var k = 0; k < Math.min(pr.nshf, 4); k++) { nucs.push(SHF_ES[pr.shfName]); Arows.push([r2(pr.ashf || 0), r2(pr.ashf || 0), r2(pr.ashf || 0)]); Vrows.push(['5.00', '5.00', '5.00']); }
    }
    if (nucs.length) {
      L.push("Sys.Nucs = '" + nucs.join(',') + "';");
      L.push('Sys.A = [' + Arows.map(function (r) { return r.join(' '); }).join('; ') + '];   % MHz');
      V.push('Vary.A = [' + Vrows.map(function (r) { return r.join(' '); }).join('; ') + '];');
    }
    if (Math.max.apply(null, pr.gS) > 0.002) { L.push('Sys.gStrain = [' + pr.gS.map(r5).join(' ') + '];'); V.push('Vary.gStrain = [' + pr.gS.map(function (v) { return r5(Math.max(0.8 * v, 0.002)); }).join(' ') + '];'); }
    if (Math.max.apply(null, pr.HS) > 10) { L.push('Sys.HStrain = [' + pr.HS.map(r1).join(' ') + '];   % MHz'); V.push('Vary.HStrain = [' + pr.HS.map(function (v) { return r1(Math.max(0.8 * v, 5)); }).join(' ') + '];'); }
    if (nuc !== 'none' && Math.max.apply(null, pr.AS) > 5) { L.push('Sys.AStrain = [' + pr.AS.map(r1).join(' ') + '];   % MHz'); V.push('Vary.AStrain = [' + pr.AS.map(function (v) { return r1(Math.max(0.8 * v, 3)); }).join(' ') + '];'); }
    return L.concat(['']).concat(V).join('\n');
  }

  // ------------------------------------------------------------------ first-order powder simulation (for the overlay), canonical grid
  function simulate(g, A, nuc, lwG, lwL, HS, nu, modamp) {
    var iso = ISO[nuc] || [], i, k;
    var magFrac = 0; iso.forEach(function (s) { magFrac += s[0]; });
    var sticks = [];
    if (magFrac < 1) sticks.push({ w: 1 - magFrac, m: 0, sc: 0 });
    iso.forEach(function (s) { var I = s[1]; for (var m = -I; m <= I + 1e-9; m += 1) sticks.push({ w: s[0] / (2 * I + 1), m: m, sc: s[2] }); });
    var gm = (g[0] + g[1] + g[2]) / 3, hsAvg = Math.sqrt((HS[0] * HS[0] + HS[1] * HS[1] + HS[2] * HS[2]) / 3) / (gm * MHZ_PER_MT);
    var sig = Math.sqrt(Math.pow(Math.max(lwG, 0.05) / 2.3548, 2) + Math.pow(hsAvg / 2.3548, 2)), gamL = lwL / 2;
    var gmin = Math.min(g[0], g[1], g[2]), gmax = Math.max(g[0], g[1], g[2]);
    var span = GFAC * NU_REF * (1 / gmin - 1 / gmax) + 2 * Math.max(A[0], A[1], A[2]) * 4.5 / (gm * MHZ_PER_MT);
    var nth = Math.min(1600, Math.max(240, Math.ceil(span / (0.35 * sig)))), nph = Math.max(120, nth >> 1);
    var hist = new Float64Array(N);
    for (var it = 0; it < nth; it++) {
      var th = (it + 0.5) / nth * Math.PI / 2, st = Math.sin(th), ct = Math.cos(th), l3 = ct * ct;
      for (var ip = 0; ip < nph; ip++) {
        var ph = (ip + 0.5) / nph * Math.PI / 2, c = Math.cos(ph), s2 = Math.sin(ph);
        var l1 = st * st * c * c, l2 = st * st * s2 * s2;
        var g2 = g[0] * g[0] * l1 + g[1] * g[1] * l2 + g[2] * g[2] * l3, gg = Math.sqrt(g2);
        var K = Math.sqrt(g[0] * g[0] * A[0] * A[0] * l1 + g[1] * g[1] * A[1] * A[1] * l2 + g[2] * g[2] * A[2] * A[2] * l3) / gg;
        var Bg = GFAC * NU_REF / gg, wt = st;
        for (k = 0; k < sticks.length; k++) {
          var sk = sticks[k], p = (Bg - sk.m * sk.sc * K / (gg * MHZ_PER_MT) * (NU_REF / nu) - B0) / DB;
          var j0 = Math.floor(p), f = p - j0;
          if (j0 < 0 || j0 >= N - 1) continue;
          hist[j0] += wt * sk.w * (1 - f); hist[j0 + 1] += wt * sk.w * f;
        }
      }
    }
    var half = Math.ceil((4 * sig + 8 * gamL) / DB), kern = new Float64Array(2 * half + 1), ks = 0;
    for (i = -half; i <= half; i++) {
      var x = i * DB, v = Math.exp(-0.5 * x * x / (sig * sig)) / (sig * 2.5066);
      if (gamL > 0) v = 0.6 * v + 0.4 * (gamL / Math.PI) / (x * x + gamL * gamL);
      kern[i + half] = v; ks += v;
    }
    var abs = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var h = hist[i]; if (h === 0) continue;
      var a0 = Math.max(0, i - half), a1 = Math.min(N - 1, i + half);
      for (var j = a0; j <= a1; j++) abs[j] += h * kern[j - i + half] / ks;
    }
    var ma = Math.max((modamp || 0.1) * NU_REF / nu, 0.05), nq = 24, out = new Float64Array(N);
    for (var q = 0; q < nq; q++) {
      var phq = (q + 0.5) / nq * Math.PI, cq = Math.cos(phq), sh = (ma / 2) * cq / DB;
      for (i = 0; i < N; i++) { var pp = i + sh, jj = Math.floor(pp), ff = pp - jj; if (jj < 0 || jj >= N - 1) continue; out[i] += cq * (abs[jj] * (1 - ff) + abs[jj + 1] * ff); }
    }
    return out;
  }
  function reconstruct(pr, nu, modamp) {
    return simulate(pr.g, pr.nucName === 'none' ? [0, 0, 0] : pr.A, pr.nucName, pr.lwG, pr.lwL, pr.HS, nu, modamp);
  }

  // ------------------------------------------------------------------ plot
  function ticks(Blo, Bhi) {
    var span = Bhi - Blo, step = 100;
    [1, 2, 5, 10, 20, 50, 100].some(function (s) { if (span / s <= 8) { step = s; return true; } return false; });
    var vals = []; for (var b = Math.ceil(Blo / step) * step; b <= Bhi + 1e-9; b += step) vals.push(Math.round(b));
    return { Blo: Blo, Bhi: Bhi, step: step, vals: vals };
  }
  // pre = {x, mask, lo, hi, nu}; pr = decoded prediction; fit = reconstruction on the canonical grid (or null)
  function renderPlot(canvas, pre, pr, fit, showFit) {
    css = getComputedStyle(document.documentElement);
    var W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var pad = { l: 40, r: 14, t: 24, b: 46 }, pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    var lo = pre.lo, hi = pre.hi, nu = pre.nu, sc = nu / NU_REF, k, i, y;
    var Blo = (B0 + lo * DB) * sc, Bhi = (B0 + hi * DB) * sc;
    var X = function (kk) { return pad.l + (kk - lo) / (hi - lo) * pw; };
    ctx.font = '11px ' + tok('--mono'); ctx.fillStyle = tok('--ink-3'); ctx.strokeStyle = tok('--grid'); ctx.lineWidth = 1;
    var tk = ticks(Blo, Bhi); ctx.textAlign = 'center';
    tk.vals.forEach(function (b) {
      var xx = pad.l + ((b / sc - B0) / DB - lo) / (hi - lo) * pw;
      ctx.beginPath(); ctx.moveTo(xx, pad.t); ctx.lineTo(xx, pad.t + ph); ctx.stroke();
      ctx.fillText(String(b), xx, pad.t + ph + 16);
    });
    ctx.fillText('B / mT at ' + nu.toFixed(3) + ' GHz', pad.l + pw / 2, pad.t + ph + 32);
    var hmTop = pad.t + ph * 0.80, hmH = ph * 0.18;
    pr.hms.forEach(function (h) {
      var pmax = 0; for (i = 0; i < P_HM; i++) if (h.p[i] > pmax) pmax = h.p[i];
      ctx.beginPath(); ctx.moveTo(X(lo), hmTop + hmH);
      for (i = Math.floor(lo / HM); i <= Math.ceil(hi / HM) && i < P_HM; i++) ctx.lineTo(X(i * HM + HM / 2), hmTop + hmH - h.p[i] / pmax * hmH);
      ctx.lineTo(X(hi), hmTop + hmH); ctx.closePath();
      ctx.globalAlpha = 0.18; ctx.fillStyle = tok('--accent'); ctx.fill(); ctx.globalAlpha = 0.7;
      ctx.strokeStyle = tok('--accent'); ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
    });
    var yTop = pad.t + 6, yH = ph * 0.70, mid = yTop + yH / 2;
    ctx.strokeStyle = tok('--ink'); ctx.lineWidth = 1.2; ctx.beginPath();
    for (k = lo; k <= hi; k++) { y = mid - pre.x[k] * yH / 2; if (k === lo) ctx.moveTo(X(k), y); else ctx.lineTo(X(k), y); }
    ctx.stroke();
    if (showFit && fit) {
      var f = fit, n = hi - lo + 1, M = 5, AtA = [], Atb = [], r, c;
      for (r = 0; r < M; r++) { AtA.push([0, 0, 0, 0, 0]); Atb.push(0); }
      var col = [0, 0, 0, 0, 0];
      for (k = lo; k <= hi; k++) {
        var u = -1 + 2 * (k - lo) / (n - 1);
        col[0] = f[k]; col[1] = 1; col[2] = u; col[3] = u * u; col[4] = u * u * u;
        for (r = 0; r < M; r++) { Atb[r] += col[r] * pre.x[k]; for (c = 0; c < M; c++) AtA[r][c] += col[r] * col[c]; }
      }
      for (c = 0; c < M; c++) {
        var piv = c; for (r = c + 1; r < M; r++) if (Math.abs(AtA[r][c]) > Math.abs(AtA[piv][c])) piv = r;
        var tmp = AtA[c]; AtA[c] = AtA[piv]; AtA[piv] = tmp; var tb = Atb[c]; Atb[c] = Atb[piv]; Atb[piv] = tb;
        if (Math.abs(AtA[c][c]) < 1e-12) continue;
        for (r = c + 1; r < M; r++) { var fct = AtA[r][c] / AtA[c][c]; for (var cc = c; cc < M; cc++) AtA[r][cc] -= fct * AtA[c][cc]; Atb[r] -= fct * Atb[c]; }
      }
      var coef = [0, 0, 0, 0, 0];
      for (r = M - 1; r >= 0; r--) { var sacc = Atb[r]; for (c = r + 1; c < M; c++) sacc -= AtA[r][c] * coef[c]; coef[r] = Math.abs(AtA[r][r]) < 1e-12 ? 0 : sacc / AtA[r][r]; }
      ctx.strokeStyle = tok('--accent'); ctx.lineWidth = 1.6; ctx.beginPath();
      for (k = lo; k <= hi; k++) {
        u = -1 + 2 * (k - lo) / (n - 1);
        var yv = coef[0] * f[k] + coef[1] + coef[2] * u + coef[3] * u * u + coef[4] * u * u * u;
        y = mid - yv * yH / 2; if (k === lo) ctx.moveTo(X(k), y); else ctx.lineTo(X(k), y);
      }
      ctx.stroke();
    }
    ctx.textAlign = 'center'; ctx.font = '11px ' + tok('--mono');
    var lastLabelX = -1e9;
    for (i = 0; i < 3; i++) {
      var kk = (GFAC * NU_REF / pr.g[i] - B0) / DB; if (kk < lo || kk > hi) continue;
      ctx.strokeStyle = tok('--accent'); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(X(kk), pad.t); ctx.lineTo(X(kk), hmTop + hmH); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = tok('--accent-ink');
      var lx = Math.max(X(kk), lastLabelX + 18); ctx.fillText('g' + (i + 1), lx, pad.t - 8); lastLabelX = lx;
    }
    ctx.textAlign = 'left'; ctx.fillStyle = tok('--ink-3');
    ctx.fillText('measured', pad.l + 4, pad.t + 4); ctx.fillStyle = tok('--accent-ink'); ctx.fillText(showFit && fit ? '— reconstruction from the prediction' : '', pad.l + 70, pad.t + 4);
    ctx.fillStyle = tok('--ink-3'); ctx.fillText('g turning-point heatmaps', pad.l + 4, hmTop - 2);
  }

  // ------------------------------------------------------------------ public engine
  window.SuperSpinner = {
    load: load, isReady: function () { return !!session; }, meta: function () { return meta; },
    preprocess: preprocess, predict: predict, reconstruct: reconstruct, renderPlot: renderPlot, toEasySpin: toEasySpin,
    FAM: FAM, constants: { N: N, B0: B0, DB: DB, NU_REF: NU_REF, GFAC: GFAC }
  };

  // ================================================================== held-out spectrum demo (#ss-demo)
  var root = document.getElementById('ss-demo');
  if (!root) return;
  var $ = function (sel) { return root.querySelector(sel); };
  var statusEl = $('.ss-status'), btnStart = $('.ss-start'), btnNew = $('.ss-new'), btnAuto = $('.ss-auto');
  var chkHint = $('.ss-hint'), chkFit = $('.ss-fit'), canvas = $('.ss-canvas'), table = $('.ss-table tbody');
  var noteEl = $('.ss-note'), timeEl = $('.ss-time');
  var auto = null, busy = false, last = null;
  function setStatus(t) { statusEl.textContent = t; }

  async function start() {
    btnStart.disabled = true;
    try {
      await load(setStatus);
      setStatus('Warming up…');
      await runOnce();
      btnStart.hidden = true; btnNew.hidden = false; btnAuto.hidden = false;
      chkHint.disabled = false; chkFit.disabled = false;
      setStatus('Ready. Each click draws a new held-out EasySpin spectrum, degrades it, and fits it.');
    } catch (e) {
      console.error(e);
      setStatus('Could not load the demo: ' + (e && e.message ? e.message : e) + (navigator.onLine === false ? '  (the network runtime comes from a CDN, so this needs an internet connection)' : ''));
      btnStart.disabled = false;
    }
  }

  // measurement simulation (mirrors augment.py step 5)
  function makeCase() {
    var i = Math.floor(R() * meta.n), row = meta.spectra[i];
    var d = new Float64Array(N), k;
    for (k = 0; k < N; k++) d[k] = bank[i * N + k] / 32767;
    var notes = [];
    if (R() < 0.3) {
      var c = 100 + R() * 400, fw = logu(15, 200), sg = fw / 2.3548, amp = logu(0.02, 0.4), peak = 0, bg = new Float64Array(N);
      for (k = 0; k < N; k++) { var x = (B0 + k * DB - c); bg[k] = -(x / (sg * sg)) * Math.exp(-0.5 * x * x / (sg * sg)); if (Math.abs(bg[k]) > peak) peak = Math.abs(bg[k]); }
      for (k = 0; k < N; k++) d[k] += amp * bg[k] / peak;
      notes.push('broad background');
    }
    var ilo = row.ilo, ihi = row.ihi, lo, hi, w = choice([0.30, 0.55, 0.10, 0.05]);
    if (w === 0) { lo = 0; hi = N - 1; notes.push('full 50–550 mT sweep'); }
    else if (w === 1) { lo = Math.max(0, Math.floor(ilo - (2 + R() * 38) / DB)); hi = Math.min(N - 1, Math.floor(ihi + (2 + R() * 38) / DB)); notes.push('window around the signal'); }
    else if (w === 2) { var cc = 0.5 * (ilo + ihi), hw = 0.5 * (ihi - ilo) * (1.5 + 1.5 * R()) + 20 / DB; lo = Math.max(0, Math.floor(cc - hw)); hi = Math.min(N - 1, Math.floor(cc + hw)); notes.push('generous window'); }
    else {
      var span = ihi - ilo;
      if (R() < 0.5) { lo = Math.max(0, Math.floor(ilo + R() * 0.35 * span)); hi = Math.min(N - 1, Math.floor(ihi + (2 + 18 * R()) / DB)); }
      else { lo = Math.max(0, Math.floor(ilo - (2 + 18 * R()) / DB)); hi = Math.min(N - 1, Math.floor(ihi - R() * 0.35 * span)); }
      notes.push('truncated sweep (cuts into the signal)');
    }
    if (hi - lo < 200) { lo = Math.max(0, lo - 100); hi = Math.min(N - 1, hi + 100); }
    var n = hi - lo + 1, seg = new Float64Array(n), mx = -1e9, mn = 1e9;
    for (k = 0; k < n; k++) { seg[k] = d[lo + k]; if (seg[k] > mx) mx = seg[k]; if (seg[k] < mn) mn = seg[k]; }
    var pp = mx - mn + 1e-12, nm = n;
    if (R() < 0.35 && n > 400) { nm = 400 + Math.floor(R() * (Math.min(4096, n) - 400)); notes.push(nm + ' points'); }
    var ym = new Float64Array(nm), p, i0, f;
    for (k = 0; k < nm; k++) { p = k * (n - 1) / (nm - 1); i0 = Math.floor(p); f = p - i0; ym[k] = i0 >= n - 1 ? seg[n - 1] : seg[i0] * (1 - f) + seg[i0 + 1] * f; }
    var snr = R() < 0.35 ? logu(2, 15) : logu(15, 2000), sigma = pp / snr;
    for (k = 0; k < nm; k++) ym[k] += sigma * randn();
    if (R() < 0.4) {
      var br = new Float64Array(nm), s = 0; for (k = 0; k < nm; k++) { s += randn(); br[k] = s; }
      var m0 = br[0], m1 = br[nm - 1], mean = 0; for (k = 0; k < nm; k++) { br[k] -= m0 + (m1 - m0) * k / (nm - 1); mean += br[k]; } mean /= nm;
      var sd = 0; for (k = 0; k < nm; k++) sd += (br[k] - mean) * (br[k] - mean); sd = Math.sqrt(sd / nm) + 1e-12;
      var sc2 = sigma * (0.3 + 1.7 * R()) / sd; for (k = 0; k < nm; k++) ym[k] += br[k] * sc2;
      notes.push('1/f drift');
    }
    var c0 = 0.2 * pp * randn(), cs = [0, 0, 0], deg = 0;
    for (var dg = 1; dg <= 3; dg++) if (R() < 0.6) { cs[dg - 1] = 0.15 * pp * randn(); deg = dg; }
    var sinA = R() < 0.3 ? R() * 0.1 * pp : 0, sinF = 0.5 + 2.5 * R(), sinP = R() * 2 * Math.PI;
    for (k = 0; k < nm; k++) { var u = -1 + 2 * k / (nm - 1); ym[k] += c0 + cs[0] * u + cs[1] * u * u + cs[2] * u * u * u + sinA * Math.sin(2 * Math.PI * sinF * u + sinP); }
    if (deg) notes.push(['linear', 'quadratic', 'cubic'][deg - 1] + ' baseline');
    if (sinA) notes.push('sinusoidal baseline');
    if (R() < 0.03) { var ns = 1 + Math.floor(R() * 3); for (k = 0; k < ns; k++) ym[Math.floor(R() * nm)] += (R() < 0.5 ? -1 : 1) * (1 + 4 * R()) * pp; notes.push(ns + ' spike' + (ns > 1 ? 's' : '')); }
    var xg = new Float32Array(N), mask = new Float32Array(N), mean2 = 0;
    for (k = 0; k < n; k++) { p = k * (nm - 1) / (n - 1); i0 = Math.floor(p); f = p - i0; var v = i0 >= nm - 1 ? ym[nm - 1] : ym[i0] * (1 - f) + ym[i0 + 1] * f; xg[lo + k] = v; mean2 += v; }
    mean2 /= n; var ma = 0;
    for (k = lo; k <= hi; k++) { xg[k] -= mean2; if (Math.abs(xg[k]) > ma) ma = Math.abs(xg[k]); }
    for (k = lo; k <= hi; k++) { xg[k] /= (ma + 1e-12); mask[k] = 1; }
    var known = R() < 0.6;
    notes.unshift('SNR ' + (snr < 10 ? snr.toFixed(1) : Math.round(snr)));
    notes.push(known ? 'modulation amplitude given' : 'modulation amplitude withheld');
    return { row: row, x: xg, mask: mask, lo: lo, hi: hi, nu: row.nu, snr: snr, known: known, notes: notes };
  }

  async function runOnce() {
    if (busy || !session) return; busy = true;
    try {
      var cs = makeCase(); cs.hintNuc = chkHint.checked ? cs.row.nuc : null;
      var inp = buildInputs(cs.x, cs.mask, cs.nu, cs.known ? cs.row.modamp : 0, cs.hintNuc);
      var t0 = performance.now();
      var out = await session.run(inp), o = {};
      Object.keys(out).forEach(function (k) { o[k] = Array.from(out[k].data); });
      var ms = performance.now() - t0;
      var pr = decode(o, cs.mask, cs.nu, cs.hintNuc);
      var fit = reconstruct(pr, cs.nu, cs.row.modamp);
      last = { cs: cs, pr: pr, fit: fit, ms: ms };
      render();
    } finally { busy = false; }
  }
  function fmtPM(v, s, d) { return v.toFixed(d) + ' ± ' + s.toFixed(d); }
  function render() {
    if (!last) return;
    var cs = last.cs, pr = last.pr, row = cs.row;
    renderPlot(canvas, cs, pr, last.fit, chkFit.checked);
    var tr = [], cell = function (ok) { return ok ? ' class="ok"' : ' class="miss"'; };
    var nucT = row.nuc, nucPr = pr.nucName, pn = pr.nucP[pr.nucIdx], famT = FAM[row.family], famPr = pr.famName, i;
    tr.push('<tr><th>Center</th><td>' + nucT + '</td><td' + cell(nucT === nucPr) + '>' + nucPr + (cs.hintNuc ? ' (given)' : ' (' + Math.round(100 * pn) + '%)') + '</td></tr>');
    tr.push('<tr><th>Family</th><td>' + famT + '</td><td' + cell(famT === famPr) + '>' + famPr + ' (' + Math.round(100 * Math.max.apply(null, pr.famP)) + '%)</td></tr>');
    for (i = 0; i < 3; i++) { var err = Math.abs(pr.g[i] - row.g[i]); tr.push('<tr><th>g<sub>' + (i + 1) + '</sub></th><td>' + row.g[i].toFixed(4) + '</td><td' + cell(err <= Math.max(2 * pr.gs[i], 0.003)) + '>' + fmtPM(pr.g[i], pr.gs[i], 4) + '</td></tr>'); }
    if (nucT !== 'none' || nucPr !== 'none') {
      for (i = 0; i < 3; i++) {
        var at = nucT === 'none' ? '—' : row.A[i].toFixed(0), ap = nucPr === 'none' ? '—' : fmtPM(pr.A[i], pr.As[i], 0);
        var okA = nucT !== 'none' && nucPr !== 'none' && Math.abs(pr.A[i] - row.A[i]) <= Math.max(2 * pr.As[i], 10);
        tr.push('<tr><th>A<sub>' + (i + 1) + '</sub> / MHz</th><td>' + at + '</td><td' + cell(okA) + '>' + ap + '</td></tr>');
      }
    }
    tr.push('<tr><th>Gaussian FWHM / mT</th><td>' + row.lwG.toFixed(2) + '</td><td>' + pr.lwG.toFixed(2) + '</td></tr>');
    tr.push('<tr><th>SNR</th><td>' + (cs.snr < 10 ? cs.snr.toFixed(1) : Math.round(cs.snr)) + '</td><td>' + (pr.snr < 10 ? pr.snr.toFixed(1) : Math.round(pr.snr)) + '</td></tr>');
    table.innerHTML = tr.join('');
    noteEl.textContent = 'This measurement: ' + cs.notes.join(' · ') + '.';
    timeEl.textContent = 'network forward pass ' + last.ms.toFixed(0) + ' ms in your browser';
  }

  btnStart.addEventListener('click', start);
  btnNew.addEventListener('click', runOnce);
  btnAuto.addEventListener('click', function () {
    if (auto) { clearInterval(auto); auto = null; btnAuto.textContent = 'Auto-run'; }
    else { runOnce(); auto = setInterval(runOnce, 2500); btnAuto.textContent = 'Stop'; }
  });
  chkFit.addEventListener('change', render);
  window.addEventListener('resize', render);

  // headless self-test: demo.html?ss=auto&runs=N logs one JSON line per case into #ss-log
  var qs = new URLSearchParams(location.search);
  if (qs.get('ss') === 'auto') {
    var logEl = document.getElementById('ss-log');
    start().then(async function () {
      var runs = parseInt(qs.get('runs') || '20', 10);
      if (qs.get('hint') === '1') chkHint.checked = true;
      for (var r = 0; r < runs; r++) {
        await runOnce();
        var L = last, row = L.cs.row, pr = L.pr;
        if (logEl) logEl.textContent += JSON.stringify({ fam: row.family, nuc: row.nuc, nucPred: pr.nucName, hint: !!L.cs.hintNuc,
          dg: pr.g.map(function (v, i) { return +(Math.abs(v - row.g[i])).toFixed(5); }), gsrc: pr.gsrc,
          dA: row.nuc === 'none' ? null : pr.A.map(function (v, i) { return +Math.abs(v - row.A[i]).toFixed(1); }),
          snr: +L.cs.snr.toFixed(1), snrPred: +pr.snr.toFixed(1), ms: +L.ms.toFixed(0), notes: L.cs.notes }) + '\n';
      }
      if (logEl) logEl.textContent += 'DONE\n';
    });
  }
})();
