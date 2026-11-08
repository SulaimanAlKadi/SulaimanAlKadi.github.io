/* D4h d^n ligand-field engine for the Tanabe-Sugano page. Conventions: TS_D4h/PLAN.md.
   Energies in units of B (B = 1, C = CB, F0 = 0). Validated against TS_D4h/ref/d4h_ref.py by ts-d4h/test.html.

   Orbital basis (D4h orbitals, so the one-electron operator is diagonal for every Dq, Ds, Dt):
     eg+ = |1>, eg- = |-1>, b2g = (|2> - |-2>)/sqrt2, a1g = |0> (z2), b1g = (|2> + |-2>)/sqrt2 (x2-y2).
   Determinants of the lowest-|M_S| block are split by M_L mod 4 (0: A1g/A2g, 2: B1g/B2g, 1 and 3: the two Eg
   rows), then by the C2'(x) eigenvalue (+1: A1g, B1g; -1: A2g, B2g), then by S. Every block has a single
   (S, irrep), so levels are labelled by construction, never by clustering eigenvalues. */
(function (root) {
  'use strict';

  var MS = [2, 1, 0, -1, -2];                                   // complex basis order
  var ORB = ['eg', 'eg', 'b2g', 'a1g', 'b1g'];
  var MOD4 = [1, 3, 2, 0, 2];                                   // M_L mod 4 of each orbital
  var UNIT = { Dq: [-4, -4, -4, 6, 6], Ds: [-1, -1, 2, -2, 2], Dt: [4, 4, -1, -6, -1] };
  var C2X_IMG = [1, 0, 2, 3, 4], C2X_PH = [1, 1, -1, 1, 1];      // C2'(x): orbital j -> PH[j] * orbital IMG[j]
  var CFG_ORDER = ['b2g', 'eg', 'a1g', 'b1g'];
  var R2 = Math.SQRT1_2;
  var T = [[0, 1, 0, 0, 0], [0, 0, 0, 1, 0], [R2, 0, 0, 0, -R2], [0, 0, 1, 0, 0], [R2, 0, 0, 0, R2]];

  // ---------------------------------------------------------------- angular algebra
  var FACT = [1];
  for (var f = 1; f <= 30; f++) FACT[f] = FACT[f - 1] * f;

  function wigner3j(j1, j2, j3, m1, m2, m3) {
    if (m1 + m2 + m3 !== 0 || j3 < Math.abs(j1 - j2) || j3 > j1 + j2) return 0;
    if (Math.abs(m1) > j1 || Math.abs(m2) > j2 || Math.abs(m3) > j3) return 0;
    var x1 = j3 - j2 + m1, x2 = j3 - j1 - m2, x3 = j1 + j2 - j3, x4 = j1 - m1, x5 = j2 + m2;
    var tmin = Math.max(0, -x1, -x2), tmax = Math.min(x3, x4, x5), sum = 0;
    for (var t = tmin; t <= tmax; t++) {
      sum += (t % 2 ? -1 : 1) / (FACT[t] * FACT[x1 + t] * FACT[x2 + t] * FACT[x3 - t] * FACT[x4 - t] * FACT[x5 - t]);
    }
    var tri = FACT[j1 + j2 - j3] * FACT[j1 - j2 + j3] * FACT[-j1 + j2 + j3] / FACT[j1 + j2 + j3 + 1];
    var pre = Math.sqrt(tri * FACT[j1 + m1] * FACT[j1 - m1] * FACT[j2 + m2] * FACT[j2 - m2] * FACT[j3 + m3] * FACT[j3 - m3]);
    return ((j1 - j2 - m3) % 2 ? -1 : 1) * pre * sum;
  }

  // c^k(m, m') = <2m|C^k_(m-m')|2m'> (Condon-Shortley)
  function ck(k, m, mp) {
    return (m % 2 ? -1 : 1) * 5 * wigner3j(2, k, 2, 0, 0, 0) * wigner3j(2, k, 2, -m, m - mp, mp);
  }

  // <ab|cd> per F^k in the orbital basis (a, c electron 1; b, d electron 2), flat index ((a*5+b)*5+c)*5+d
  function orbitalIntegrals(k) {
    var gc = new Float64Array(625), G = new Float64Array(625), a, b, c, d;
    for (a = 0; a < 5; a++) for (b = 0; b < 5; b++) for (c = 0; c < 5; c++) for (d = 0; d < 5; d++) {
      if (MS[a] + MS[b] === MS[c] + MS[d]) gc[((a * 5 + b) * 5 + c) * 5 + d] = ck(k, MS[a], MS[c]) * ck(k, MS[d], MS[b]);
    }
    // four successive index transformations with the real matrix T
    var cur = gc;
    for (var axis = 0; axis < 4; axis++) {
      var nxt = new Float64Array(625);
      for (var idx = 0; idx < 625; idx++) {
        var v = cur[idx];
        if (v === 0) continue;
        var dig = [Math.floor(idx / 125), Math.floor(idx / 25) % 5, Math.floor(idx / 5) % 5, idx % 5];
        for (var i = 0; i < 5; i++) {
          var tv = T[i][dig[axis]];
          if (tv === 0) continue;
          var nd = dig.slice(); nd[axis] = i;
          nxt[((nd[0] * 5 + nd[1]) * 5 + nd[2]) * 5 + nd[3]] += tv * v;
        }
      }
      cur = nxt;
    }
    G.set(cur);
    return G;
  }

  var G2 = orbitalIntegrals(2), G4 = orbitalIntegrals(4);

  // ---------------------------------------------------------------- dense linear algebra (row-major)
  function jacobiEig(Ain, n) {
    var A = Float64Array.from(Ain), V = new Float64Array(n * n), i, p, q, r;
    for (i = 0; i < n; i++) V[i * n + i] = 1;
    var scale = 0;
    for (i = 0; i < n * n; i++) scale += A[i] * A[i];
    for (var sweep = 0; sweep < 100; sweep++) {
      var off = 0;
      for (p = 0; p < n; p++) for (q = p + 1; q < n; q++) off += A[p * n + q] * A[p * n + q];
      if (off <= 1e-30 * scale || off === 0) break;
      for (p = 0; p < n - 1; p++) for (q = p + 1; q < n; q++) {
        var apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        var theta = (A[q * n + q] - A[p * n + p]) / (2 * apq);
        var t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        var c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (r = 0; r < n; r++) {                                  // columns p, q
          var arp = A[r * n + p], arq = A[r * n + q];
          A[r * n + p] = c * arp - s * arq;
          A[r * n + q] = s * arp + c * arq;
        }
        for (r = 0; r < n; r++) {                                  // rows p, q
          var apr = A[p * n + r], aqr = A[q * n + r];
          A[p * n + r] = c * apr - s * aqr;
          A[q * n + r] = s * apr + c * aqr;
        }
        for (r = 0; r < n; r++) {
          var vrp = V[r * n + p], vrq = V[r * n + q];
          V[r * n + p] = c * vrp - s * vrq;
          V[r * n + q] = s * vrp + c * vrq;
        }
      }
    }
    var order = [];
    for (i = 0; i < n; i++) order.push(i);
    order.sort(function (x, y) { return A[x * n + x] - A[y * n + y]; });
    var values = new Float64Array(n), vectors = new Float64Array(n * n);   // vectors: column j = eigenvector j
    for (var j = 0; j < n; j++) {
      values[j] = A[order[j] * n + order[j]];
      for (i = 0; i < n; i++) vectors[i * n + j] = V[i * n + order[j]];
    }
    return { values: values, vectors: vectors };
  }

  // W^T M W for W (N x k, row-major) and M (N x N)
  function project(M, W, N, k) {
    var MW = new Float64Array(N * k), out = new Float64Array(k * k), i, j, l;
    for (i = 0; i < N; i++) for (l = 0; l < N; l++) {
      var m = M[i * N + l];
      if (m === 0) continue;
      for (j = 0; j < k; j++) MW[i * k + j] += m * W[l * k + j];
    }
    for (i = 0; i < k; i++) for (j = 0; j < k; j++) {
      var s = 0;
      for (l = 0; l < N; l++) s += W[l * k + i] * MW[l * k + j];
      out[i * k + j] = s;
    }
    return out;
  }

  // ---------------------------------------------------------------- determinants (10-bit masks; bit 2o = o alpha)
  function popcount(x) { var c = 0; while (x) { x &= x - 1; c++; } return c; }
  function sgn(mask, p) { return popcount(mask & ((1 << p) - 1)) & 1 ? -1 : 1; }
  function msTwice(mask) { var s = 0; for (var p = 0; p < 10; p++) if (mask & (1 << p)) s += p & 1 ? -1 : 1; return s; }

  function detsFor(n, ms2) {
    var out = [];
    for (var m = 0; m < 1024; m++) if (popcount(m) === n && msTwice(m) === ms2) out.push(m);
    return out;
  }

  function indexOf(dets) {
    var idx = new Int32Array(1024).fill(-1);
    dets.forEach(function (m, i) { idx[m] = i; });
    return idx;
  }

  // two-electron matrices (per F^2 and F^4) by second quantization: 1/2 sum <pq|rs> a+p a+q a_s a_r
  function twoBody(dets, idx) {
    var N = dets.length, M2 = new Float64Array(N * N), M4 = new Float64Array(N * N);
    for (var j = 0; j < N; j++) {
      var mask = dets[j];
      for (var r = 0; r < 10; r++) {
        if (!(mask & (1 << r))) continue;
        var s1 = sgn(mask, r), m1 = mask ^ (1 << r);
        for (var s = 0; s < 10; s++) {
          if (s === r || !(m1 & (1 << s))) continue;
          var s2 = sgn(m1, s), m2 = m1 ^ (1 << s);
          for (var p = 0; p < 10; p++) {
            if ((p & 1) !== (r & 1)) continue;
            for (var q = 0; q < 10; q++) {
              if ((q & 1) !== (s & 1) || (m2 & (1 << q))) continue;
              var gi = (((p >> 1) * 5 + (q >> 1)) * 5 + (r >> 1)) * 5 + (s >> 1);
              var g2 = G2[gi], g4 = G4[gi];
              if (g2 === 0 && g4 === 0) continue;
              var s3 = sgn(m2, q), m3 = m2 | (1 << q);
              if (m3 & (1 << p)) continue;
              var s4 = sgn(m3, p), i = idx[m3 | (1 << p)];
              if (i < 0) continue;
              var f = 0.5 * s1 * s2 * s3 * s4;
              M2[i * N + j] += f * g2;
              M4[i * N + j] += f * g4;
            }
          }
        }
      }
    }
    return { M2: M2, M4: M4 };
  }

  // S^2 = S-S+ + Sz^2 + Sz within the fixed-M_S block
  function spinSquared(n, dets) {
    var N = dets.length, ms2 = msTwice(dets[0]), up = detsFor(n, ms2 + 2), iu = indexOf(up), U = up.length;
    var Sp = new Float64Array(U * N), S2 = new Float64Array(N * N), j, o, k;
    for (j = 0; j < N; j++) {
      var mask = dets[j];
      for (o = 0; o < 5; o++) {
        var b = 2 * o + 1, a = 2 * o;
        if (!(mask & (1 << b)) || (mask & (1 << a))) continue;
        var s1 = sgn(mask, b), m1 = mask ^ (1 << b), s2 = sgn(m1, a);
        Sp[iu[m1 | (1 << a)] * N + j] += s1 * s2;
      }
    }
    var msz = ms2 / 2;
    for (var i = 0; i < N; i++) for (j = 0; j < N; j++) {
      var s = i === j ? msz * msz + msz : 0;
      for (k = 0; k < U; k++) s += Sp[k * N + i] * Sp[k * N + j];
      S2[i * N + j] = s;
    }
    return S2;
  }

  // C2'(x) on a determinant: returns [image mask, sign]
  function c2x(mask) {
    var list = [], ph = 1, p;
    for (p = 0; p < 10; p++) if (mask & (1 << p)) {
      var o = p >> 1;
      list.push(2 * C2X_IMG[o] + (p & 1));
      ph *= C2X_PH[o];
    }
    var inv = 0, img = 0;
    for (var a = 0; a < list.length; a++) {
      img |= 1 << list[a];
      for (var b = a + 1; b < list.length; b++) if (list[a] > list[b]) inv++;
    }
    return [img, inv & 1 ? -ph : ph];
  }

  function mod4(mask) {
    var s = 0;
    for (var p = 0; p < 10; p++) if (mask & (1 << p)) s += MOD4[p >> 1];
    return s % 4;
  }

  var IRREP = { '0,1': 'A1g', '0,-1': 'A2g', '2,1': 'B1g', '2,-1': 'B2g', '1,0': 'Eg', '3,0': 'Eg' };

  // ---------------------------------------------------------------- rotations (Oh parent labels)
  // Each orbital as a traceless quadratic form f(r) = r^T Q r (complex); (R f)(r) = f(R^T r) gives Q -> R Q R^T,
  // and on traceless forms the sphere inner product is proportional to tr(Q_a^* Q_b).
  var QF = (function () {
    function z() { return [[[0, 0], [0, 0], [0, 0]], [[0, 0], [0, 0], [0, 0]], [[0, 0], [0, 0], [0, 0]]]; }
    function sym(Q, a, b, re, im) { Q[a][b] = [re, im]; Q[b][a] = [re, im]; return Q; }
    var egp = sym(sym(z(), 0, 2, -0.5, 0), 1, 2, 0, -0.5);     // -(xz + i yz)
    var egm = sym(sym(z(), 0, 2, 0.5, 0), 1, 2, 0, -0.5);      //  (xz - i yz)
    var b2 = sym(z(), 0, 1, 0, 0.5);                           //  i xy
    var a1 = z(); a1[0][0] = [-1, 0]; a1[1][1] = [-1, 0]; a1[2][2] = [2, 0];
    var b1 = z(); b1[0][0] = [1, 0]; b1[1][1] = [-1, 0];
    return [egp, egm, b2, a1, b1].map(function (Q) {
      var s = 0, a, b;
      for (a = 0; a < 3; a++) for (b = 0; b < 3; b++) s += Q[a][b][0] * Q[a][b][0] + Q[a][b][1] * Q[a][b][1];
      s = Math.sqrt(s);
      for (a = 0; a < 3; a++) for (b = 0; b < 3; b++) Q[a][b] = [Q[a][b][0] / s, Q[a][b][1] / s];
      return Q;
    });
  })();

  // D[i][j] = <orb_i|R|orb_j> as [re, im] for a proper rotation R (3 x 3, active)
  function orbitalRotation(R) {
    var D = [], i, j, a, b, c, d;
    for (j = 0; j < 5; j++) {
      var Q = QF[j], P = [];
      for (a = 0; a < 3; a++) {
        P.push([]);
        for (b = 0; b < 3; b++) {
          var re = 0, im = 0;
          for (c = 0; c < 3; c++) for (d = 0; d < 3; d++) {
            var w = R[a][c] * R[b][d];
            re += w * Q[c][d][0]; im += w * Q[c][d][1];
          }
          P[a].push([re, im]);
        }
      }
      for (i = 0; i < 5; i++) {
        var sr = 0, si = 0, Qi = QF[i];
        for (a = 0; a < 3; a++) for (b = 0; b < 3; b++) {
          var x = Qi[a][b], y = P[a][b];                       // conj(x) * y
          sr += x[0] * y[0] + x[1] * y[1]; si += x[0] * y[1] - x[1] * y[0];
        }
        (D[i] = D[i] || [])[j] = [sr, si];
      }
    }
    return D;
  }

  function cdet(Mr, Mi, n) {                                    // complex determinant, partial pivoting
    var re = 1, im = 0, i, j, k;
    for (k = 0; k < n; k++) {
      var piv = k, best = -1;
      for (i = k; i < n; i++) { var m = Mr[i * n + k] * Mr[i * n + k] + Mi[i * n + k] * Mi[i * n + k]; if (m > best) { best = m; piv = i; } }
      if (best < 1e-28) return [0, 0];
      if (piv !== k) {
        for (j = 0; j < n; j++) {
          var t = Mr[k * n + j]; Mr[k * n + j] = Mr[piv * n + j]; Mr[piv * n + j] = t;
          t = Mi[k * n + j]; Mi[k * n + j] = Mi[piv * n + j]; Mi[piv * n + j] = t;
        }
        re = -re; im = -im;
      }
      var pr = Mr[k * n + k], pi = Mi[k * n + k], nr = re * pr - im * pi;
      im = re * pi + im * pr; re = nr;
      var den = pr * pr + pi * pi;
      for (i = k + 1; i < n; i++) {
        var fr = (Mr[i * n + k] * pr + Mi[i * n + k] * pi) / den, fi = (Mi[i * n + k] * pr - Mr[i * n + k] * pi) / den;
        if (fr === 0 && fi === 0) continue;
        for (j = k; j < n; j++) {
          var ar = Mr[k * n + j], ai = Mi[k * n + j];
          Mr[i * n + j] -= fr * ar - fi * ai; Mi[i * n + j] -= fr * ai + fi * ar;
        }
      }
    }
    return [re, im];
  }

  // Oh class sum over the six C4 rotations in the determinant basis: eigenvalue 6 chi(C4) / dim on each Oh
  // irrep, i.e. A1g 6, A2g -6, Eg 0, T1g 2, T2g -2. It is real here (complex conjugation in this basis is
  // C2(y) times the real-orbital conjugation, and a class sum is invariant under C2(y)).
  var C4AXES = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]]];
  function c4ClassSum(n, dets) {
    var N = dets.length, K = new Float64Array(N * N), Ki = new Float64Array(N * N), occ = dets.map(function (m) {
      var l = [];
      for (var p = 0; p < 10; p++) if (m & (1 << p)) l.push(p);
      return l;
    });
    var Mr = new Float64Array(n * n), Mi = new Float64Array(n * n);
    C4AXES.forEach(function (R) {
      var D = orbitalRotation(R);
      for (var I = 0; I < N; I++) for (var J = 0; J < N; J++) {
        var oi = occ[I], oj = occ[J];
        for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
          var same = (oi[a] & 1) === (oj[b] & 1), e = D[oi[a] >> 1][oj[b] >> 1];
          Mr[a * n + b] = same ? e[0] : 0; Mi[a * n + b] = same ? e[1] : 0;
        }
        var d = cdet(Mr, Mi, n);                                // <I|R|J>; R + R^-1 adds the conjugate transpose
        K[I * N + J] += d[0]; K[J * N + I] += d[0];
        Ki[I * N + J] += d[1]; Ki[J * N + I] -= d[1];
      }
    });
    var im = 0;
    for (var i = 0; i < N * N; i++) im = Math.max(im, Math.abs(Ki[i]));
    if (im > 1e-10) throw new Error('C4 class sum is not real: ' + im);
    return K;
  }

  var OH_OF = { A1g: { '6': 'A1g', '0': 'Eg' }, B1g: { '-6': 'A2g', '0': 'Eg' }, A2g: { '2': 'T1g' }, B2g: { '-2': 'T2g' },
                Eg: { '2': 'T1g', '-2': 'T2g' } };

  // ---------------------------------------------------------------- the d^n shell
  function Shell(n) {
    if (!(n >= 1 && n <= 9)) throw new Error('n must be 1-9');
    var dets = detsFor(n, n % 2), N = dets.length, idx = indexOf(dets);
    var two = twoBody(dets, idx), S2 = spinSquared(n, dets);
    var diag = {}, i, j;
    ['Dq', 'Ds', 'Dt'].forEach(function (key) {
      var M = new Float64Array(N * N);
      for (j = 0; j < N; j++) {
        var e = 0;
        for (var p = 0; p < 10; p++) if (dets[j] & (1 << p)) e += UNIT[key][p >> 1];
        M[j * N + j] = e;
      }
      diag[key] = M;
    });
    var cfg = dets.map(function (m) {
      var c = [0, 0, 0, 0];
      for (var p = 0; p < 10; p++) if (m & (1 << p)) c[CFG_ORDER.indexOf(ORB[p >> 1])]++;
      return c;
    });
    var cfgList = [], cfgKey = {}, cfgIndex = cfg.map(function (c) {   // strong-field configurations
      var key = c.join(',');
      if (!(key in cfgKey)) { cfgKey[key] = cfgList.length; cfgList.push(c); }
      return cfgKey[key];
    });
    var K = c4ClassSum(n, dets);

    var blocks = [];
    for (var b = 0; b < 4; b++) {
      var members = [];
      for (j = 0; j < N; j++) if (mod4(dets[j]) === b) members.push(j);
      if (!members.length) continue;
      var parts = {};                                   // C2' eigenvalue -> list of basis vectors (sparse)
      if (b === 0 || b === 2) {
        var seen = {};
        members.forEach(function (jj) {
          if (seen[jj]) return;
          var im = c2x(dets[jj]), ii = idx[im[0]], sg = im[1];
          if (ii < 0 || mod4(dets[ii]) !== b) throw new Error('C2\' left the block');
          seen[jj] = seen[ii] = true;
          if (ii === jj) (parts[sg] = parts[sg] || []).push([[jj, 1]]);
          else {
            (parts[1] = parts[1] || []).push([[jj, R2], [ii, sg * R2]]);
            (parts[-1] = parts[-1] || []).push([[jj, R2], [ii, -sg * R2]]);
          }
        });
      } else {
        parts[0] = members.map(function (jj) { return [[jj, 1]]; });
      }
      Object.keys(parts).forEach(function (c2) {
        // S^2 and C2' both keep the orbital occupations, so diagonalize S^2 one configuration at a time: every
        // basis column then has a single strong-field configuration (blk.colCfg).
        var byCfg = {}, groups = {};
        parts[c2].forEach(function (v) { var ci = cfgIndex[v[0][0]]; (byCfg[ci] = byCfg[ci] || []).push(v); });
        Object.keys(byCfg).forEach(function (ci) {
          var vecs = byCfg[ci], m = vecs.length, U = new Float64Array(N * m);
          vecs.forEach(function (v, col) { v.forEach(function (e) { U[e[0] * m + col] = e[1]; }); });
          var sEig = jacobiEig(project(S2, U, N, m), m);
          for (var c = 0; c < m; c++) {
            var S = Math.round(2 * (-1 + Math.sqrt(1 + 4 * Math.max(sEig.values[c], 0))) / 2) / 2;
            if (Math.abs(S * (S + 1) - sEig.values[c]) > 1e-6) throw new Error('S^2 eigenvalue ' + sEig.values[c]);
            var col = new Float64Array(N);
            for (var r = 0; r < N; r++) {
              var s = 0;
              for (var l = 0; l < m; l++) s += U[r * m + l] * sEig.vectors[l * m + c];
              col[r] = s;
            }
            (groups[S] = groups[S] || []).push([+ci, col]);
          }
        });
        Object.keys(groups).forEach(function (S) {
          var cols = groups[S], k = cols.length, W = new Float64Array(N * k), colCfg = new Int16Array(k);
          cols.forEach(function (cc, j) { colCfg[j] = cc[0]; for (var r = 0; r < N; r++) W[r * k + j] = cc[1][r]; });
          blocks.push({
            mod4: b, c2: +c2, irrep: IRREP[b + ',' + c2], mult: Math.round(2 * S + 1), size: k, W: W, colCfg: colCfg,
            A2: project(two.M2, W, N, k), A4: project(two.M4, W, N, k),
            Dq: project(diag.Dq, W, N, k), Ds: project(diag.Ds, W, N, k), Dt: project(diag.Dt, W, N, k),
            K: project(K, W, N, k)
          });
        });
      });
    }
    this.n = n; this.dets = dets; this.N = N; this.cfg = cfg; this.cfgList = cfgList; this.blocks = blocks;
  }

  // Oh eigenstates at (CB, Dq, Ds = Dt = 0), block by block (mod4 = 3 skipped, as in levels). The C4 class sum
  // commutes with H there, so H + eps K has the same eigenvectors with every Oh degeneracy lifted; its
  // expectation value names the Oh irrep. Each Oh level of irrep G has exactly one component in every D4h
  // block G subduces, so the rank among same-label states inside a block is the global Oh rank.
  // Returns one entry per block: { Y: k x k (column j = state j), names: ['4T1g#1', ...], E: energies }.
  Shell.prototype.ohStates = function (CB, Dq) {
    var self = this;
    return this.blocks.map(function (blk) {
      if (blk.mod4 === 3) return null;
      var k = blk.size, H = self.blockMatrix(blk, { CB: CB, Dq: Dq, Ds: 0, Dt: 0 }), i, j;
      for (i = 0; i < k * k; i++) H[i] += 1e-3 * blk.K[i];
      var eig = jacobiEig(H, k), names = [], count = {}, E = new Float64Array(k);
      for (j = 0; j < k; j++) {
        var kv = 0;
        for (i = 0; i < k; i++) {
          var s = 0;
          for (var l = 0; l < k; l++) s += blk.K[i * k + l] * eig.vectors[l * k + j];
          kv += eig.vectors[i * k + j] * s;
        }
        var kr = Math.round(kv), oh = OH_OF[blk.irrep][String(kr)];
        if (Math.abs(kv - kr) > 1e-6 || !oh) throw new Error('Oh class-sum value ' + kv + ' in ' + blk.mult + blk.irrep);
        count[oh] = (count[oh] || 0) + 1;
        names.push(blk.mult + oh + '#' + count[oh]);
        E[j] = eig.values[j] - 1e-3 * kr;                           // exact: y is a joint eigenvector of H and K
      }
      return { Y: eig.vectors, names: names, E: E };
    });
  };

  Shell.prototype.blockMatrix = function (blk, p) {
    var k = blk.size, H = new Float64Array(k * k), f2 = 49 + 7 * p.CB, f4 = 12.6 * p.CB;
    for (var i = 0; i < k * k; i++) {
      H[i] = f2 * blk.A2[i] + f4 * blk.A4[i] + p.Dq * blk.Dq[i] + p.Ds * blk.Ds[i] + p.Dt * blk.Dt[i];
    }
    return H;
  };

  // levels: one entry per (S, irrep) eigenvalue (the Eg row from M_L = 1 mod 4 only), sorted by energy.
  // opts.vectors: attach the eigenvector in the determinant basis (Float64Array of length N).
  Shell.prototype.levels = function (p, opts) {
    var out = [], self = this, withVec = opts && opts.vectors;
    this.blocks.forEach(function (blk) {
      if (blk.mod4 === 3) return;
      var eig = jacobiEig(self.blockMatrix(blk, p), blk.size);
      for (var c = 0; c < blk.size; c++) {
        var L = { E: eig.values[c], mult: blk.mult, irrep: blk.irrep, rank: c + 1, dim: blk.irrep === 'Eg' ? 2 : 1 };
        if (withVec) {
          var v = new Float64Array(self.N);
          for (var r = 0; r < self.N; r++) {
            var s = 0;
            for (var l = 0; l < blk.size; l++) s += blk.W[r * blk.size + l] * eig.vectors[l * blk.size + c];
            v[r] = s;
          }
          L.vector = v;
        }
        out.push(L);
      }
    });
    out.sort(function (a, b) { return a.E - b.E; });
    return out;
  };

  // every eigenvalue of the M_S block (both Eg rows), sorted
  Shell.prototype.spectrum = function (p) {
    var out = [], self = this;
    this.blocks.forEach(function (blk) {
      var e = jacobiEig(self.blockMatrix(blk, p), blk.size).values;
      for (var c = 0; c < e.length; c++) out.push(e[c]);
    });
    return out.sort(function (a, b) { return a - b; });
  };

  function orbitalEnergies(Dq, Ds, Dt) {
    return { b1g: 6 * Dq + 2 * Ds - Dt, a1g: 6 * Dq - 2 * Ds - 6 * Dt, b2g: -4 * Dq + 2 * Ds - Dt, eg: -4 * Dq - Ds + 4 * Dt };
  }

  // trans-MA4L2 (L on z); delta = equatorial - axial
  function aomToCF(esEq, epEq, esAx, epAx) {
    var ds = esEq - esAx, dp = epEq - epAx;
    return { Dq: (3 * esEq - 4 * epEq) / 10, Ds: 2 / 7 * (ds + dp), Dt: 2 / 35 * (3 * ds - 4 * dp) };
  }

  root.TSD4h = {
    Shell: Shell, orbitalEnergies: orbitalEnergies, aomToCF: aomToCF, ck: ck, wigner3j: wigner3j,
    jacobiEig: jacobiEig, CFG_ORDER: CFG_ORDER, orbitalRotation: orbitalRotation
  };
})(typeof self !== 'undefined' ? self : this);
