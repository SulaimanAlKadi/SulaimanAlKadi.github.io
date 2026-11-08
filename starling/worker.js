/* Web worker that hosts the Starling Python engine so the page stays responsive. */
importScripts('starling_src.js', 'engine.js');

var enginePromise = createStarlingEngine(function (msg) { postMessage({ type: 'progress', msg: msg }); });
enginePromise.then(function () { postMessage({ type: 'ready' }); })
  .catch(function (e) { postMessage({ type: 'fatal', msg: String(e && e.message || e) }); });

onmessage = async function (ev) {
  var m = ev.data;
  try {
    var eng = await enginePromise;
    var out = eng.call(m.route, m.body);
    postMessage({ type: 'result', id: m.id, ok: true, result: out });
  } catch (e) {
    postMessage({ type: 'result', id: m.id, ok: false, error: String(e && e.message || e) });
  }
};
