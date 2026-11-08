/* Hahn echo on the Bloch sphere (rotating frame). Spins with slightly different frequencies are tipped into
   the plane by a pi/2 pulse, fan out for a time tau, are flipped by a pi pulse and refocus after another tau.
   The arrows are computed from the rotations themselves; the blue trace is the net in-plane magnetization. */
(() => {
  "use strict";
  const canvas = document.getElementById("hahn-echo");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const MAROON = [166, 46, 64], BLUE = [43, 92, 138], INK = "#333", RULE = "#b9b9b9";
  const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // timing in seconds; the pi pulse lasts twice the pi/2 pulse, so the nutation rate is the same
  const HOLD = 0.6, P90 = 0.7, TAU = 2.5, P180 = 1.4, AFTER = 2.5, REST = 0.7;
  const t1 = HOLD, t2 = t1 + P90, t3 = t2 + TAU, t4 = t3 + P180, t5 = t4 + TAU, t6 = t5 + AFTER, LOOP = t6 + REST;

  // equally spaced offsets, spread so the fan covers the whole circle exactly at tau
  const N = 13, SPREAD = Math.PI * (N - 1) / N;
  const offsets = Array.from({ length: N }, (_, i) => (2 * i) / (N - 1) - 1);
  const clamp = x => Math.min(1, Math.max(0, x));
  const rx = (v, a) => [v[0], v[1] * Math.cos(a) - v[2] * Math.sin(a), v[1] * Math.sin(a) + v[2] * Math.cos(a)];
  const rz = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a), v[2]];

  function spin(off, t) {
    let v = rx([0, 0, 1], (Math.PI / 2) * clamp((t - t1) / P90));
    if (t > t2) v = rz(v, SPREAD * off * clamp((t - t2) / TAU));
    if (t > t3) v = rx(v, Math.PI * clamp((t - t3) / P180));
    if (t > t4) v = rz(v, (SPREAD * off * (t - t4)) / TAU);
    return v;
  }
  function net(t) {
    const m = [0, 0, 0];
    for (const o of offsets) { const v = spin(o, t); for (let k = 0; k < 3; k++) m[k] += v[k] / N; }
    return m;
  }
  const signal = t => { const m = net(t); return Math.hypot(m[0], m[1]); };
  function status(t) {
    if (t < t1) return "Equilibrium";
    if (t < t2) return "π/2 pulse";
    if (t < t3) return "Spins dephase";
    if (t < t4) return "π pulse";
    if (t < t5 - 0.25) return "Spins refocus";
    if (t < t5 + 0.25) return "Echo";
    return "Spins dephase again";
  }

  // orthographic view: x' towards the viewer, y' to the right, z up
  const AZ = (22 * Math.PI) / 180, EL = (20 * Math.PI) / 180;
  function project(v) {
    const d = v[0] * Math.cos(AZ) + v[1] * Math.sin(AZ);
    return {
      x: v[1] * Math.cos(AZ) - v[0] * Math.sin(AZ),
      y: v[2] * Math.cos(EL) - d * Math.sin(EL),
      depth: d * Math.cos(EL) + v[2] * Math.sin(EL)
    };
  }

  let W = 0, H = 0, S = 1;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth; H = canvas.clientHeight; S = W / 382;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const font = (px, style = "") => { ctx.font = `${style} ${px * S}px Lato, Arial, sans-serif`; };

  function arrow(cx, cy, R, v, color, width, head) {
    const p = project(v), x = cx + R * p.x, y = cy - R * p.y;
    const len = Math.hypot(x - cx, y - cy);
    if (len < 1) return;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = "round";
    const ux = (x - cx) / len, uy = (y - cy) / len, h = Math.min(head, len * 0.6);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x - ux * h * 0.8, y - uy * h * 0.8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x - ux * h - uy * h * 0.42, y - uy * h + ux * h * 0.42);
    ctx.lineTo(x - ux * h + uy * h * 0.42, y - uy * h - ux * h * 0.42);
    ctx.closePath(); ctx.fill();
  }
  function circle3d(cx, cy, R, f, front, color, width, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i <= 180; i++) {
      const p = project(f((i / 180) * 2 * Math.PI));
      if ((p.depth >= 0) !== front) { pen = false; continue; }
      const x = cx + R * p.x, y = cy - R * p.y;
      if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke(); ctx.setLineDash([]);
  }

  function drawSphere(t) {
    const cx = W / 2, cy = H * 0.41, R = H * 0.29;
    const g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(214,221,230,0.75)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = RULE; ctx.lineWidth = 1 * S; ctx.stroke();

    const eq = a => [Math.cos(a), Math.sin(a), 0];
    circle3d(cx, cy, R, eq, false, RULE, 0.9 * S, [3 * S, 3 * S]);
    for (const [v, label] of [[[1.3, 0, 0], "x′"], [[0, 1.3, 0], "y′"], [[0, 0, 1.28], "z"]]) {
      const a = project(v), b = project(v.map(c => -c * 0.77));
      ctx.strokeStyle = RULE; ctx.lineWidth = 0.8 * S; ctx.beginPath();
      ctx.moveTo(cx + R * b.x, cy - R * b.y); ctx.lineTo(cx + R * a.x, cy - R * a.y); ctx.stroke();
      font(12, "italic"); ctx.fillStyle = "#6a6a6a"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const k = 1.1; ctx.fillText(label, cx + R * a.x * k, cy - R * a.y * k);
    }

    // fade the spins in and out at the ends of the loop, so the restart does not jump
    const alpha = t > t6 ? 1 - clamp((t - t6) / REST) : clamp(t / 0.35);
    const spins = offsets.map(o => ({ o, v: spin(o, t) })).sort((a, b) => project(a.v).depth - project(b.v).depth);
    for (const { o, v } of spins) {
      const f = (o + 1) / 2, c = MAROON.map((m, k) => Math.round(m + (BLUE[k] - m) * f));
      arrow(cx, cy, R, v, rgb(c, 0.92 * alpha), 1.5 * S, 7 * S);
    }
    arrow(cx, cy, R, net(t), `rgba(40,40,40,${alpha})`, 2.8 * S, 10 * S);
    circle3d(cx, cy, R, eq, true, "#8f8f8f", 1 * S);

    font(13); ctx.fillStyle = INK; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(status(t), 2 * S, 2 * S);
  }

  function drawSequence(t) {
    const x0 = 4 * S, x1 = W - 4 * S, base = H * 0.965, h = H * 0.15;
    const X = s => x0 + ((x1 - x0) * s) / t6;
    // net signal, faint for the whole sequence and solid up to the current time
    const area = (a, b, style) => {
      ctx.fillStyle = style; ctx.beginPath(); ctx.moveTo(X(a), base);
      for (let i = 0; i <= 60; i++) { const s = a + ((b - a) * i) / 60; ctx.lineTo(X(s), base - h * 0.8 * signal(s)); }
      ctx.lineTo(X(b), base); ctx.closePath(); ctx.fill();
    };
    for (const [a, b] of [[t2, t3], [t4, t6]]) {
      area(a, b, rgb(BLUE, 0.2));
      if (t > a) area(a, Math.min(t, b), rgb(BLUE, 0.95));
    }
    ctx.fillStyle = rgb(MAROON);
    ctx.fillRect(X(t1), base - h, X(t2) - X(t1), h);
    ctx.fillRect(X(t3), base - h, X(t4) - X(t3), h);
    ctx.strokeStyle = INK; ctx.lineWidth = 1 * S; ctx.beginPath(); ctx.moveTo(x0, base); ctx.lineTo(x1, base); ctx.stroke();

    font(12); ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillStyle = rgb(MAROON);
    ctx.fillText("π/2", X((t1 + t2) / 2), base - h - 2 * S);
    ctx.fillText("π", X((t3 + t4) / 2), base - h - 2 * S);
    ctx.fillStyle = rgb(BLUE);
    ctx.fillText("echo", X(t5), base - h - 2 * S);

    const now = Math.min(t, t6);
    ctx.strokeStyle = INK; ctx.lineWidth = 1.2 * S; ctx.beginPath(); ctx.moveTo(X(now), base + 2 * S); ctx.lineTo(X(now), base - h - 1 * S); ctx.stroke();
  }

  function draw(t) { ctx.clearRect(0, 0, W, H); drawSphere(t); drawSequence(t); }

  resize();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {   // a still frame at the echo
    draw(t5);
    new ResizeObserver(() => { resize(); draw(t5); }).observe(canvas);
    return;
  }
  new ResizeObserver(resize).observe(canvas);
  let visible = true, running = false;
  const t0 = performance.now();
  function frame(now) {
    if (!visible) { running = false; return; }
    draw(((now - t0) / 1000) % LOOP);
    requestAnimationFrame(frame);
  }
  const start = () => { if (!running) { running = true; requestAnimationFrame(frame); } };
  new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) start(); }).observe(canvas);
  start();
})();
