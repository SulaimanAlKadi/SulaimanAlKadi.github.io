/* Connects app.js to the in-browser Python engine instead of a local server.
   Uses a web worker when the page is served over HTTP; falls back to running
   the engine on the main thread when opened straight from disk. */
(function () {
  'use strict';
  var banner = document.createElement('div');
  banner.id = 'engine-banner';
  banner.style.cssText = 'margin:1rem 0;padding:.6rem .9rem;border:1px solid #d9d9d9;background:#f5f5f5;font-size:.92rem;color:#5f5f5f';
  var main = document.querySelector('main');
  if (main) main.insertBefore(banner, main.firstChild);
  function setBanner(text, state) {
    banner.textContent = text;
    if (state === 'ready') { banner.style.background = '#eef6f0'; banner.style.borderColor = '#bcd9c6'; banner.style.color = '#2e7d55'; }
    if (state === 'bad') { banner.style.background = '#fbeeec'; banner.style.borderColor = '#e4b8b1'; banner.style.color = '#a53c2a'; }
  }
  setBanner('Starting the analysis engine in your browser…');

  var readyResolve, readyReject;
  var ready = new Promise(function (res, rej) { readyResolve = res; readyReject = rej; });
  var mode = null, worker = null, engine = null, pending = {}, nextId = 1;

  function progress(msg) {
    if (msg === 'Ready') setBanner('Analysis engine ready. Everything runs in this tab; nothing is uploaded.', 'ready');
    else setBanner(msg + '…');
  }

  function startWorker() {
    worker = new Worker('worker.js');
    worker.onmessage = function (ev) {
      var m = ev.data;
      if (m.type === 'progress') progress(m.msg);
      else if (m.type === 'ready') { progress('Ready'); readyResolve(); }
      else if (m.type === 'fatal') { setBanner('The analysis engine could not start: ' + m.msg, 'bad'); readyReject(new Error(m.msg)); }
      else if (m.type === 'result') { var p = pending[m.id]; delete pending[m.id]; if (!p) return; if (m.ok) p.res(m.result); else p.rej(new Error(m.error)); }
    };
    worker.onerror = function (e) {
      setBanner('The analysis engine could not start: ' + (e.message || 'worker error'), 'bad');
      readyReject(new Error(e.message || 'worker error'));
    };
    mode = 'worker';
  }
  function startMain() {
    mode = 'main';
    if (typeof createStarlingEngine !== 'function') { setBanner('engine.js did not load', 'bad'); readyReject(new Error('engine.js missing')); return; }
    createStarlingEngine(progress).then(function (eng) { engine = eng; readyResolve(); })
      .catch(function (e) { setBanner('The analysis engine could not start: ' + (e && e.message || e), 'bad'); readyReject(e); });
  }
  var forceMain = /[?&]mode=main/.test(location.search);
  if (location.protocol === 'file:' || forceMain || typeof Worker === 'undefined') startMain();
  else { try { startWorker(); } catch (e) { startMain(); } }

  window.starlingBridge = {
    ready: ready,
    mode: function () { return mode; },
    call: async function (route, body) {
      await ready;
      if (mode === 'worker') {
        return new Promise(function (res, rej) {
          var id = nextId++; pending[id] = { res: res, rej: rej };
          worker.postMessage({ id: id, route: route, body: body || {} });
        });
      }
      return engine.call(route, body || {});
    }
  };

  // self-test: app.html?selftest=1 loads the example series, corrects the first
  // dataset with the page's default options and logs timings into #ss-log
  if (/[?&]selftest=1/.test(location.search)) {
    var log = document.createElement('pre'); log.id = 'ss-log'; log.hidden = true; document.body.appendChild(log);
    var procLine = '';
    var L = function (s) { log.textContent += s + '\n'; if (/^process|^FAILED|^ENGINE/.test(s)) procLine = s.slice(0, 230); document.title = 'ST ' + procLine + ' || ' + s.slice(0, 120); };
    var keep = setInterval(function () {}, 500);
    ready.then(async function () {
      try {
        var t0 = performance.now();
        var d = await window.starlingBridge.call('/api/demo', { n: 3 });
        L('demo ok ' + d.datasets.length + ' datasets ' + (performance.now() - t0).toFixed(0) + ' ms; first=' + JSON.stringify(d.datasets[0]).slice(0, 300));
        var o = (typeof opts === 'function') ? opts() : {};
        var t1 = performance.now();
        var r = await window.starlingBridge.call('/api/process', { id: d.datasets[0].id, options: o });
        L('process ' + (r.error ? 'ERROR ' + r.error + ' ' + (r.trace || '') : 'ok') + ' ' + (performance.now() - t1).toFixed(0) + ' ms; keys=' + Object.keys(r).join(','));
        if (!r.error) L('summary=' + JSON.stringify(r).slice(0, 600));
      } catch (e) { L('FAILED ' + (e && e.message || e)); }
      L('DONE'); clearInterval(keep);
    }, function (e) { L('ENGINE FAILED ' + (e && e.message || e)); L('DONE'); clearInterval(keep); });
  }
})();
