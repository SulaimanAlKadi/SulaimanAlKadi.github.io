/* Starling — browser front end.
 *
 * Holds no analysis of its own. Every number on the page came back from the
 * Python package over the JSON API in server.py, which is the same code the
 * command line runs. This file collects options, shows what came back, and
 * stays out of the way.
 */
"use strict";

const S = { sets: [], active: null, mapKind: "raw", tab: "map", busy: false,
            shared: null, fit: null };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sig = (v, n = 4) =>
  (v === null || v === undefined || !isFinite(v)) ? "&mdash;" : (+v).toPrecision(n);

function status(msg, kind) {
  const el = $("#status");
  el.textContent = msg;
  el.style.color = kind === "bad" ? "var(--bad)"
    : kind === "ok" ? "var(--ok)" : "var(--ink-3)";
}
const prog = f => { $("#bar-inner").style.width = `${Math.round(f * 100)}%`; };

let OFFLINE = false;
function goOffline() {
  if (OFFLINE) return;
  OFFLINE = true;
  // This page is a front end for a Python process. Served from a static host
  // there is nothing behind it, and saying so beats failing silently.
  const b = document.createElement("div");
  b.className = "note bad";
  b.style.cssText = "margin:1rem 0;font-size:.95rem";
  b.innerHTML = `<b>No analysis engine is running.</b> This page drives a local
    Python process, which does the work; on its own it cannot read your files.
    Install the package and start it:
    <code style="font-family:var(--mono)">pip install starling</code> then
    <code style="font-family:var(--mono)">starling gui</code>.`;
  const host = document.querySelector("main");
  if (host) host.insertBefore(b, host.firstChild);
}

async function api(route, body) {
  if (window.starlingBridge) {                  // in-browser Python engine
    const j = await window.starlingBridge.call(route, body || {});
    if (j && j.error) throw new Error(j.error);
    return j;
  }
  let r;
  try {
    r = await fetch(route, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}) });
  } catch (e) {
    goOffline();
    throw new Error("the analysis engine is not reachable");
  }
  if (r.status === 404 || r.status === 405) { goOffline();
    throw new Error("the analysis engine is not reachable"); }
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/* ------------------------------------------------------------- options */
function opts() {
  const v = id => $("#o-" + id);
  const num = id => +v(id).value;
  const list = id => String(v(id).value || "").split(",")
    .map(s => parseFloat(s)).filter(n => isFinite(n) && n > 0);
  return {
    descatter: v("descatter").checked,
    pump_manual: v("pump_manual").checked,
    pump_nm: num("pump_nm"), pump_fwhm: num("pump_fwhm"),
    chirp_model: ($("input[name=chirp]:checked") || {}).value || "material",
    poly_order: num("poly_order"),
    refine: v("refine").checked,
    remove_artifact: v("remove_artifact").checked,
    window_sigma: num("window_sigma"),
    smooth_artifact: v("smooth_artifact").checked,
    trim: v("trim").checked,
    kinetics: v("kinetics").checked,
    auto_kinetics: v("auto_kinetics").checked,
    orders: list("orders"), taus: list("taus"),
    infinite: v("infinite").checked,
    sequential: v("sequential").checked,
    shared_chirp: v("shared_chirp").checked,
    shared_kinetics: v("shared_kinetics").checked,
    uncertainty: v("uncertainty").checked,
    svd: v("svd").checked,
    coherence: v("coherence").checked,
    posterior: v("posterior").checked,
    coh_lo: num("coh_lo"), coh_hi: num("coh_hi"),
    coh_modes: num("coh_modes"), coh_max: num("coh_max"),
    coh_solvent: v("coh_solvent").value,
    post_steps: num("post_steps"),
    scheme: ($("input[name=scheme]:checked") || {}).value || "parallel",
  };
}

/* --------------------------------------------------------------- files */
const OK_EXT = /\.(csv|txt|dat|tsv|asc|npz|ufs)$/i;

function readFile(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(new Error(`could not read ${file.name}`));
    fr.onload = () => {
      const b = new Uint8Array(fr.result);
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000)
        s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      res({ name: file.name, b64: btoa(s) });
    };
    fr.readAsArrayBuffer(file);
  });
}

async function addFiles(files) {
  const keep = [...files].filter(f => OK_EXT.test(f.name));
  const skipped = files.length - keep.length;
  if (!keep.length) {
    status(`Nothing loadable there${skipped ? `; ${skipped} file(s) of other types were ignored` : ""}.`, "bad");
    return;
  }
  status(`Reading ${keep.length} file(s)…`);
  const payloads = [];
  for (let i = 0; i < keep.length; i++) {
    payloads.push(await readFile(keep[i]));
    prog((i + 1) / keep.length * 0.5);
  }
  try {
    const { datasets } = await api("/api/load", { files: payloads });
    let good = 0, bad = [];
    datasets.forEach(d => {
      if (!d.ok) { bad.push(`${d.name}: ${d.error}`); return; }
      good++;
      S.sets.push({ ...d, sel: true, state: d.warnings.length ? "warn" : "ok",
                    result: null });
    });
    if (good && !S.active) S.active = S.sets[0].id;
    renderSets();
    status(bad.length ? `${good} loaded. ${bad[0]}` : `${good} dataset(s) loaded.`,
           bad.length ? "warn" : "ok");
  } catch (e) { status(e.message, "bad"); }
  prog(0);
}

async function walkEntry(entry, out, depth = 0) {
  if (depth > 6) return;
  if (entry.isFile) {
    await new Promise(r => entry.file(f => { out.push(f); r(); }, r));
  } else if (entry.isDirectory) {
    const rd = entry.createReader();
    for (;;) {
      const batch = await new Promise(r => rd.readEntries(r, () => r([])));
      if (!batch.length) break;
      for (const e of batch) await walkEntry(e, out, depth + 1);
    }
  }
}

function picker(dir) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.multiple = true;
  if (dir) { inp.webkitdirectory = true; inp.directory = true; }
  inp.onchange = () => addFiles(inp.files);
  inp.click();
}

/* ------------------------------------------------------- dataset table */
function renderSets() {
  const has = S.sets.length > 0;
  $("#dswrap").hidden = !has;
  $("#step2").hidden = !has;
  renderFitSets();
  $("#b-clear").hidden = !has;
  if (!has) { $("#step3").hidden = true; return; }

  const rows = S.sets.map(d => {
    const warn = (d.warnings || []).join(" ");
    return `<tr data-id="${d.id}" class="${d.id === S.active ? "on" : ""}">
      <td><input type="checkbox" data-sel="${d.id}" ${d.sel ? "checked" : ""}></td>
      <td><span class="dot ${d.state}" title="${esc(warn || d.state)}"></span>
          <a href="#" data-pick="${d.id}">${esc(d.name)}</a>
          ${warn ? `<div class="muted" style="font-size:.78rem">${esc(warn)}</div>` : ""}</td>
      <td class="n">${d.n_delay} &times; ${d.n_wavelength}</td>
      <td class="n">${(+d.delay_min).toPrecision(2)} … ${(+d.delay_max).toPrecision(3)}</td>
      <td class="n">${Math.round(d.wl_min)} – ${Math.round(d.wl_max)}</td>
      <td class="n">${d.pump_nm ? (+d.pump_nm).toFixed(0) : "&mdash;"}</td>
      <td class="n">${d.result ? "done" : "&mdash;"}</td></tr>`;
  }).join("");

  $("#dstable").innerHTML = `<thead><tr>
      <th style="width:1.6rem"><input type="checkbox" id="selall" checked></th>
      <th>Dataset</th><th class="n">delays &times; &lambda;</th>
      <th class="n">delay / ps</th><th class="n">probe / nm</th>
      <th class="n">pump</th><th class="n">state</th></tr></thead><tbody>${rows}</tbody>`;

  $$("[data-sel]").forEach(cb => { cb.onchange = () => {
    const d = S.sets.find(x => x.id === cb.dataset.sel); d.sel = cb.checked; hint(); }; });
  $$("[data-pick]").forEach(a => { a.onclick = ev => {
    ev.preventDefault(); S.active = a.dataset.pick; renderSets(); renderAll(); }; });
  const sa = $("#selall");
  if (sa) sa.onchange = () => { S.sets.forEach(d => { d.sel = sa.checked; });
                                renderSets(); };
  hint();
}
function hint() {
  const n = S.sets.filter(d => d.sel).length;
  $("#runhint").textContent = n
    ? `${n} dataset${n > 1 ? "s" : ""} selected`
    : "nothing selected";
  $("#b-run").disabled = S.busy || !n;
}

/* ---------------------------------------------------------------- tabs */
const TABS = [["map", "Map"], ["kin", "Lifetimes"], ["comp", "Components"],
              ["coh", "Coherence"], ["post", "Posterior"],
              ["series", "Series"], ["fluence", "Fluence"], ["report", "Report"]];
function renderTabs() {
  $("#tabs").innerHTML = TABS.map(([k, t]) =>
    `<button data-tab="${k}" class="${k === S.tab ? "on" : ""}"${
      (k === "series" && !S.shared) ? " disabled" : ""}>${t}</button>`).join("");
  $$("#tabs button").forEach(b => { b.onclick = () => {
    S.tab = b.dataset.tab; renderTabs(); showTab(); }; });
}
function showTab() {
  TABS.forEach(([k]) => { $(`#pane-${k}`).hidden = k !== S.tab; });
  if (S.tab === "map") drawMap();
  if (S.tab === "kin") redrawSpectra();
  if (S.tab === "coh") renderCoh();
  if (S.tab === "post") renderPost();
  if (S.tab === "fluence") renderFluence();
}

/* -------------------------------------------------------------- colour */
const STOPS = [[29,63,79],[74,139,163],[201,219,225],[247,244,240],
               [232,185,191],[201,107,120],[166,46,64]];
function cmap(v) {
  const x = Math.max(0, Math.min(1, (v + 1) / 2)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x)), f = x - i;
  const a = STOPS[i], b = STOPS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f,
          a[2] + (b[2] - a[2]) * f];
}
function decode(m) {
  const bin = atob(m.b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const q = new Int16Array(u8.buffer), out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] === m.nan ? NaN : q[i] * m.scale;
  return out;
}
function robustMax(z) {
  const v = [];
  const stride = Math.max(1, (z.length / 20000) | 0);
  for (let i = 0; i < z.length; i += stride) if (isFinite(z[i])) v.push(Math.abs(z[i]));
  if (!v.length) return 1;
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length * 0.99)] || 1;
}
const css = v => getComputedStyle(document.documentElement)
  .getPropertyValue(v).trim();
function sizeCanvas(cv, cssHeight) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = cv.parentElement.clientWidth - 8;
  cv.style.height = cssHeight + "px";
  cv.width = Math.max(1, w * dpr | 0);
  cv.height = Math.max(1, cssHeight * dpr | 0);
  return dpr;
}

/* ----------------------------------------------------------------- map */
let MAP = null;

/* Linear within +-lin ps, logarithmic beyond. Returns a monotonic coordinate;
   only differences of it matter, so the scale is normalised afterwards. */
function symlog(t, lin) {
  const a = Math.abs(t);
  const v = a <= lin ? a / lin : 1 + Math.log10(a / lin);
  return t < 0 ? -v : v;
}
function symlogInv(u, lin) {
  const a = Math.abs(u);
  const v = a <= 1 ? a * lin : lin * Math.pow(10, a - 1);
  return u < 0 ? -v : v;
}
/* Ticks a spectroscopist would draw: 1, 2, 5 per decade outside the linear
   window, and the window edges inside it. */
function delayTicks(t0, t1, lin) {
  const out = [];
  if (t0 < 0) out.push(t0);
  out.push(0);
  for (let d = Math.floor(Math.log10(lin)); d <= Math.ceil(Math.log10(Math.abs(t1))); d++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, d);
      if (v > lin * 0.9 && v <= t1) out.push(v);
    }
  }
  if (out.length > 9) {
    const keep = out.filter(v => v <= 0 || /^[15]/.test(v.toExponential(0)));
    if (keep.length >= 4) return keep;
  }
  return out;
}
function niceLabel(v) {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000) return (v / 1000).toPrecision(2) + " ns";
  if (a >= 1) return String(+v.toPrecision(3));
  return String(+v.toPrecision(2));
}
const activeSet = () => S.sets.find(d => d.id === S.active) || null;

function renderMapPane() {
  const d = activeSet();
  const host = $("#pane-map");
  if (!d || !d.result) {
    host.innerHTML = `<p class="muted">Nothing corrected yet.</p>`;
    return;
  }
  host.innerHTML = `
    <div class="optrow" style="margin-top:0">
      <label><input type="radio" name="mk" value="raw" checked> Measured</label>
      <label><input type="radio" name="mk" value="corrected"> Corrected</label>
      <label><input type="radio" name="mk" value="artifact"> Artifact removed</label>
      <span style="flex:1"></span>
      <label><input type="checkbox" id="m-chirp" checked> time zero</label>
      <label><input type="checkbox" id="m-pix"> per-wavelength estimates</label>
      <label><input type="checkbox" id="m-log" checked> linear then log</label>
    </div>
    <div class="grid2">
      <div>
        <div class="plot"><canvas id="mapcv"></canvas>
          <canvas id="mapov" class="ov" style="position:absolute"></canvas></div>
        <p class="cap" id="mapcap">probe wavelength &rarr; &nbsp;|&nbsp; delay &darr;</p>
      </div>
      <div>
        <h3 class="sec">This dataset</h3>
        <dl class="kv" id="mapkv"></dl>
        <div id="mapnotes"></div>
      </div>
    </div>`;
  $$("input[name=mk]").forEach(r => { r.onchange = () => {
    S.mapKind = r.value; drawMap(); }; });
  $("#m-chirp").onchange = drawOverlay;
  $("#m-pix").onchange = drawOverlay;
  $("#m-log").onchange = drawMap;

  const ch = d.result.stages.chirp, dg = d.result.stages.diagnostics || {};
  $("#mapkv").innerHTML = `
    <dt>chirp across the probe</dt><dd>${ch.span_fs.toFixed(0)} fs</dd>
    <dt>instrument response</dt><dd>${ch.irf_fwhm_fs.toFixed(0)} fs</dd>
    <dt>scatter about the curve</dt><dd>${ch.scatter_fs.toFixed(0)} fs</dd>
    <dt>wavelengths used</dt><dd>${(ch.pixels_used * 100).toFixed(0)}%</dd>
    <dt>delay sampling</dt><dd>${sig(dg.samples_per_fwhm, 3)} / FWHM</dd>`;
  $("#mapnotes").innerHTML = (ch.notes || [])
    .concat(dg.artifact_notes || [])
    .map(n => `<div class="note">${esc(n)}</div>`).join("");
  drawMap();
}

function drawMap() {
  const d = activeSet();
  const cv = $("#mapcv");
  if (!cv || !d || !d.result) return;
  const m = d.result.maps[S.mapKind] || d.result.maps.raw;
  if (!m) return;
  const dpr = sizeCanvas(cv, 360);
  const ctx = cv.getContext("2d");
  const z = decode(m), vmax = robustMax(z);
  const L = 54 * dpr, R = 14 * dpr, T = 10 * dpr, B = 30 * dpr;
  const iw = Math.max(1, cv.width - L - R), ih = Math.max(1, cv.height - T - B);

  const t0 = m.delay[0], t1 = m.delay[m.delay.length - 1];
  const logAxis = $("#m-log") ? $("#m-log").checked : true;
  // linear window: wide enough to hold the rise, never wider than the data
  const lin = Math.min(Math.max(1, Math.abs(t0)), Math.abs(t1) || 1);
  const F = logAxis ? (t => symlog(t, lin)) : (t => t);
  const Finv = logAxis ? (u => symlogInv(u, lin)) : (u => u);
  const f0 = F(t0), f1 = F(t1);
  const Y = t => T + (F(t) - f0) / (f1 - f0) * ih;

  // resample rows onto the display axis, nearest source delay per output row
  const rows = Math.round(ih);
  const img = new ImageData(m.cols, rows);
  let src = 0;
  for (let r = 0; r < rows; r++) {
    const want = Finv(f0 + (r + 0.5) / rows * (f1 - f0));
    while (src < m.rows - 2 && Math.abs(m.delay[src + 1] - want)
                              < Math.abs(m.delay[src] - want)) src++;
    while (src > 0 && Math.abs(m.delay[src - 1] - want)
                     < Math.abs(m.delay[src] - want)) src--;
    for (let c = 0; c < m.cols; c++) {
      const v = z[src * m.cols + c], p = (r * m.cols + c) * 4;
      if (!isFinite(v)) { img.data[p] = img.data[p + 1] = img.data[p + 2] = 242;
                          img.data[p + 3] = 255; continue; }
      const col = cmap(v / vmax);
      img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2];
      img.data[p + 3] = 255;
    }
  }
  const buf = document.createElement("canvas");
  buf.width = m.cols; buf.height = rows;
  buf.getContext("2d").putImageData(img, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(buf, L, T, iw, ih);
  ctx.strokeStyle = "#d9d9d9"; ctx.lineWidth = dpr;
  ctx.strokeRect(L, T, iw, ih);

  // axes
  ctx.fillStyle = "#8a8a8a";
  ctx.font = `${10 * dpr}px "IBM Plex Mono",monospace`;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  delayTicks(t0, t1, lin).forEach(tv => {
    const y = Y(tv);
    if (y < T - 1 || y > T + ih + 1) return;
    ctx.strokeStyle = "rgba(0,0,0,.18)";
    ctx.beginPath(); ctx.moveTo(L - 4 * dpr, y); ctx.lineTo(L, y); ctx.stroke();
    ctx.fillText(niceLabel(tv), L - 7 * dpr, y);
  });
  ctx.save();
  ctx.translate(11 * dpr, T + ih / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center"; ctx.fillText("delay / ps", 0, 0);
  ctx.restore();
  const w0 = m.wavelength[0], w1 = m.wavelength[m.wavelength.length - 1];
  const X = w => L + (w - w0) / (w1 - w0) * iw;
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const step = Math.pow(10, Math.floor(Math.log10((w1 - w0) / 4)));
  const wstep = [1, 2, 5, 10].map(k => k * step).find(v => (w1 - w0) / v <= 7) || step;
  for (let w = Math.ceil(w0 / wstep) * wstep; w <= w1; w += wstep) {
    const x = X(w);
    ctx.strokeStyle = "rgba(0,0,0,.18)";
    ctx.beginPath(); ctx.moveTo(x, T + ih); ctx.lineTo(x, T + ih + 4 * dpr); ctx.stroke();
    ctx.fillText(String(Math.round(w)), x, T + ih + 7 * dpr);
  }
  ctx.fillText("probe wavelength / nm", L + iw / 2, T + ih + 19 * dpr);
  // put the overlay exactly on top of the map, in both CSS and device pixels
  const ov = $("#mapov");
  ov.width = cv.width; ov.height = cv.height;
  ov.style.width = cv.clientWidth + "px";
  ov.style.height = cv.clientHeight + "px";
  ov.style.left = cv.offsetLeft + "px";
  ov.style.top = cv.offsetTop + "px";
  MAP = { m, z, vmax, dpr, L, T, iw, ih, X, Y };
  $("#mapcap").innerHTML = `full scale &plusmn;${vmax.toExponential(1)} &Delta;A` +
    (logAxis ? ` &nbsp;|&nbsp; delay linear to ${niceLabel(lin)} ps, logarithmic after`
             : ` &nbsp;|&nbsp; delay linear throughout`);
  drawOverlay();
}

function drawOverlay() {
  const d = activeSet(), ov = $("#mapov"), cv = $("#mapcv");
  if (!ov || !MAP || !d || !d.result) return;
  const c = ov.getContext("2d");
  c.clearRect(0, 0, ov.width, ov.height);
  const ch = d.result.stages.chirp;
  if (!ch) return;
  const { dpr, X, Y, T, ih } = MAP;
  const inside = y => y >= T - 1 && y <= T + ih + 1;
  if ($("#m-pix") && $("#m-pix").checked) {
    c.fillStyle = "rgba(58,58,58,.55)";
    ch.wavelength.forEach((w, i) => {
      const v = ch.t0_pixel_ps[i];
      if (v === null || !ch.used[i]) return;
      const y = Y(v);
      if (inside(y)) c.fillRect(X(w) - dpr, y - dpr, 2 * dpr, 2 * dpr);
    });
  }
  if ($("#m-chirp") && $("#m-chirp").checked) {
    c.strokeStyle = css("--accent"); c.lineWidth = 2 * dpr;
    c.beginPath();
    let started = false;
    ch.wavelength.forEach((w, i) => {
      const x = X(w), y = Y(ch.t0_ps[i]);
      if (!inside(y)) { started = false; return; }
      started ? c.lineTo(x, y) : c.moveTo(x, y);
      started = true;
    });
    c.stroke();
  }
}

/* ----------------------------------------------------------- lifetimes */
function renderKin() {
  const d = activeSet(), host = $("#pane-kin");
  const k = d && d.result && d.result.stages.kinetics;
  if (!k) { host.innerHTML = `<p class="muted">No lifetime fit.</p>`; return; }
  if (k.error) {
    host.innerHTML = `<div class="note bad">The lifetime fit failed: ${esc(k.error)}</div>`;
    return;
  }
  const nrm = k.das.map(r => Math.sqrt(r.reduce((a, b) => a + b * b, 0)));
  const big = Math.max(...nrm) || 1;
  let rows = k.taus.map((t, i) =>
    `<tr><td>&tau;<sub>${i + 1}</sub></td><td class="n">${sig(t, 5)}</td>
     <td class="n">${sig(k.tau_se[i], 3)}</td>
     <td class="n">${(nrm[i] / big * 100).toFixed(0)}%</td></tr>`).join("");
  if (k.has_infinite)
    rows += `<tr><td>non-decaying</td><td class="n">&infin;</td><td class="n">&mdash;</td>
      <td class="n">${(nrm[nrm.length - 1] / big * 100).toFixed(0)}%</td></tr>`;
  host.innerHTML = `
    <div class="grid2">
      <div>
        <div class="plot"><canvas id="dascv"></canvas></div>
        <p class="cap">Decay-associated spectra: the amplitude of each lifetime at
          every probe wavelength.</p>
        ${k.eas ? `<div class="plot"><canvas id="eascv"></canvas></div>
          <p class="cap">Evolution-associated spectra for a sequential
          A&nbsp;&rarr;&nbsp;B&nbsp;&rarr;&nbsp;C scheme. Both descriptions fit the
          data identically; they differ only in what the spectra mean.</p>` : ""}
      </div>
      <div>
        <h3 class="sec">Lifetimes</h3>
        <table class="t"><thead><tr><th>Component</th><th class="n">ps</th>
          <th class="n">1&sigma;</th><th class="n">weight</th></tr></thead>
          <tbody>${rows}</tbody></table>
        <dl class="kv" style="margin-top:.9rem">
          <dt>R&sup2;</dt><dd>${sig(k.r_squared, 6)}</dd>
          <dt>residual rms</dt><dd>${(+k.residual_rms).toExponential(3)}</dd></dl>
        ${(k.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("")}
      </div>
    </div>`;
  redrawSpectra();
}
function redrawSpectra() {
  const d = activeSet();
  const k = d && d.result && d.result.stages.kinetics;
  if (!k || k.error) return;
  plotSpectra("dascv", k.wavelength, k.das, k.taus, k.has_infinite);
  if (k.eas) plotSpectra("eascv", k.wavelength, k.eas, k.taus, false);
}

function plotSpectra(id, lam, rows, taus, hasInf) {
  const cv = $("#" + id);
  if (!cv || !rows || !rows.length) return;
  const dpr = sizeCanvas(cv, 220);
  const c = cv.getContext("2d");
  c.clearRect(0, 0, cv.width, cv.height);
  const padL = 34 * dpr, padR = 10 * dpr, padT = 12 * dpr, padB = 22 * dpr;
  let mx = 0;
  rows.forEach(r => r.forEach(v => { if (isFinite(v)) mx = Math.max(mx, Math.abs(v)); }));
  mx = mx || 1;
  const X = i => padL + i / (lam.length - 1) * (cv.width - padL - padR);
  const Y = v => padT + (1 - (v / mx + 1) / 2) * (cv.height - padT - padB);
  c.strokeStyle = "#e9e9e9"; c.lineWidth = dpr;
  c.beginPath(); c.moveTo(padL, Y(0)); c.lineTo(cv.width - padR, Y(0)); c.stroke();
  const cols = [css("--accent"), "#2d6d88", "#6a8f3c", "#8a5d12", "#5f5f5f"];
  rows.forEach((row, k) => {
    c.strokeStyle = cols[k % cols.length]; c.lineWidth = 1.9 * dpr;
    c.beginPath();
    row.forEach((v, i) => { const x = X(i), y = Y(v); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.stroke();
    c.fillStyle = cols[k % cols.length];
    c.font = `${11 * dpr}px "IBM Plex Mono",monospace`;
    c.textAlign = "right";
    c.fillText(hasInf && k === rows.length - 1 ? "non-decaying"
               : `${(+taus[k]).toPrecision(3)} ps`,
               cv.width - padR, padT + 11 * dpr + k * 13 * dpr);
  });
  c.fillStyle = "#8a8a8a"; c.font = `${10 * dpr}px "IBM Plex Mono",monospace`;
  c.textAlign = "left";
  c.fillText(`${lam[0].toFixed(0)} nm`, padL, cv.height - 6 * dpr);
  c.textAlign = "right";
  c.fillText(`${lam[lam.length - 1].toFixed(0)} nm`, cv.width - padR, cv.height - 6 * dpr);
  c.textAlign = "left";
  c.fillText(`${(mx).toExponential(1)}`, 2 * dpr, padT + 8 * dpr);
  c.fillText(`-${(mx).toExponential(1)}`, 2 * dpr, cv.height - padB + 2 * dpr);
}

/* ---------------------------------------------------------- components */
function renderComp() {
  const d = activeSet(), host = $("#pane-comp");
  const r = d && d.result;
  if (!r) { host.innerHTML = `<p class="muted">Nothing yet.</p>`; return; }
  const st = r.stages.kinetics && r.stages.kinetics.stability;
  const svd = r.stages.svd;
  let h = "";
  if (svd) {
    h += `<h3 class="sec">From the decomposition</h3>
      <p>${svd.rank} component${svd.rank === 1 ? "" : "s"} stand above the noise.</p>
      ${(svd.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("")}`;
  }
  if (st) {
    h += `<h3 class="sec">How many lifetimes the data support</h3>
      <table class="t"><thead><tr><th class="n">components</th>
      <th class="n">residual</th><th class="n">R&sup2;</th>
      <th>lifetimes / ps</th></tr></thead><tbody>` +
      st.orders.map((n, i) => {
        const taus = (st.taus[i] || []).map((t, j) =>
          `${(+t).toPrecision(4)}${st.resolved[i] && !st.resolved[i][j] ? "*" : ""}`
        ).join("&nbsp; ");
        return `<tr class="${n === st.recommended ? "on" : ""}">
          <td class="n">${n}</td>
          <td class="n">${st.rms[i] === null ? "&mdash;" : (+st.rms[i]).toExponential(2)}</td>
          <td class="n">${sig(st.r_squared[i], 5)}</td>
          <td class="n" style="text-align:left">${taus || "&mdash;"}</td></tr>`;
      }).join("") + `</tbody></table>
      <div class="note ${st.recommended ? "ok" : "bad"}">${st.recommended
        ? `<b>${st.recommended}</b> component${st.recommended === 1 ? "" : "s"} is the
           most these data support without the lifetimes below it moving. A lifetime
           marked * is shorter than the ${st.floor_fs.toFixed(0)} fs instrument
           response and is not resolvable, however well it fits.`
        : `No component count is supportable here: every one needs a lifetime shorter
           than the ${st.floor_fs.toFixed(0)} fs instrument response. Sample the rise
           more finely.`}</div>
      <p class="help" style="margin-top:.6rem">A lifetime that is real stays put when
      another component is added. One that jumps was describing whatever the model
      could not yet fit, not the sample.</p>
      ${(st.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("")}`;
  }
  host.innerHTML = h || `<p class="muted">Nothing to show.</p>`;
}

/* ----------------------------------------------------------- fitting */
const numOr = (id, d) => {
  const v = ($(id).value || "").trim();
  return v === "" ? d : (isFinite(+v) ? +v : d);
};

function fitOpts() {
  const mode = ($$('input[name="fitmode"]').find(r => r.checked) || {}).value;
  const o = {
    auto: mode === "auto",
    max_components: numOr("#f-max", 4),
    infinite: $("#f-infinite").checked,
    sequential: $("#f-sequential").checked,
    chirp_mode: $("#f-chirp").value,
    remove_artifact: $("#f-artifact").checked,
  };
  if (mode === "n") o.n_components = numOr("#f-n", 2);
  if (mode === "taus") {
    const t = ($("#f-taus").value || "").split(/[,\s]+/)
      .map(Number).filter(v => isFinite(v) && v > 0);
    if (t.length) o.taus = t;
  }
  const irf = numOr("#f-irf", null);
  if (irf) o.irf_fwhm_fs = irf;
  for (const [k, id] of [["delay_lo", "#f-dlo"], ["delay_hi", "#f-dhi"],
                         ["wl_lo", "#f-wlo"], ["wl_hi", "#f-whi"]]) {
    const v = numOr(id, null);
    if (v !== null) o[k] = v;
  }
  return o;
}

function renderFitSets() {
  const sel = $("#f-set");
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = S.sets.filter(d => d.ok)
    .map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
  $("#stepfit").hidden = !S.sets.some(d => d.ok);
}

async function doFit() {
  const id = $("#f-set").value;
  if (!id) return;
  const btn = $("#b-fit");
  btn.disabled = true;
  $("#fithint").textContent = "fitting\u2026";
  $("#fitout").innerHTML = `<p class="muted">Working. Choosing how many
    components means fitting the map once per count, so this takes a few
    seconds on a large map.</p>`;
  try {
    const r = await api("/api/fit", { id, options: fitOpts() });
    S.fit = r;
    renderFit();
    $("#fithint").textContent = "";
  } catch (e) {
    $("#fitout").innerHTML = `<div class="note bad">${esc(String(e))}</div>`;
    $("#fithint").textContent = "";
  } finally {
    btn.disabled = false;
  }
}

function renderFit() {
  const r = S.fit, host = $("#fitout");
  if (!r) { host.innerHTML = ""; return; }
  if (r.error) {
    host.innerHTML = `<div class="note bad">The fit failed: ${esc(r.error)}</div>
      ${(r.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("")}`;
    return;
  }
  const st = r.stability;
  const tail = (r.chosen_why || "").replace(/^\d+ components?[:,] ?/, "");
  const verdict = r.chosen
    ? `<b>${r.chosen}</b> exponential${r.chosen === 1 ? "" : "s"}: `
      + esc(tail.charAt(0).toLowerCase() + tail.slice(1))
    : esc(r.chosen_why || "No supportable number of exponentials.");

  let stab = "";
  if (st) {
    stab = `<h3 class="sec">How many the data support</h3>
      <table class="t"><thead><tr><th class="n">components</th>
      <th class="n">residual</th><th class="n">R&sup2;</th>
      <th>lifetimes / ps</th></tr></thead><tbody>` +
      st.orders.map((n, i) => {
        const taus = (st.taus[i] || []).map((t, j) =>
          `${(+t).toPrecision(4)}${st.resolved[i] && !st.resolved[i][j] ? "*" : ""}`
        ).join("&nbsp; ");
        return `<tr class="${n === st.recommended ? "on" : ""}">
          <td class="n">${n}</td>
          <td class="n">${st.rms[i] === null ? "&mdash;" : (+st.rms[i]).toExponential(2)}</td>
          <td class="n">${sig(st.r_squared[i], 5)}</td>
          <td class="n" style="text-align:left">${taus || "&mdash;"}</td></tr>`;
      }).join("") + `</tbody></table>
      <p class="help">A lifetime marked * is shorter than the
      ${st.floor_fs.toFixed(0)} fs resolvability floor (twice the sigma of
      the instrument response) and is not something these data can
      resolve, however well it fits. An order is only taken as enough when
      adding the next component neither moves its lifetimes nor takes
      appreciably more off the residual.</p>
      ${(st.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("")}`;
  }

  const nrm = (r.das || []).map(x => Math.sqrt(x.reduce((a, b) => a + b * b, 0)));
  const big = Math.max(...nrm, 1e-30);
  let rows = (r.taus || []).map((t, i) =>
    `<tr><td>&tau;<sub>${i + 1}</sub></td><td class="n">${sig(t, 5)}</td>
     <td class="n">${sig(r.tau_se[i], 3)}</td>
     <td class="n">${(nrm[i] / big * 100).toFixed(0)}%</td></tr>`).join("");
  if (r.has_infinite)
    rows += `<tr><td>non-decaying</td><td class="n">&infin;</td>
      <td class="n">&mdash;</td><td class="n">&mdash;</td></tr>`;

  host.innerHTML = `
    <div class="note ${r.chosen ? "ok" : "bad"}">${r.chosen
        ? "These data support " + verdict : verdict}</div>
    <details class="adv"><summary>What was done to the map first</summary>
      <div class="inner">
        ${(r.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("")}
        <dl class="kv">
          <dt>fitted over</dt><dd>${r.n_delay} delays
            (${sig(r.delay_lo, 3)} to ${sig(r.delay_hi, 4)} ps),
            ${r.n_wavelength} wavelengths
            (${r.wl_lo.toFixed(0)}&ndash;${r.wl_hi.toFixed(0)} nm)</dd>
          <dt>instrument response</dt><dd>${r.irf_fwhm_fs
            ? r.irf_fwhm_fs.toFixed(0) + " fs FWHM (" + esc(r.irf_source || "") + ")"
            : "&mdash;"}</dd>
        </dl>
      </div></details>
    <div class="grid2" style="margin-top:1rem">
      <div>
        <div class="plot"><canvas id="fitdas"></canvas></div>
        <p class="cap">Decay-associated spectra: how much of each lifetime
          appears at every probe wavelength.</p>
        ${r.eas ? `<div class="plot"><canvas id="fiteas"></canvas></div>
          <p class="cap">Evolution-associated spectra for a sequential
          scheme. It fits identically; only what the spectra mean
          changes.</p>` : ""}
        <div class="plot"><canvas id="fittr"></canvas></div>
        <p class="cap">The fit through the data at a few probe wavelengths,
          on a linear-then-logarithmic delay axis.</p>
      </div>
      <div>
        <h3 class="sec">Lifetimes</h3>
        <table class="t"><thead><tr><th>Component</th><th class="n">ps</th>
          <th class="n">1&sigma;</th><th class="n">weight</th></tr></thead>
          <tbody>${rows}</tbody></table>
        <dl class="kv" style="margin-top:.9rem">
          <dt>R&sup2;</dt><dd>${sig(r.r_squared, 6)}</dd>
          <dt>residual rms</dt><dd>${(+r.residual_rms).toExponential(3)}</dd>
          <dt>degrees of freedom</dt><dd>${r.dof}</dd></dl>
        ${(r.fit_notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("")}
        ${stab}
      </div>
    </div>`;
  redrawFit();
}

function redrawFit() {
  const r = S.fit;
  if (!r || r.error) return;
  if (r.das) plotSpectra("fitdas", r.wavelength, r.das, r.taus, r.has_infinite);
  if (r.eas) plotSpectra("fiteas", r.wavelength, r.eas, r.taus, false);
  if (r.traces && r.traces.length) plotTraces("fittr", r.traces);
}

/* data and fit at a few wavelengths, on the same symlog axis as the map */
function plotTraces(id, traces) {
  const cv = $("#" + id);
  if (!cv || !traces || !traces.length) return;
  const dpr = sizeCanvas(cv, 250);
  const g = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const L = 52 * dpr, R = 10 * dpr, T = 22 * dpr, B = 30 * dpr;
  g.clearRect(0, 0, W, H);

  let t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
  for (const tr of traces) {
    for (let i = 0; i < tr.delay.length; i++) {
      const t = tr.delay[i], v = tr.data[i], f = tr.fit[i];
      if (isFinite(t)) { if (t < t0) t0 = t; if (t > t1) t1 = t; }
      if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (isFinite(f)) { if (f < lo) lo = f; if (f > hi) hi = f; }
    }
  }
  if (!isFinite(t0) || !isFinite(lo) || !(hi > lo)) return;
  const pad = 0.08 * (hi - lo);
  lo -= pad; hi += pad;

  const lin = Math.max(1e-3, Math.min(1, Math.abs(t1 - t0) / 50));
  const u0 = symlog(t0, lin), u1 = symlog(t1, lin);
  const X = t => L + (symlog(t, lin) - u0) / ((u1 - u0) || 1) * (W - L - R);
  const Y = v => T + (hi - v) / ((hi - lo) || 1) * (H - T - B);

  g.lineWidth = 1 * dpr;
  g.strokeStyle = "#d8cfc6";
  g.strokeRect(L, T, W - L - R, H - T - B);
  g.fillStyle = "#6b625b";
  g.font = (11 * dpr) + "px system-ui, sans-serif";
  g.textAlign = "center";
  for (const t of delayTicks(t0, t1, lin)) {
    const x = X(t);
    if (x < L - 1 || x > W - R + 1) continue;
    g.beginPath(); g.moveTo(x, H - B); g.lineTo(x, H - B + 4 * dpr); g.stroke();
    g.fillText(niceLabel(t), x, H - B + 16 * dpr);
  }
  g.textAlign = "right";
  for (let i = 0; i <= 2; i++) {
    const v = lo + (hi - lo) * i / 2, y = Y(v);
    g.beginPath(); g.moveTo(L - 4 * dpr, y); g.lineTo(L, y); g.stroke();
    g.fillText(niceLabel(v), L - 7 * dpr, y + 4 * dpr);
  }
  if (lo < 0 && hi > 0) {
    g.strokeStyle = "#e9e0d7";
    g.beginPath(); g.moveTo(L, Y(0)); g.lineTo(W - R, Y(0)); g.stroke();
  }

  const colour = k => {
    const u = traces.length > 1 ? k / (traces.length - 1) : 0;
    return `rgb(${Math.round(43 + 123 * u)},${Math.round(76 - 30 * u)},` +
           `${Math.round(121 - 57 * u)})`;
  };
  traces.forEach((tr, k) => {
    g.strokeStyle = colour(k);
    g.globalAlpha = 0.3; g.lineWidth = 2.6 * dpr;      // the data, behind
    g.beginPath();
    let started = false;
    tr.delay.forEach((t, i) => {
      const v = tr.data[i];
      if (!isFinite(v)) return;
      started ? g.lineTo(X(t), Y(v)) : (g.moveTo(X(t), Y(v)), started = true);
    });
    g.stroke();
    g.globalAlpha = 1; g.lineWidth = 1.2 * dpr;        // the fit, over it
    g.beginPath();
    started = false;
    tr.delay.forEach((t, i) => {
      const v = tr.fit[i];
      if (!isFinite(v)) return;
      started ? g.lineTo(X(t), Y(v)) : (g.moveTo(X(t), Y(v)), started = true);
    });
    g.stroke();
  });

  g.globalAlpha = 1;
  g.textAlign = "left";
  g.font = (10 * dpr) + "px system-ui, sans-serif";
  let x = L + 4 * dpr;
  traces.forEach((tr, k) => {
    const label = tr.wavelength.toFixed(0) + " nm";
    g.fillStyle = colour(k);
    g.fillText(label, x, 14 * dpr);
    x += g.measureText(label).width + 10 * dpr;
  });
  g.fillStyle = "#6b625b";
  g.textAlign = "center";
  g.font = (11 * dpr) + "px system-ui, sans-serif";
  g.fillText("delay / ps", (L + W - R) / 2, H - 4 * dpr);
}

/* -------------------------------------------------------------- series */
function renderSeries() {
  const host = $("#pane-series"), r = S.shared;
  if (!r) {
    host.innerHTML = `<p class="muted">Tick <i>one set of lifetimes for every
      dataset</i> under “Several datasets together”, then run again.</p>`;
    return;
  }
  let rows = r.taus.map((t, i) =>
    `<tr><td>&tau;<sub>${i + 1}</sub></td><td class="n">${sig(t, 5)}</td>
     <td class="n">${sig(r.tau_se[i], 3)}</td></tr>`).join("");
  if (r.has_infinite)
    rows += `<tr><td>non-decaying</td><td class="n">&infin;</td><td class="n">&mdash;</td></tr>`;
  host.innerHTML = `
    <h3 class="sec">One set of lifetimes across ${r.names.length} datasets</h3>
    <div class="grid2"><div>
      <table class="t"><thead><tr><th>Dataset</th><th class="n">R&sup2;</th>
        <th class="n">residual rms</th></tr></thead><tbody>` +
      r.names.map((n, i) => `<tr><td>${esc(n)}</td>
        <td class="n">${sig(r.r_squared[i], 6)}</td>
        <td class="n">${(+r.residual_rms[i]).toExponential(3)}</td></tr>`).join("") +
      `</tbody></table></div>
      <div><table class="t"><thead><tr><th>Component</th><th class="n">ps</th>
        <th class="n">1&sigma;</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="note ok">Amplitudes stayed free for every dataset and every
        wavelength; only the lifetimes are shared. ${r.dof} degrees of freedom.</div>
      ${(r.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("")}
      </div></div>`;
}

/* -------------------------------------------------------------- report */
function renderReport() {
  const d = activeSet(), host = $("#pane-report");
  if (!d) { host.innerHTML = `<p class="muted">No dataset selected.</p>`; return; }
  let h = `<h3 class="sec">${esc(d.name)}</h3>
    <div class="grid2"><div><dl class="kv">
      <dt>delays</dt><dd>${d.n_delay}</dd>
      <dt>probe wavelengths</dt><dd>${d.n_wavelength}</dd>
      <dt>not finite</dt><dd>${(d.nan_fraction * 100).toFixed(2)}%</dd>
      ${d.pump_nm ? `<dt>pump, read from the file</dt><dd>${(+d.pump_nm).toFixed(0)} nm</dd>` : ""}
      ${d.n_scans ? `<dt>scans, read from the file</dt><dd>${+d.n_scans}</dd>` : ""}
    </dl>${(d.warnings || []).map(n => `<div class="note">${esc(n)}</div>`).join("")}</div>`;

  const r = d.result;
  if (!r) { host.innerHTML = h + `</div>`; return; }
  const sc = r.stages.scatter;
  h += `<div>`;
  if (sc) {
    h += `<h3 class="sec">Scattered pump</h3>` + (sc.found
      ? `<dl class="kv"><dt>band</dt><dd>${sc.centre_nm.toFixed(1)} nm,
          ${sc.fwhm_nm.toFixed(1)} nm wide</dd>
         <dt>relative to the signal</dt><dd>${sc.strength.toFixed(2)}&times;</dd></dl>`
      : `<p class="muted" style="font-size:.9rem">Nothing was removed.</p>`)
      + (sc.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("");
  }
  h += `</div></div>`;

  const u = r.stages.uncertainty;
  if (u) {
    h += `<h3 class="sec">Error bars</h3>
      <table class="t"><thead><tr><th>Parameter</th><th class="n">value</th>
      <th class="n">1&sigma;</th><th class="n">if the chirp were fixed</th>
      <th class="n">widening</th></tr></thead><tbody>` +
      u.names.map((nm, i) => `<tr><td>${esc(nm)}</td>
        <td class="n">${sig(u.values[i], 5)}</td><td class="n">${sig(u.se[i], 3)}</td>
        <td class="n">${u.se_chirp_fixed[i] === null ? "&mdash;" : sig(u.se_chirp_fixed[i], 3)}</td>
        <td class="n">${u.inflation[i] === null ? "&mdash;"
          : (+u.inflation[i]).toFixed(2) + "&times;"}</td></tr>`).join("") +
      `</tbody></table>`;
    const tauIdx = u.names.map((n, i) => n.startsWith("tau_") ? i : -1).filter(i => i >= 0);
    if (tauIdx.length) {
      h += `<h3 class="sec">What a less certain chirp would cost</h3>
        <table class="t"><thead><tr><th>If time zero were known only to</th>` +
        tauIdx.map(i => `<th class="n">${esc(u.names[i])}</th>`).join("") +
        `</tr></thead><tbody>` +
        Object.keys(u.cost).map(fs => `<tr><td>${fs} fs</td>` +
          tauIdx.map(i => {
            const v = u.cost[fs][i];
            return `<td class="n">${v === null ? "&mdash;"
              : (v / u.se[i]).toFixed(2) + "&times;"}</td>`;
          }).join("") + `</tr>`).join("") + `</tbody></table>
        <p class="help">Correcting the chirp before fitting kinetics does not remove
        its uncertainty, it stops reporting it. A correction placed by eye is usually
        good to a few tens of femtoseconds.</p>`;
    }
    h += (u.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("");
  }
  h += (r.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("");
  h += `<h3 class="sec">Save</h3><div class="loadrow">
    <button class="btn sm" data-exp="csv">Corrected data (CSV)</button>
    <button class="btn sm" data-exp="npz">Corrected data (NPZ)</button>
    <button class="btn sm" data-exp="json">Full report (JSON)</button></div>`;
  host.innerHTML = h;
  $$("[data-exp]", host).forEach(b => { b.onclick = () => doExport(b.dataset.exp); });
}

async function doExport(kind) {
  const d = activeSet(); if (!d) return;
  try {
    const r = await api("/api/export", { id: d.id, kind });
    const bin = atob(r.b64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([u8], { type: r.ctype }));
    const a = document.createElement("a");
    a.href = url; a.download = r.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    status(`Saved ${r.name}.`, "ok");
  } catch (e) { status(e.message, "bad"); }
}

/* ------------------------------------------------------------ coherence */
function renderCoh() {
  const d = activeSet(), host = $("#pane-coh");
  const c = d && d.coh;
  if (!c) {
    host.innerHTML = `<p class="muted">Tick <i>map vibrational coherence</i> in
      step 2 and run again.</p>`;
    return;
  }
  if (c.error) { host.innerHTML = `<div class="note bad">${esc(c.error)}</div>`; return; }
  const rows = (c.assignments || []).map(([f, a, near]) =>
    `<tr><td class="n">${f.toFixed(0)}</td><td class="n">${a.toExponential(2)}</td>
     <td>${near.length ? near.map(x => x.toFixed(0)).join(", ") + " (solvent)"
                       : "&mdash;"}</td></tr>`).join("");
  const modes = (c.modes_cm || []).map((f, i) =>
    `<tr><td class="n">${f.toFixed(1)}</td>
     <td class="n">${c.modes_damping_ps[i].toFixed(3)}</td></tr>`).join("");
  host.innerHTML = `
    <div class="grid2">
      <div>
        <div class="plot"><canvas id="cohcv"></canvas></div>
        <p class="cap">Amplitude of the oscillation left after the kinetics,
          summed over the probe. Resolution ${c.resolution_cm.toFixed(0)} cm&#8315;&#185;
          from a ${(c.window[1] - c.window[0]).toFixed(2)} ps window at
          ${c.dt_fs.toFixed(0)} fs steps.</p>
        <div class="plot"><canvas id="cohmap"></canvas></div>
        <p class="cap">Amplitude against probe wavelength and frequency. A mode
          that modulates one band only shows as a patch; one that runs across the
          whole probe is usually the solvent or the instrument.</p>
      </div>
      <div>
        <h3 class="sec">Strongest frequencies</h3>
        <table class="t"><thead><tr><th class="n">cm&#8315;&#185;</th>
          <th class="n">amplitude</th><th>near a known line</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="3" class="muted">nothing above the
            noise</td></tr>`}</tbody></table>
        ${modes ? `<h3 class="sec">Fitted modes</h3>
          <table class="t"><thead><tr><th class="n">cm&#8315;&#185;</th>
            <th class="n">dephasing / ps</th></tr></thead><tbody>${modes}</tbody></table>` : ""}
        ${(c.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("")}
      </div>
    </div>`;
  plotLine("cohcv", c.freq_cm, [c.spectrum], ["amplitude"], "cm\u207B\u00B9");
  plotHeat("cohmap", c.amp_map, c.wavelength, c.freq_cm);
}

function plotLine(id, x, rows, labels, xunit) {
  const cv = $("#" + id); if (!cv || !x || !x.length) return;
  const dpr = sizeCanvas(cv, 180);
  const c = cv.getContext("2d");
  c.clearRect(0, 0, cv.width, cv.height);
  const padL = 40 * dpr, padR = 10 * dpr, padT = 10 * dpr, padB = 24 * dpr;
  let mx = 0;
  rows.forEach(r => r.forEach(v => { if (isFinite(v)) mx = Math.max(mx, v); }));
  mx = mx || 1;
  const X = i => padL + i / (x.length - 1) * (cv.width - padL - padR);
  const Y = v => padT + (1 - v / mx) * (cv.height - padT - padB);
  c.strokeStyle = "#e9e9e9"; c.lineWidth = dpr;
  c.beginPath(); c.moveTo(padL, Y(0)); c.lineTo(cv.width - padR, Y(0)); c.stroke();
  const cols = [css("--accent"), "#2d6d88"];
  rows.forEach((r, k) => {
    c.strokeStyle = cols[k % cols.length]; c.lineWidth = 1.8 * dpr;
    c.beginPath();
    r.forEach((v, i) => { const xx = X(i), yy = Y(v); i ? c.lineTo(xx, yy) : c.moveTo(xx, yy); });
    c.stroke();
  });
  c.fillStyle = "#8a8a8a"; c.font = `${10 * dpr}px "IBM Plex Mono",monospace`;
  c.textAlign = "left"; c.fillText(String(Math.round(x[0])), padL, cv.height - 6 * dpr);
  c.textAlign = "right";
  c.fillText(`${Math.round(x[x.length - 1])} ${xunit}`, cv.width - padR,
             cv.height - 6 * dpr);
}

function plotHeat(id, m, xs, ys) {
  const cv = $("#" + id); if (!cv || !m) return;
  const dpr = sizeCanvas(cv, 200);
  const c = cv.getContext("2d");
  const z = decode(m), vmax = robustMax(z);
  const img = new ImageData(m.cols, m.rows);
  for (let i = 0; i < z.length; i++) {
    const p = i * 4;
    const v = isFinite(z[i]) ? Math.min(1, Math.abs(z[i]) / vmax) : 0;
    const col = cmap(v);                      // one-sided: amplitude only
    img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2];
    img.data[p + 3] = 255;
  }
  const buf = document.createElement("canvas");
  buf.width = m.cols; buf.height = m.rows;
  buf.getContext("2d").putImageData(img, 0, 0);
  const padL = 40 * dpr, padB = 22 * dpr;
  c.clearRect(0, 0, cv.width, cv.height);
  c.imageSmoothingEnabled = true;
  c.drawImage(buf, padL, 0, cv.width - padL - 8 * dpr, cv.height - padB);
  c.fillStyle = "#8a8a8a"; c.font = `${10 * dpr}px "IBM Plex Mono",monospace`;
  c.textAlign = "right"; c.textBaseline = "top";
  c.fillText(`${Math.round(ys[ys.length - 1])}`, padL - 5 * dpr, 2 * dpr);
  c.fillText(`${Math.round(ys[0])} cm`, padL - 5 * dpr, cv.height - padB - 12 * dpr);
  c.textAlign = "left";
  c.fillText(`${Math.round(xs[0])} nm`, padL, cv.height - padB + 4 * dpr);
  c.textAlign = "right";
  c.fillText(`${Math.round(xs[xs.length - 1])} nm`, cv.width - 8 * dpr,
             cv.height - padB + 4 * dpr);
}

/* ------------------------------------------------------------- posterior */
function renderPost() {
  const d = activeSet(), host = $("#pane-post");
  const p = d && d.post;
  if (!p) {
    host.innerHTML = `<p class="muted">Tick <i>sample the posterior</i> in step 2
      and run again.</p>`;
    return;
  }
  if (p.error) { host.innerHTML = `<div class="note bad">${esc(p.error)}</div>`; return; }
  const k = d.result && d.result.stages.kinetics;
  const rows = p.taus_median.map((m, i) => {
    const vp = k && k.taus && k.taus[i];
    return `<tr><td>&tau;<sub>${i + 1}</sub></td><td class="n">${sig(m, 5)}</td>
      <td class="n">${sig(p.taus_lo[i], 4)} &ndash; ${sig(p.taus_hi[i], 4)}</td>
      <td class="n">${vp ? sig(vp, 5) : "&mdash;"}</td></tr>`;
  }).join("");
  host.innerHTML = `
    <div class="grid2">
      <div>
        <div class="plot"><canvas id="sadscv"></canvas></div>
        <p class="cap">Species spectra with a 95% credible band, recomputed for
          every retained draw rather than drawn once at the optimum.</p>
      </div>
      <div>
        <h3 class="sec">Rates (${esc(p.scheme)})</h3>
        <table class="t"><thead><tr><th>Component</th><th class="n">median / ps</th>
          <th class="n">95% credible</th><th class="n">least squares</th>
          </tr></thead><tbody>${rows}</tbody></table>
        <dl class="kv" style="margin-top:.8rem">
          <dt>acceptance</dt><dd>${(p.acceptance * 100).toFixed(0)}%</dd>
          <dt>BIC</dt><dd>${p.bic.toFixed(1)}</dd></dl>
        ${(p.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("")}
      </div>
    </div>`;
  plotBand("sadscv", p.wavelength, p.sads_median, p.sads_lo, p.sads_hi);
}

function plotBand(id, lam, med, lo, hi) {
  const cv = $("#" + id); if (!cv || !med || !med.length) return;
  const dpr = sizeCanvas(cv, 230);
  const c = cv.getContext("2d");
  c.clearRect(0, 0, cv.width, cv.height);
  const padL = 36 * dpr, padR = 10 * dpr, padT = 12 * dpr, padB = 22 * dpr;
  let mx = 0;
  hi.forEach(r => r.forEach(v => { if (isFinite(v)) mx = Math.max(mx, Math.abs(v)); }));
  lo.forEach(r => r.forEach(v => { if (isFinite(v)) mx = Math.max(mx, Math.abs(v)); }));
  mx = mx || 1;
  const X = i => padL + i / (lam.length - 1) * (cv.width - padL - padR);
  const Y = v => padT + (1 - (v / mx + 1) / 2) * (cv.height - padT - padB);
  c.strokeStyle = "#e9e9e9"; c.lineWidth = dpr;
  c.beginPath(); c.moveTo(padL, Y(0)); c.lineTo(cv.width - padR, Y(0)); c.stroke();
  const cols = ["166,46,64", "45,109,136", "106,143,60", "138,93,18", "95,95,95"];
  med.forEach((row, k) => {
    const rgb = cols[k % cols.length];
    c.fillStyle = `rgba(${rgb},.22)`;
    c.beginPath();
    hi[k].forEach((v, i) => { const x = X(i), y = Y(v); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    for (let i = lo[k].length - 1; i >= 0; i--) c.lineTo(X(i), Y(lo[k][i]));
    c.closePath(); c.fill();
    c.strokeStyle = `rgb(${rgb})`; c.lineWidth = 1.7 * dpr;
    c.beginPath();
    row.forEach((v, i) => { const x = X(i), y = Y(v); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.stroke();
  });
  c.fillStyle = "#8a8a8a"; c.font = `${10 * dpr}px "IBM Plex Mono",monospace`;
  c.textAlign = "left"; c.fillText(`${lam[0].toFixed(0)} nm`, padL, cv.height - 5 * dpr);
  c.textAlign = "right";
  c.fillText(`${lam[lam.length - 1].toFixed(0)} nm`, cv.width - padR, cv.height - 5 * dpr);
}

/* --------------------------------------------------------------- fluence */
function renderFluence() {
  const host = $("#pane-fluence");
  if (host.dataset.built) return;
  host.dataset.built = "1";
  host.innerHTML = `
    <div class="grid2">
      <div>
        <h3 class="sec">Excitation density</h3>
        <div class="optrow">
          <label>pulse energy <input type="number" id="f-e" value="0.35" step="0.05"> &micro;J</label>
          <label>spot FWHM <input type="number" id="f-spot" value="200" step="10"> &micro;m</label>
          <label>pump <input type="number" id="f-wl" value="465" step="5"> nm</label>
        </div>
        <div class="optrow">
          <label>absorbance <input type="number" id="f-a" value="0.3" step="0.05"></label>
          <label>path <input type="number" id="f-l" value="2" step="0.5"> mm</label>
          <label>concentration <input type="number" id="f-c" value="5e-5" step="1e-5"> M</label>
        </div>
        <p class="help">The peak of the Gaussian is reported, not the pulse
          average: it is twice as large, and it is the number annihilation
          responds to.</p>
        <dl class="kv" id="f-out" style="margin-top:.8rem"></dl>
        <div id="f-notes"></div>
      </div>
      <div>
        <h3 class="sec">Annihilation across the series</h3>
        <p class="help" style="margin-top:0">Fits one first-order rate and an
          annihilation term to every corrected dataset at once, with the
          annihilation forced to scale with the fluence. One trace cannot
          separate the two; a series can.</p>
        <div class="optrow">
          <label>band <input type="number" id="f-lo" value="0" step="10"> to
            <input type="number" id="f-hi" value="0" step="10"> nm</label>
          <label>from <input type="number" id="f-t0" value="0.3" step="0.1"> ps</label>
        </div>
        <div class="optrow">
          <label style="flex:1">relative fluences, in dataset order
            <input type="text" id="f-fl" placeholder="1, 0.68, 0.35" style="width:100%"></label>
        </div>
        <button class="btn sm" id="f-run">Fit the series</button>
        <div id="f-ann" style="margin-top:.8rem"></div>
      </div>
    </div>`;
  const calc = async () => {
    try {
      const r = await api("/api/fluence", { options: {
        pulse_energy_uj: +$("#f-e").value, spot_fwhm_um: +$("#f-spot").value,
        wavelength_nm: +$("#f-wl").value, absorbance: $("#f-a").value,
        path_mm: +$("#f-l").value, concentration_m: $("#f-c").value } });
      $("#f-out").innerHTML = `
        <dt>photons / pulse</dt><dd>${r.photons_per_pulse.toExponential(3)}</dd>
        <dt>peak fluence</dt><dd>${r.peak_fluence_uj_cm2.toPrecision(4)} &micro;J/cm&sup2;</dd>
        <dt>absorbed</dt><dd>${(r.absorbed_fraction * 100).toFixed(1)}%</dd>
        <dt>excitation density</dt><dd>${r.density_cm3.toExponential(3)} /cm&sup3;</dd>
        <dt>per molecule</dt><dd>${r.per_molecule === null ? "&mdash;"
          : r.per_molecule.toFixed(4)}</dd>`;
      $("#f-notes").innerHTML = (r.notes || [])
        .map(n => `<div class="note">${esc(n)}</div>`).join("");
    } catch (e) { $("#f-notes").innerHTML = `<div class="note bad">${esc(e.message)}</div>`; }
  };
  ["f-e", "f-spot", "f-wl", "f-a", "f-l", "f-c"].forEach(i => {
    $("#" + i).oninput = calc;
  });
  $("#f-run").onclick = async () => {
    const done = S.sets.filter(d => d.result);
    const fl = String($("#f-fl").value || "").split(",").map(Number)
      .filter(n => isFinite(n) && n > 0);
    if (fl.length !== done.length) {
      $("#f-ann").innerHTML = `<div class="note bad">Give ${done.length}
        fluences, one per corrected dataset, in the order they are listed.</div>`;
      return;
    }
    try {
      const r = await api("/api/annihilation", { ids: done.map(d => d.id), options: {
        fluences: fl, band_lo: +$("#f-lo").value, band_hi: +$("#f-hi").value,
        t0_ps: +$("#f-t0").value } });
      $("#f-ann").innerHTML = `
        <dl class="kv"><dt>first-order lifetime</dt>
          <dd>${sig(r.tau1_ps, 5)} ps</dd>
          <dt>R&sup2;</dt><dd>${sig(r.r_squared, 5)}</dd>
          <dt>scales with fluence</dt><dd>r = ${r.linear_in_fluence.toFixed(4)}</dd>
          ${r.gamma_cm3_ps !== null ? `<dt>gamma</dt>
            <dd>${r.gamma_cm3_ps.toExponential(3)} cm&sup3;/ps</dd>` : ""}</dl>
        <table class="t" style="margin-top:.6rem"><thead><tr><th>Dataset</th>
          <th class="n">fluence</th><th class="n">&gamma;n&#8320; / ps&#8315;&#185;</th>
          </tr></thead><tbody>` +
        r.names.map((n, i) => `<tr><td>${esc(n)}</td>
          <td class="n">${r.fluences[i]}</td>
          <td class="n">${r.gamma_n0[i].toExponential(3)}</td></tr>`).join("") +
        `</tbody></table>` +
        (r.notes || []).map(n => `<div class="note">${esc(n)}</div>`).join("");
    } catch (e) { $("#f-ann").innerHTML = `<div class="note bad">${esc(e.message)}</div>`; }
  };
  calc();
}

function renderAll() { renderMapPane(); renderKin(); renderComp();
                       renderSeries(); renderReport(); }

/* ----------------------------------------------------------------- run */
async function run() {
  const chosen = S.sets.filter(d => d.sel);
  if (!chosen.length) return;
  S.busy = true; hint(); S.shared = null;
  const o = opts();
  let donor = null;
  try {
    for (let i = 0; i < chosen.length; i++) {
      const d = chosen[i];
      d.state = "busy"; renderSets();
      status(`Correcting ${d.name}: ${i + 1} of ${chosen.length}…`);
      prog(i / chosen.length);
      const body = { id: d.id, options: { ...o } };
      if (o.shared_chirp && donor) body.options._shared_fit_from = donor;
      try {
        const res = await api("/api/process", body);
        d.result = res;
        const warned = (res.stages.chirp.notes || []).length +
          ((res.stages.diagnostics || {}).artifact_notes || []).length;
        d.state = warned ? "warn" : "ok";
        if (o.shared_chirp && !donor) donor = d.id;
      } catch (e) {
        d.state = "bad"; d.result = null;
        status(`${d.name}: ${e.message}`, "bad");
      }
      renderSets();
    }
    const done = chosen.filter(d => d.result);
    if (o.coherence && done.length) {
      for (const d of done) {
        status(`Mapping coherence in ${d.name}…`);
        try {
          d.coh = await api("/api/coherence", { id: d.id, options: {
            method: "lpsvd", n_modes: o.coh_modes, max_cm: o.coh_max,
            window: [o.coh_lo, o.coh_hi], solvent: o.coh_solvent } });
        } catch (e) { d.coh = { error: e.message }; }
      }
    }
    if (o.posterior && done.length) {
      for (const d of done) {
        status(`Sampling the posterior for ${d.name}…`);
        try {
          d.post = await api("/api/posterior", { id: d.id, options: {
            n_steps: o.post_steps, scheme: o.scheme } });
        } catch (e) { d.post = { error: e.message }; }
      }
    }
    prog(1);
    if (done.length && (!S.active || !activeSet().result)) S.active = done[0].id;

    if (o.shared_kinetics && done.length > 1) {
      status("Fitting one set of lifetimes across the series…");
      try {
        S.shared = await api("/api/shared",
          { ids: done.map(d => d.id), options: o });
      } catch (e) { status("Series fit: " + e.message, "bad"); }
    }
    $("#step3").hidden = done.length === 0;
    if (S.shared) S.tab = "series";
    const want = (location.search.match(/[?&]tab=(\w+)/) || [])[1];
    if (want && TABS.some(([k]) => k === want)) S.tab = want;
    renderSets(); renderTabs(); renderAll(); showTab();
    if (done.length) {
      status(`Done: ${done.length} of ${chosen.length} corrected.`, "ok");
      $("#step3").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } finally {
    S.busy = false; hint(); setTimeout(() => prog(0), 600);
  }
}

/* ---------------------------------------------------------------- boot */
function wire() {
  $("#b-files").onclick = () => picker(false);
  $("#b-folder").onclick = () => picker(true);
  $("#drop").onclick = () => picker(false);
  $("#b-run").onclick = run;
  $("#b-fit").onclick = doFit;
  $$('input[name="fitmode"]').forEach(r => { r.onchange = () => {
    $("#f-n").disabled = r.value !== "n" && !$("#f-n").value;
  }; });
  $("#b-clear").onclick = async () => {
    await api("/api/clear", {}).catch(() => {});
    S.sets = []; S.active = null; S.shared = null; MAP = null;
    renderSets(); $("#step3").hidden = true; status("Cleared.");
  };
  $("#b-demo").onclick = async () => {
    status("Building an example fluence series…");
    try {
      const r = await api("/api/demo", { n: 3 });
      r.datasets.forEach(d => S.sets.push({ ...d, sel: true, state: "ok",
                                            result: null }));
      if (!S.active) S.active = S.sets[0].id;
      $("#o-shared_kinetics").checked = true;
      $("#o-descatter").checked = true;
      renderSets();
      status("Example loaded. Press “Correct everything”.", "ok");
    } catch (e) { status(e.message, "bad"); }
  };

  const drop = $("#drop");
  let depth = 0;
  ["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => {
    e.preventDefault(); if (ev === "dragenter") depth++; drop.classList.add("hot"); }));
  document.addEventListener("dragleave", e => {
    e.preventDefault(); if (--depth <= 0) { depth = 0; drop.classList.remove("hot"); } });
  document.addEventListener("drop", async e => {
    e.preventDefault(); depth = 0; drop.classList.remove("hot");
    const items = e.dataTransfer.items, out = [];
    if (items && items.length && items[0].webkitGetAsEntry) {
      for (const it of [...items]) {
        const en = it.webkitGetAsEntry();
        if (en) await walkEntry(en, out);
      }
    }
    await addFiles(out.length ? out : e.dataTransfer.files);
  });
  addEventListener("resize", () => {
    if (S.tab === "map") drawMap();
    if (S.tab === "kin") redrawSpectra();
    if (S.fit) redrawFit();
  });
}

async function restore() {
  try {
    const { datasets } = await api("/api/state", {});
    if (!datasets || !datasets.length) return;
    datasets.forEach(d => S.sets.push({ ...d, sel: true, result: null,
      state: d.warnings.length ? "warn" : "ok" }));
    S.active = S.sets[0].id;
    renderSets();
    status(`${datasets.length} dataset(s) already loaded on the server.`, "ok");
  } catch (e) { /* a fresh server has nothing to restore */ }
}

/* If nothing answers at all, say so once rather than leaving dead buttons. */
if (!window.starlingBridge) fetch("/health").then(r => { if (!r.ok) goOffline(); }).catch(goOffline);

renderTabs(); wire(); renderSets();
restore().then(() => {
  // ?autorun=1 runs the pipeline on load. Used by the screenshot harness, and
  // handy for a bookmark that re-runs the last session.
  if (/[?&]all=1/.test(location.search)) {
    ["coherence", "posterior", "descatter", "sequential", "shared_kinetics"]
      .forEach(k => { const el = $("#o-" + k); if (el) el.checked = true; });
  }
  if (/[?&]autorun=1/.test(location.search) && S.sets.length) run();
  // ?fit=1 runs the standalone fit instead, for the screenshot harness
  const m = location.search.match(/[?&]fit=1(?:&irf=(\d+))?/);
  if (m && S.sets.length) {
    if (m[1]) $("#f-irf").value = m[1];
    renderFitSets();
    doFit();
  }
});
