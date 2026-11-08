/* Sweeps for the D4h Tanabe-Sugano page: 1D cuts and 2D grids of labelled levels. Conventions: TS_D4h/PLAN.md.
   Runs as a Web Worker (new Worker('ts-d4h/worker.js')) or as a plain script after engine.js, where it adds
   TSD4h.sweep and TSD4h.maps for the main thread.

   A sweep maps grid coordinates (a, b) to the field bilinearly, key = c0 + ca a + cb b + cab a b for
   key in Dq, Ds, Dt (all in units of B), which covers fixed-ratio TS cuts, fixed-Dq planes and
   (Dq, Dt/Dq) planes. Request:
     { id, n, CB, map: {Dq: [c0, ca, cb, cab], Ds: [...], Dt: [...]}, a: [lo, hi, count], b: [lo, hi, count] (optional),
       opts: { parents, cfg, subtractGround, oh, ci } }
   Point index = ib * na + ia. Surfaces are (S, irrep, rank) inside one symmetry block, so a surface keeps its
   identity across the whole sweep; same-block surfaces can only touch at conical intersections.
   Result (typed arrays are transferred from the worker):
     { n, CB, na, nb, a, b, np, surfaces: [{key, mult, irrep, rank, dim, row}] (sorted by mean energy),
       E (surface row-major, row * np + point), ground (absolute ground energy), groundRow,
       parent, parentW, parentNames (Oh parent at the same Dq: index into parentNames, overlap weight),
       cfg, cfgW, cfgList (dominant configuration [b2g, eg, a1g, b1g] and its weight),
       with opts.oh also the Oh levels at (Dq, 0, 0) of every point (what an Ds = Dt = 0 cut should draw):
       ohNames (sorted by mean energy), ohE (name row-major), ohCfg, ohCfgW, ohCfgList ([t2g, eg]),
       with opts.ci on a 2D grid the conical intersections cis [{lower, upper, mult, irrep, a, b, Dq, Ds, Dt, E,
       Erel (from the ground state there), gap, flip, onAxis, parents, parentW}] and ciInfo, ms }
   Worker messages: { id, type: 'progress', done, total }, then { id, type: 'result', ... } or { id, type: 'error' }. */
(function (root) {
  'use strict';
  if (!root.TSD4h && typeof importScripts === 'function') importScripts('engine.js?v=3');
  var TS = root.TSD4h, shells = {};

  function shell(n) { return shells[n] || (shells[n] = new TS.Shell(n)); }

  function axis(ax) {
    var cnt = Math.max(1, Math.round(ax[2])), out = new Float64Array(cnt);
    for (var i = 0; i < cnt; i++) out[i] = cnt === 1 ? ax[0] : ax[0] + (ax[1] - ax[0]) * i / (cnt - 1);
    return out;
  }

  function at(c, a, b) { return c[0] + c[1] * a + c[2] * b + c[3] * a * b; }

  function sweep(req, progress) {
    var t0 = Date.now(), sh = shell(req.n), CB = req.CB, map = req.map, opts = req.opts || {};
    var A = axis(req.a), B = req.b ? axis(req.b) : Float64Array.of(0), na = A.length, nb = B.length, np = na * nb;
    var blks = [], first = [], surf = [];
    sh.blocks.forEach(function (blk, bi) {
      if (blk.mod4 === 3) return;                                 // second Eg row: same energies as mod4 = 1
      first.push(surf.length);
      blks.push({ blk: blk, bi: bi, local: localCfg(blk) });
      for (var r = 0; r < blk.size; r++) {
        surf.push({ key: blk.mult + blk.irrep + '#' + (r + 1), mult: blk.mult, irrep: blk.irrep, rank: r + 1,
                    dim: blk.irrep === 'Eg' ? 2 : 1, row: surf.length });
      }
    });
    var ns = surf.length, E = new Float64Array(ns * np), ground = new Float64Array(np), groundRow = new Int16Array(np);
    var parent = opts.parents ? new Int16Array(ns * np) : null, parentW = opts.parents ? new Float32Array(ns * np) : null;
    var cfg = opts.cfg ? new Int16Array(ns * np) : null, cfgW = opts.cfg ? new Float32Array(ns * np) : null;
    var parentNames = [], parentIdx = {}, ohCache = {}, ohLast = null, ohLastDq = NaN;
    var ohCfgList = [], ohCfgIdx = {}, ohE = null, ohCfg = null, ohCfgW = null, ohNames = null;

    // Oh states at (Dq, 0, 0): per block {Y, idx (parentNames indices)}, and per Oh level its energy and
    // dominant t2g^a eg^b configuration (taken from the first block that holds a component)
    function ohAt(Dq) {
      if (Dq === ohLastDq) return ohLast;
      var key = String(Dq), o = ohCache[key];
      if (!o) {
        var levels = {}, states = sh.ohStates(CB, Dq);
        o = { levels: levels, blocks: states.map(function (s, bi) {
          if (!s) return null;
          var blk = sh.blocks[bi], k = blk.size;
          s.names.forEach(function (nm, j) {
            if (nm in levels) return;
            var w = {}, best = -1, bk = '';
            for (var l = 0; l < k; l++) {
              var c = sh.cfgList[blk.colCfg[l]], ck = (c[0] + c[1]) + ',' + (c[2] + c[3]);
              w[ck] = (w[ck] || 0) + s.Y[l * k + j] * s.Y[l * k + j];
            }
            Object.keys(w).forEach(function (ck) { if (w[ck] > best) { best = w[ck]; bk = ck; } });
            if (!(bk in ohCfgIdx)) { ohCfgIdx[bk] = ohCfgList.length; ohCfgList.push(bk.split(',').map(Number)); }
            levels[nm] = { E: s.E[j], cfg: ohCfgIdx[bk], w: best };
          });
          return { Y: s.Y, idx: s.names.map(function (nm) {
            if (!(nm in parentIdx)) { parentIdx[nm] = parentNames.length; parentNames.push(nm); }
            return parentIdx[nm];
          }) };
        }) };
        ohCache[key] = o;
      }
      ohLastDq = Dq; ohLast = o;
      return o;
    }

    var p = { CB: CB, Dq: 0, Ds: 0, Dt: 0 }, step = Math.max(1, Math.floor(np / 50));
    for (var ib = 0; ib < nb; ib++) for (var ia = 0; ia < na; ia++) {
      var pt = ib * na + ia, a = A[ia], b = B[ib];
      p.Dq = at(map.Dq, a, b); p.Ds = at(map.Ds, a, b); p.Dt = at(map.Dt, a, b);
      var oh = parent || opts.oh ? ohAt(p.Dq) : null, gmin = Infinity, grow = -1;
      if (opts.oh) {
        if (!ohNames) {
          ohNames = Object.keys(oh.levels);
          ohE = new Float64Array(ohNames.length * np); ohCfg = new Int16Array(ohNames.length * np);
          ohCfgW = new Float32Array(ohNames.length * np);
        }
        for (var h = 0; h < ohNames.length; h++) {
          var lv = oh.levels[ohNames[h]];
          ohE[h * np + pt] = lv.E; ohCfg[h * np + pt] = lv.cfg; ohCfgW[h * np + pt] = lv.w;
        }
      }
      for (var q = 0; q < blks.length; q++) {
        var blk = blks[q].blk, k = blk.size, eig = TS.jacobiEig(sh.blockMatrix(blk, p), k), V = eig.vectors;
        var loc = blks[q].local, w = cfg ? new Float64Array(loc.list.length) : null;
        for (var c = 0; c < k; c++) {
          var row = first[q] + c, e = eig.values[c], l;
          E[row * np + pt] = e;
          if (e < gmin) { gmin = e; grow = row; }
          if (cfg) {
            w.fill(0);
            for (l = 0; l < k; l++) w[loc.col[l]] += V[l * k + c] * V[l * k + c];
            var bw = -1, bc = 0;
            for (l = 0; l < w.length; l++) if (w[l] > bw) { bw = w[l]; bc = l; }
            cfg[row * np + pt] = loc.list[bc]; cfgW[row * np + pt] = bw;
          }
          if (parent) {
            var ob = oh.blocks[blks[q].bi], Y = ob.Y, best = -1, bj = 0;
            for (var j = 0; j < k; j++) {
              var d = 0;
              for (l = 0; l < k; l++) d += V[l * k + c] * Y[l * k + j];
              if (d * d > best) { best = d * d; bj = j; }
            }
            parent[row * np + pt] = ob.idx[bj]; parentW[row * np + pt] = best;
          }
        }
      }
      ground[pt] = gmin; groundRow[pt] = grow;
      if (progress && (pt + 1) % step === 0) progress(pt + 1, np);
    }
    if (opts.subtractGround) {
      for (var s = 0; s < ns; s++) for (var t = 0; t < np; t++) E[s * np + t] -= ground[t];
      if (ohE) for (s = 0; s < ohNames.length; s++) for (t = 0; t < np; t++) ohE[s * np + t] -= ground[t];
    }
    if (ohNames) {                                                // Oh levels sorted by mean energy
      var om = ohNames.map(function (nm, h) { var m = 0; for (var t = 0; t < np; t++) m += ohE[h * np + t]; return [m, h]; });
      om.sort(function (x, y) { return x[0] - y[0] || (ohNames[x[1]] < ohNames[y[1]] ? -1 : 1); });
      var oE = new Float64Array(ohE.length), oC = new Int16Array(ohE.length), oW = new Float32Array(ohE.length);
      om.forEach(function (x, r) {
        oE.set(ohE.subarray(x[1] * np, (x[1] + 1) * np), r * np);
        oC.set(ohCfg.subarray(x[1] * np, (x[1] + 1) * np), r * np);
        oW.set(ohCfgW.subarray(x[1] * np, (x[1] + 1) * np), r * np);
      });
      ohNames = om.map(function (x) { return ohNames[x[1]]; }); ohE = oE; ohCfg = oC; ohCfgW = oW;
    }

    var cis = null, ciInfo = null;
    if (opts.ci && nb > 1 && na > 1) {
      var found = findCIs(sh, blks, first, surf, req, A, B, E, np);
      cis = found.list; ciInfo = found.info;
    }

    var mean = surf.map(function (S) {
      var m = 0;
      for (var t = 0; t < np; t++) m += E[S.row * np + t];
      return m / np;
    });
    surf.sort(function (x, y) { return mean[x.row] - mean[y.row] || (x.key < y.key ? -1 : 1); });
    return {
      n: req.n, CB: CB, na: na, nb: nb, a: A, b: B, np: np, surfaces: surf, E: E, ground: ground, groundRow: groundRow,
      parent: parent, parentW: parentW, parentNames: parentNames, cfg: cfg, cfgW: cfgW, cfgList: sh.cfgList,
      ohNames: ohNames, ohE: ohE, ohCfg: ohCfg, ohCfgW: ohCfgW, ohCfgList: ohCfgList, cis: cis, ciInfo: ciInfo,
      ms: Date.now() - t0
    };
  }

  // ---------------------------------------------------------------- conical intersections
  // Same-block neighbours (k, k+1) only (different blocks cross freely). Candidates are local minima of their
  // gap on the grid; each is refined by Newton steps on the two degeneracy conditions of the 2 x 2 model in
  // the pair's eigenvectors, h11 = h22 and h12 = 0 (exact to first order in the step), and accepted when the gap
  // is below 1e-6 B and state k's eigenvector changes sign around a small loop (geometric phase pi). Pairs
  // that are degenerate over the whole grid (the d5 4A1g pair) are listed in info.skipped, not searched.
  function fieldOf(req, a, b) {
    return { CB: req.CB, Dq: at(req.map.Dq, a, b), Ds: at(req.map.Ds, a, b), Dt: at(req.map.Dt, a, b) };
  }
  function dH(blk, map, a, b, which) {                          // d(block H)/da (which 0) or d/db (which 1)
    var k = blk.size, M = new Float64Array(k * k);
    ['Dq', 'Ds', 'Dt'].forEach(function (key) {
      var c = map[key], f = which === 0 ? c[1] + c[3] * b : c[2] + c[3] * a;
      if (f === 0) return;
      for (var i = 0; i < k * k; i++) M[i] += f * blk[key][i];
    });
    return M;
  }
  function quad(M, k, V, i, j) {                                // column i of V, transposed, times M times column j
    var s = 0;
    for (var r = 0; r < k; r++) {
      var vi = V[r * k + i];
      if (vi === 0) continue;
      var t = 0;
      for (var l = 0; l < k; l++) t += M[r * k + l] * V[l * k + j];
      s += vi * t;
    }
    return s;
  }
  function col(V, k, c) { var v = new Float64Array(k); for (var r = 0; r < k; r++) v[r] = V[r * k + c]; return v; }
  function dot(x, y) { var s = 0; for (var i = 0; i < x.length; i++) s += x[i] * y[i]; return s; }

  function refine(sh, blk, req, c, a, b, ha, hb, box) {
    var k = blk.size, eig, gap;
    for (var it = 0; it < 40; it++) {
      eig = TS.jacobiEig(sh.blockMatrix(blk, fieldOf(req, a, b)), k);
      gap = eig.values[c + 1] - eig.values[c];
      if (gap < 1e-10) break;
      var V = eig.vectors, Ma = dH(blk, req.map, a, b, 0), Mb = dH(blk, req.map, a, b, 1);
      var m11 = quad(Ma, k, V, c, c) - quad(Ma, k, V, c + 1, c + 1), m12 = quad(Mb, k, V, c, c) - quad(Mb, k, V, c + 1, c + 1);
      var m21 = quad(Ma, k, V, c, c + 1), m22 = quad(Mb, k, V, c, c + 1), det = m11 * m22 - m12 * m21;
      var norm = Math.abs(m11) + Math.abs(m12) + Math.abs(m21) + Math.abs(m22);
      if (!(Math.abs(det) > 1e-12 * norm * norm)) return null;       // degenerate branching plane: not a cone
      var da = gap * m22 / det, db = -gap * m21 / det, sc = Math.max(1, Math.abs(da) / (2 * ha), Math.abs(db) / (2 * hb));
      a += da / sc; b += db / sc;
      if (a < box[0] - 1e-9 * ha || a > box[1] + 1e-9 * ha || b < box[2] - 1e-9 * hb || b > box[3] + 1e-9 * hb) return null;
    }
    return gap < 1e-6 ? { a: a, b: b, gap: gap, eig: eig } : null;
  }

  // track state c's eigenvector around an ellipse; a cone flips its sign
  function loopFlip(sh, blk, req, c, a0, b0, ra, rb) {
    var k = blk.size, N = 48, v0 = null, prev = null, minDot = 1;
    for (var s = 0; s <= N; s++) {
      var th = 2 * Math.PI * s / N, eig = TS.jacobiEig(sh.blockMatrix(blk, fieldOf(req, a0 + ra * Math.cos(th), b0 + rb * Math.sin(th))), k);
      var v = col(eig.vectors, k, c);
      if (prev) {
        var d = dot(prev, v);
        if (d < 0) { for (var r = 0; r < k; r++) v[r] = -v[r]; d = -d; }
        minDot = Math.min(minDot, d);
      } else v0 = v;
      prev = v;
    }
    return { flip: dot(prev, v0) < -0.99, minDot: minDot };
  }

  function findCIs(sh, blks, first, surf, req, A, B, E, np) {
    var na = A.length, nb = B.length, ha = (A[na - 1] - A[0]) / (na - 1), hb = (B[nb - 1] - B[0]) / (nb - 1);
    var box = [Math.min(A[0], A[na - 1]), Math.max(A[0], A[na - 1]), Math.min(B[0], B[nb - 1]), Math.max(B[0], B[nb - 1])];
    ha = Math.abs(ha); hb = Math.abs(hb);
    var list = [], info = { candidates: 0, rejected: 0, unconfirmed: 0, skipped: [] }, G = new Float64Array(np);
    blks.forEach(function (bq, q) {
      var blk = bq.blk, k = blk.size;
      for (var c = 0; c + 1 < k; c++) {
        var r0 = (first[q] + c) * np, r1 = r0 + np, gmax = 0;
        for (var t = 0; t < np; t++) { G[t] = E[r1 + t] - E[r0 + t]; gmax = Math.max(gmax, G[t]); }
        var keyLo = surf[first[q] + c].key, keyHi = surf[first[q] + c + 1].key;
        if (gmax < 1e-9) { info.skipped.push(keyLo + '/' + keyHi); continue; }
        for (var ib = 0; ib < nb; ib++) for (var ia = 0; ia < na; ia++) {
          var g = G[ib * na + ia], isMin = true;
          for (var db = -1; db <= 1 && isMin; db++) for (var da = -1; da <= 1; da++) {
            if (!da && !db) continue;
            var ja = ia + da, jb = ib + db;
            if (ja < 0 || jb < 0 || ja >= na || jb >= nb) continue;
            var h = G[jb * na + ja];
            if (h < g || (h === g && jb * na + ja < ib * na + ia)) { isMin = false; break; }
          }
          if (!isMin) continue;
          info.candidates++;
          var R = refine(sh, blk, req, c, A[ia], B[ib], ha, hb, box);
          if (!R) { info.rejected++; continue; }
          var dup = list.some(function (x) { return x.lower === keyLo && Math.abs(x.a - R.a) / ha + Math.abs(x.b - R.b) / hb < 1e-4; });
          if (dup) continue;
          var lp = null;
          for (var sc = 0.2; sc > 0.01 && !(lp && lp.minDot > 0.9); sc /= 2) lp = loopFlip(sh, blk, req, c, R.a, R.b, sc * ha, sc * hb);
          if (!lp.flip) { info.unconfirmed++; continue; }
          var f = fieldOf(req, R.a, R.b), ground = Infinity;
          blks.forEach(function (x) { ground = Math.min(ground, TS.jacobiEig(sh.blockMatrix(x.blk, f), x.blk.size).values[0]); });
          // Oh parents of the degenerate pair: weight of each Oh state of this block in the pair's 2D subspace
          var st = sh.ohStates(req.CB, f.Dq)[bq.bi], v1 = col(R.eig.vectors, k, c), v2 = col(R.eig.vectors, k, c + 1), pw = [];
          st.names.forEach(function (nm, j) { var y = col(st.Y, k, j), x1 = dot(y, v1), x2 = dot(y, v2); pw.push([x1 * x1 + x2 * x2, nm]); });
          pw.sort(function (x, y) { return y[0] - x[0]; });
          var E0 = 0.5 * (R.eig.values[c] + R.eig.values[c + 1]), tol = 1e-7 * Math.max(1, Math.abs(f.Dq));
          list.push({ lower: keyLo, upper: keyHi, mult: blk.mult, irrep: blk.irrep, a: R.a, b: R.b, Dq: f.Dq, Ds: f.Ds, Dt: f.Dt,
                      E: E0, Erel: E0 - ground, gap: R.gap, flip: true, onAxis: Math.abs(f.Ds) < tol && Math.abs(f.Dt) < tol,
                      parents: [pw[0][1], pw[1][1]], parentW: [pw[0][0], pw[1][0]] });
        }
      }
    });
    list.sort(function (x, y) { return x.E - y.E; });
    return { list: list, info: info };
  }

  // Crossings of Oh levels along the Oh axis (Ds = Dt = 0) between Dq0 and Dq1 that share a D4h block, i.e.
  // T1g x T2g (Eg block), A1g x Eg (A1g block), A2g x Eg (B1g block) of the same spin; bisection to 1e-12.
  // Identically degenerate pairs (the d5 4A1g + 4Eg from 4G) are not crossings and are skipped.
  function ohCrossings(n, CB, Dq0, Dq1, steps) {
    var sh = shell(n), out = [], N = steps || 400;
    function energies(Dq) {
      var m = {};
      sh.ohStates(CB, Dq).forEach(function (s, bi) { if (s) s.names.forEach(function (nm, j) { (m[bi] = m[bi] || {})[nm] = s.E[j]; }); });
      return m;
    }
    function irr(nm) { return nm.replace(/^\d+/, '').replace(/#\d+$/, ''); }
    var grid = [];
    for (var i = 0; i <= N; i++) { var Dq = Dq0 + (Dq1 - Dq0) * i / N; grid.push([Dq, energies(Dq)]); }
    Object.keys(grid[0][1]).forEach(function (bi) {
      var names = Object.keys(grid[0][1][bi]);
      for (var x = 0; x < names.length; x++) for (var y = x + 1; y < names.length; y++) {
        var p = names[x], q = names[y];
        if (irr(p) === irr(q)) continue;
        var dmax = 0;
        grid.forEach(function (g) { dmax = Math.max(dmax, Math.abs(g[1][bi][p] - g[1][bi][q])); });
        if (dmax < 1e-9) continue;
        for (var i = 0; i < N; i++) {
          var d0 = grid[i][1][bi][p] - grid[i][1][bi][q], d1 = grid[i + 1][1][bi][p] - grid[i + 1][1][bi][q];
          if (d0 === 0 || d0 * d1 > 0) continue;
          var lo = grid[i][0], hi = grid[i + 1][0], dlo = d0;
          for (var it = 0; it < 60 && hi - lo > 1e-12; it++) {
            var mid = 0.5 * (lo + hi), em = energies(mid)[bi], dm = em[p] - em[q];
            if (dm * dlo > 0) { lo = mid; dlo = dm; } else hi = mid;
          }
          var Dq = 0.5 * (lo + hi), e = energies(Dq)[bi];
          out.push({ Dq: Dq, E: 0.5 * (e[p] + e[q]), names: [p, q].sort(), block: sh.blocks[bi].mult + sh.blocks[bi].irrep });
        }
      }
    });
    return out.sort(function (x, y) { return x.Dq - y.Dq; });
  }

  // per block: the distinct configurations of its basis columns and each column's local index
  function localCfg(blk) {
    var list = [], pos = {}, col = new Int16Array(blk.size);
    for (var l = 0; l < blk.size; l++) {
      var ci = blk.colCfg[l];
      if (!(ci in pos)) { pos[ci] = list.length; list.push(ci); }
      col[l] = pos[ci];
    }
    return { list: list, col: col };
  }

  // common maps (grid coordinates a, b -> Dq, Ds, Dt)
  var maps = {
    ratioCut: function (rs, rt) { return { Dq: [0, 1, 0, 0], Ds: [0, rs, 0, 0], Dt: [0, rt, 0, 0] }; },   // a = Dq/B
    fixedDq: function (Dq) { return { Dq: [Dq, 0, 0, 0], Ds: [0, 1, 0, 0], Dt: [0, 0, 1, 0] }; },          // a = Ds, b = Dt
    ratioPlane: function (rs) { return { Dq: [0, 1, 0, 0], Ds: [0, rs, 0, 0], Dt: [0, 0, 0, 1] }; },       // a = Dq, b = Dt/Dq
    line: function (p0, p1) {                                                                              // a in [0, 1]
      return { Dq: [p0.Dq, p1.Dq - p0.Dq, 0, 0], Ds: [p0.Ds, p1.Ds - p0.Ds, 0, 0], Dt: [p0.Dt, p1.Dt - p0.Dt, 0, 0] };
    }
  };

  // Ground state on a voxel grid over (Dq, Ds, Dt)/B. Request {cmd: 'ground', id, n, CB, q: [lo, hi, n],
  // s: [...], t: [...]}. Every block's lowest level (rank 1) is kept per voxel, so the page can draw domain
  // boundaries as isosurfaces of E_T - min_{U != T} E_U. Voxel index v = (it * ns + is) * nq + iq.
  // Result: {n, CB, q, s, t (axis arrays), nq, ns, nt, nv, keys ['4B1g#1', ...], low (key row-major, row * nv + v),
  // ground (Int16 index into keys), ms}.
  function groundMap(req, progress) {
    var t0 = Date.now(), sh = shell(req.n), Q = axis(req.q), S = axis(req.s), T = axis(req.t);
    var nq = Q.length, ns = S.length, nt = T.length, nv = nq * ns * nt, blks = [], keys = [];
    sh.blocks.forEach(function (blk) {
      if (blk.mod4 === 3) return;
      blks.push(blk); keys.push(blk.mult + blk.irrep + '#1');
    });
    var nk = blks.length, low = new Float64Array(nk * nv), ground = new Int16Array(nv), p = { CB: req.CB, Dq: 0, Ds: 0, Dt: 0 };
    var step = Math.max(1, Math.floor(nv / 50));
    for (var it = 0; it < nt; it++) for (var is = 0; is < ns; is++) for (var iq = 0; iq < nq; iq++) {
      var v = (it * ns + is) * nq + iq, best = Infinity, bk = 0;
      p.Dq = Q[iq]; p.Ds = S[is]; p.Dt = T[it];
      for (var k = 0; k < nk; k++) {
        var e = TS.jacobiEig(sh.blockMatrix(blks[k], p), blks[k].size).values[0];
        low[k * nv + v] = e;
        if (e < best) { best = e; bk = k; }
      }
      ground[v] = bk;
      if (progress && (v + 1) % step === 0) progress(v + 1, nv);
    }
    return { n: req.n, CB: req.CB, q: Q, s: S, t: T, nq: nq, ns: ns, nt: nt, nv: nv, keys: keys, low: low, ground: ground,
             ms: Date.now() - t0 };
  }

  TS.sweep = sweep;
  TS.maps = maps;
  TS.ohCrossings = ohCrossings;
  TS.groundMap = groundMap;

  if (typeof importScripts === 'function' && typeof root.document === 'undefined') {
    root.onmessage = function (ev) {
      var req = ev.data;
      try {
        var prog = function (done, total) { root.postMessage({ id: req.id, type: 'progress', done: done, total: total }); };
        var res = req.cmd === 'ground' ? groundMap(req, prog) : sweep(req, prog);
        res.id = req.id; res.type = 'result';
        var tr = [res.a, res.b, res.E, res.ground, res.groundRow, res.parent, res.parentW, res.cfg, res.cfgW, res.ohE,
                  res.ohCfg, res.ohCfgW, res.q, res.s, res.t, res.low]
          .filter(Boolean).map(function (x) { return x.buffer; });
        root.postMessage(res, tr);
      } catch (e) {
        root.postMessage({ id: req.id, type: 'error', message: String(e && e.stack || e) });
      }
    };
  }
})(typeof self !== 'undefined' ? self : this);
