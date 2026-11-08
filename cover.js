/* Opening cover for the home page: a live Belousov–Zhabotinsky simulation (Barkley excitable medium,
   WebGL2) behind the name and one sentence. It gives way to the page after about ten seconds, on Enter,
   on scroll or a key, or on a click on Home; the other top-bar links go straight to their pages.
   Shown once per browser session; add ?intro to the URL to see it again. */
(() => {
"use strict";
const root = document.documentElement;
const cover = document.getElementById("cover");
if (!cover || !root.classList.contains("cover-on")) { if (cover) cover.remove(); return; }
const canvas = cover.querySelector("canvas");

// ---------- tunables (identical to the standalone demo) ------------------------------------------
const SHOW_MS     = 10000;  // how long the cover stays before giving way to the page
const FADE_MS     = 900;    // cross-fade into the page
const SIM_SCALE   = 0.26;   // simulation cells per CSS pixel
const SIM_MAX_W   = 800;
const STEPS_PER_S = 100;    // integration steps per second of wall time
const DT = 0.2, DU = 0.6, DV = 0.12;
const DC = 0.9, KC = 0.75, KC_DOWN = 0.33;   // visible colour follows the catalyst, about 4x slower
const NUC_MEAN = 2, NUC_SD = 1.6;            // number of nucleation points: Gaussian, clamped to 1..10
const A = 0.75, EPS = 0.04, VRATE = 0.5, B = 0.02, U_FLOOR = 0.01;
const BULK_PERIOD = 1000, BULK_SWEEP = 120, BULK_VTH = 0.06;
const FLASH_RISE = 245, FLASH_HOLD = 30, FLASH_FALL = 575, AGE_IDLE = 4000;
const WARMUP = 120;         // steps run before the first frame, so rings are already forming
const BULK_FIRST = 80;      // steps after the first frame before the screen-wide flash begins
const NUC_DB = 0.0007, NUC_VTH = 0.025, HETERO = 0.0015;
const CURSOR_R = 6, CURSOR_VTH = 0.06, CLICK_R = 5, STIR_R = 5;
const LENS_SIGMA = 170, LENS_PULL = 0.14;

const gl = canvas.getContext("webgl2", {antialias:false, alpha:false, powerPreference:"low-power"});
if (!gl || !gl.getExtension("EXT_color_buffer_float")) { bail(); return; }
try { sessionStorage.setItem("cover-seen", "1"); } catch (e) {}

const VS = `#version 300 es
in vec2 a; out vec2 uv; void main(){ uv = a*.5+.5; gl_Position = vec4(a,0.,1.); }`;

// R = activator, G = oxidised catalyst, B = visible colour, A = steps since this cell's bulk flash began
const FS_SIM = `#version 300 es
precision highp float;
uniform sampler2D tex; uniform vec2 res;
uniform vec2 cur, cur0; uniform float curOn;
uniform vec2 pulse; uniform float pulseOn;
uniform vec2 s0, s1; uniform float stirOn;
uniform vec2 nuc[10]; uniform int nNuc;
uniform float bulkPhase, bulkCycle;
in vec2 uv; out vec4 o;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float segDist(vec2 p, vec2 a, vec2 b){ vec2 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-6),0.,1.); return length(pa-ba*h); }
void main(){
  vec2 px = 1.0/res;
  vec4 c4 = texture(tex, uv); vec3 c = c4.rgb; float age = c4.a;
  vec3 lap = texture(tex, uv-vec2(px.x,0.)).rgb + texture(tex, uv+vec2(px.x,0.)).rgb
           + texture(tex, uv-vec2(0.,px.y)).rgb + texture(tex, uv+vec2(0.,px.y)).rgb - 4.0*c;
  float u=c.r, v=c.g, col=c.b;
  vec2 p = uv*res;
  float h = vnoise(p*0.07) * 0.65 + vnoise(p*0.19 + 31.7) * 0.35;
  float b = ${B.toFixed(4)} + ${HETERO.toFixed(4)} * (h - 0.5) * 2.0;
  for (int i = 0; i < 10; i++) { if (i >= nNuc) break;
    b -= ${NUC_DB.toFixed(4)} * (1.0 - smoothstep(${CLICK_R.toFixed(1)}*0.6, ${CLICK_R.toFixed(1)}, distance(p, nuc[i]))); }
  float uth = (v + b) / ${A.toFixed(3)};
  float f = u*(1.0-u)*(u-uth) / ${EPS.toFixed(3)};
  float un = clamp(u + ${DT}*(${DU}*lap.x + f), ${U_FLOOR}, 0.999);
  float vn = max(v + ${DT}*(${DV}*lap.y + ${VRATE}*(u - v)), 0.0);
  float tgt = smoothstep(0.093, 0.48, 0.9*vn);
  float kc = tgt > col ? ${KC.toFixed(3)} : ${KC_DOWN.toFixed(3)};
  float cn = clamp(col + ${DT}*(${DC}*lap.z + kc*(tgt - col)), 0.0, 1.0);
  // cursor: a pacemaker along its path
  if (curOn > 0.5 && vn < ${CURSOR_VTH.toFixed(3)} && segDist(p, cur0, cur) < ${CURSOR_R.toFixed(1)}) un = 0.999;
  // slow screen-wide flash, starting in a few places and spreading
  { vec2 q = p * (1.0/90.0) + vec2(bulkCycle*17.31, bulkCycle*7.93);
    float n = vnoise(q)*0.7 + vnoise(q*2.1 + 13.7)*0.3;
    float off = clamp((n - 0.22)/0.56, 0.0, 1.0) * ${BULK_SWEEP.toFixed(1)};
    if (bulkPhase >= off && bulkPhase < off + 1.0) { age = 0.0; if (vn < ${BULK_VTH.toFixed(3)}) un = 0.999; }
    else age = min(age + 1.0, ${AGE_IDLE.toFixed(1)}); }
  // nucleation points
  for (int i = 0; i < 10; i++) { if (i >= nNuc) break;
    float vi = texture(tex, nuc[i]/res).g;
    if (vi < ${NUC_VTH.toFixed(3)} && distance(p, nuc[i]) < ${CLICK_R.toFixed(1)}) un = 0.999; }
  if (pulseOn > 0.5 && distance(p, pulse) < ${CLICK_R.toFixed(1)}) un = 0.999;      // click
  if (stirOn > 0.5 && segDist(p, s0, s1) < ${STIR_R.toFixed(1)}) un = ${U_FLOOR};    // drag cuts waves
  o = vec4(un, vn, cn, age);
}`;

const FS_SHOW = `#version 300 es
precision highp float;
uniform sampler2D tex; uniform vec2 res, mouse; uniform float dpr, mAmt, feather, time;
uniform vec4 rects[16];
in vec2 uv; out vec4 o;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float textMask(vec2 q){ float m=0.;
  for(int i=0;i<16;i++){ vec4 r=rects[i]; float ok=step(r.x+1.,r.z);
    vec2 cen=(r.xy+r.zw)*.5, hs=(r.zw-r.xy)*.5; vec2 d=abs(q-cen)-hs;
    float od=length(max(d,0.))+min(max(d.x,d.y),0.);
    m=max(m, ok*(1.-smoothstep(0.,feather,od))); }
  return m; }
void main(){
  vec2 q = vec2(gl_FragCoord.x, res.y-gl_FragCoord.y)/dpr;
  vec2 dm = q - mouse;
  float lens = exp(-dot(dm,dm)/(2.*${LENS_SIGMA}.*${LENS_SIGMA}.)) * mAmt;
  vec2 qs = q + (mouse - q) * lens * ${LENS_PULL};
  vec4 s = texture(tex, vec2(qs.x*dpr/res.x, 1.0 - qs.y*dpr/res.y));
  float u = s.r, v = s.g, c = s.b, age = s.a;
  float E = smoothstep(0.0, ${FLASH_RISE.toFixed(1)}, age) * (1.0 - smoothstep(${(FLASH_RISE+FLASH_HOLD).toFixed(1)}, ${(FLASH_RISE+FLASH_HOLD+FLASH_FALL).toFixed(1)}, age));
  c = max(c, E);
  vec3 red = vec3(0.82, 0.25, 0.12), redL = vec3(0.93, 0.44, 0.19), mid = vec3(0.56, 0.38, 0.48);
  vec3 blue = vec3(0.22, 0.41, 0.72), blueL = vec3(0.63, 0.81, 0.95);
  vec3 rest = mix(redL, red, smoothstep(0.0, 0.25, c)*0.6);
  vec3 col = c < 0.5 ? mix(rest, mid, c*2.0) : mix(mid, blue, (c-0.5)*2.0);
  float rim = smoothstep(0.15, 0.85, u) * (1.0 - smoothstep(0.15, 0.45, v));
  col = mix(col, blueL, rim*0.8);
  col = mix(col, vec3(1.0), 0.06*lens);
  vec3 paper = vec3(0.984, 0.949, 0.918);            // the home band colour, so the fade into the page is seamless
  col = mix(col, mix(col, paper, 0.86), textMask(q));
  col += (hash(gl_FragCoord.xy + time) - 0.5) * 0.012;
  o = vec4(col, 1.0);
}`;

function compile(type, src){ const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
function program(fs){ const p=gl.createProgram(); gl.attachShader(p,compile(gl.VERTEX_SHADER,VS)); gl.attachShader(p,compile(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(p); if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }
let pSim, pShow;
try { pSim = program(FS_SIM); pShow = program(FS_SHOW); } catch (e) { bail(); return; }
const U = (p, names) => { const o={}; for (const n of names) o[n]=gl.getUniformLocation(p,n); return o; };
const uSim  = U(pSim,  ["tex","res","cur","cur0","curOn","pulse","pulseOn","s0","s1","stirOn","nuc","nNuc","bulkPhase","bulkCycle"]);
const uShow = U(pShow, ["tex","res","mouse","dpr","mAmt","feather","time","rects"]);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
for (const p of [pSim,pShow]) { const a=gl.getAttribLocation(p,"a"); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0); }

// ---------- state ---------------------------------------------------------------------------------
let cssW=0, cssH=0, W=0, H=0, dpr=1, simW=0, simH=0;
let tex=[null,null], fbo=[null,null], cur=0, nucCount=0, bulkStep=0;
const nucArr = new Float32Array(20);
function makeTex(w,h){
  const t=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,t);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,w,h,0,gl.RGBA,gl.HALF_FLOAT,null);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  const f=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
  gl.clearColor(U_FLOOR,0,0,AGE_IDLE); gl.clear(gl.COLOR_BUFFER_BIT);
  return [t,f];
}
function mulberry(a){ return ()=>{ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function step(ev){
  const nxt=1-cur;
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbo[nxt]);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,tex[cur]);
  gl.uniform1i(uSim.tex,0); gl.uniform2f(uSim.res,simW,simH);
  const cu = ev.cur || [-1e4,-1e4], c0 = ev.cur0 || cu, pu = ev.pulse || [-1e4,-1e4], st = ev.stir || [-1e4,-1e4,-1e4,-1e4];
  gl.uniform2f(uSim.cur, cu[0], cu[1]); gl.uniform2f(uSim.cur0, c0[0], c0[1]); gl.uniform1f(uSim.curOn, ev.cur ? 1 : 0);
  gl.uniform2f(uSim.pulse, pu[0], pu[1]); gl.uniform1f(uSim.pulseOn, ev.pulse ? 1 : 0);
  gl.uniform2f(uSim.s0, st[0], st[1]); gl.uniform2f(uSim.s1, st[2], st[3]); gl.uniform1f(uSim.stirOn, ev.stir ? 1 : 0);
  gl.uniform2fv(uSim.nuc, nucArr); gl.uniform1i(uSim.nNuc, nucCount);
  gl.uniform1f(uSim.bulkPhase, bulkStep % BULK_PERIOD); gl.uniform1f(uSim.bulkCycle, Math.floor(bulkStep / BULK_PERIOD));
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  cur=nxt; bulkStep++;
}
function seed(){
  const rnd = mulberry((Math.random()*2**31)|0);
  const g = Math.sqrt(-2*Math.log(1-rnd()))*Math.cos(6.283185*rnd());
  nucCount = Math.min(10, Math.max(1, Math.round(NUC_MEAN + NUC_SD*g)));
  nucArr.fill(-1e4);
  for (let k=0;k<nucCount;k++){ nucArr[2*k]=(0.08+0.84*rnd())*simW; nucArr[2*k+1]=(0.08+0.84*rnd())*simH; }
  bulkStep = BULK_PERIOD - BULK_FIRST - WARMUP;
  gl.useProgram(pSim); gl.viewport(0,0,simW,simH);
  for (let t=0;t<WARMUP;t++) step({});
}
function sizeCanvas(){
  const r = canvas.getBoundingClientRect();
  cssW = r.width; cssH = r.height; dpr = Math.min(devicePixelRatio||1, 2);
  W = Math.max(1, Math.round(cssW*dpr)); H = Math.max(1, Math.round(cssH*dpr));
  canvas.width = W; canvas.height = H;
}
function rebuild(){
  sizeCanvas();
  const sw = cssW*SIM_SCALE, k = Math.min(1, SIM_MAX_W/sw);
  simW = Math.max(64, Math.round(sw*k)); simH = Math.max(64, Math.round(cssH*SIM_SCALE*k));
  for (const t of tex) if (t) gl.deleteTexture(t);
  for (const f of fbo) if (f) gl.deleteFramebuffer(f);
  [tex[0],fbo[0]] = makeTex(simW,simH); [tex[1],fbo[1]] = makeTex(simW,simH);
  cur = 0; seed(); measureRects();
}
function onResize(){
  const w = canvas.getBoundingClientRect().width;
  if (Math.abs(w - cssW) > 1) rebuild();          // a new width re-seeds the dish
  else { sizeCanvas(); measureRects(); }          // a height change (a phone's address bar) only stretches it
}

// the text sits on a soft halo of the page colour
const rects = new Float32Array(64);
function measureRects(){
  rects.fill(0);
  const o = canvas.getBoundingClientRect();
  let i = 0;
  for (const el of cover.querySelectorAll(".cover-text h1, .cover-text p, .cover-enter")) {
    if (i >= 16) break; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    rects.set([r.left-o.left-6, r.top-o.top-4, r.right-o.left+6, r.bottom-o.top+4], i*4); i++;
  }
}

// ---------- pointer ---------------------------------------------------------------------------------
const mouse = {x:-1e4, y:-1e4, on:0, amt:0, down:false, moved:false};
let pulseAt = null, prevC = null; const stirs = [];
const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
const toSim = (x,y) => [x*simW/cssW, (cssH-y)*simH/cssH];
const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); offs.push(() => t.removeEventListener(ev, fn, opt)); };
const offs = [];
on(cover, "pointermove", e => {
  const [x,y] = local(e);
  if (mouse.down) { const a=toSim(mouse.x,mouse.y), b=toSim(x,y); stirs.push([a[0],a[1],b[0],b[1]]); mouse.moved=true; }
  if (e.pointerType !== "touch") mouse.on = 1;
  mouse.x=x; mouse.y=y;
}, {passive:true});
on(cover, "pointerleave", () => { mouse.on = 0; });
on(cover, "pointerdown", e => { if (e.target.closest(".cover-enter")) return; const [x,y]=local(e); mouse.down=true; mouse.moved=false; mouse.x=x; mouse.y=y; });
on(window, "pointerup", e => { if (mouse.down && !mouse.moved) { const [x,y]=local(e); pulseAt = toSim(x,y); } mouse.down=false; });

// ---------- leaving -----------------------------------------------------------------------------------
let raf = 0, leaving = false, shown = 0;
const bar = cover.querySelector(".cover-enter .bar i");
function leave(){
  if (leaving) return; leaving = true;
  cover.classList.add("leaving");
  setTimeout(teardown, FADE_MS);
}
function teardown(){
  cancelAnimationFrame(raf);
  for (const off of offs) off();
  const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
  cover.remove(); root.classList.remove("cover-on");
}
function bail(){ cover.remove(); root.classList.remove("cover-on"); }
on(cover.querySelector(".cover-enter"), "click", leave);
on(window, "wheel", leave, {passive:true});
on(window, "keydown", e => { if (["Escape","Enter"," ","ArrowDown","PageDown","End"].includes(e.key) && !e.target.closest?.(".topbar a")) { e.preventDefault(); leave(); } });
for (const a of document.querySelectorAll(".topbar a")) {
  const home = /(^|\/)index\.html$|\/$/.test(new URL(a.href, location.href).pathname);
  if (home) on(a, "click", e => { e.preventDefault(); leave(); });
}
on(window, "resize", onResize);

// ---------- loop ----------------------------------------------------------------------------------------
rebuild();
let last = performance.now(), stepDebt = 0;
function frame(now){
  const dtms = Math.min(now - last, 100); last = now;
  // the countdown runs only while the page is visible and nobody is dragging through the dish
  if (!document.hidden && !mouse.down && !leaving) shown += dtms;
  if (bar) bar.style.transform = `scaleX(${Math.min(1, shown/SHOW_MS)})`;
  if (shown >= SHOW_MS) leave();
  mouse.amt += ((mouse.on?1:0) - mouse.amt) * Math.min(1, dtms/250);
  gl.useProgram(pSim); gl.viewport(0,0,simW,simH);
  const c = toSim(mouse.x, mouse.y);
  stepDebt += dtms * STEPS_PER_S / 1000;
  const n = Math.floor(stepDebt); stepDebt -= n;
  for (let s=0; s<n; s++) {
    const ev = {};
    if (mouse.on && !mouse.down) { ev.cur = c; ev.cur0 = (s===0 && prevC) ? prevC : c; }
    if (s===0 && pulseAt) ev.pulse = pulseAt;
    if (stirs.length) ev.stir = stirs.shift();
    step(ev);
  }
  pulseAt = null; prevC = (mouse.on && !mouse.down) ? c : null;
  gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,W,H);
  gl.useProgram(pShow);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,tex[cur]);
  gl.uniform1i(uShow.tex,0); gl.uniform2f(uShow.res,W,H); gl.uniform1f(uShow.dpr,dpr);
  gl.uniform2f(uShow.mouse,mouse.x,mouse.y); gl.uniform1f(uShow.mAmt,mouse.amt);
  gl.uniform1f(uShow.feather,90); gl.uniform1f(uShow.time,(now%1000)/1000);
  gl.uniform4fv(uShow.rects,rects);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  raf = requestAnimationFrame(frame);
}
raf = requestAnimationFrame(frame);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureRects);
})();
