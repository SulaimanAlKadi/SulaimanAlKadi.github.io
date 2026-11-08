/* Starling in the browser.
   Loads Pyodide (CPython compiled to WebAssembly) plus NumPy and SciPy from the
   Pyodide CDN, installs the starling package from the embedded source archive
   and exposes the same JSON endpoints the local Python server provides, so the
   interface in app.js runs unchanged. Shared by worker.js (normal case) and by
   the main-thread fallback in bridge.js (when workers are unavailable). */
(function (root) {
  'use strict';
  var PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';

  var GLUE = [
    'import json, base64, traceback',
    'from starling.server import Session, _jsonable',
    '_session = Session()',
    'def dispatch(route, payload_json):',
    '    s = _session',
    '    try:',
    '        payload = json.loads(payload_json or "{}")',
    '        if route == "/api/load":',
    '            out = {"datasets": s.load(payload.get("files", []), payload.get("delay_unit"))}',
    '        elif route == "/api/fit":',
    '            out = s.fit_kinetics(payload["id"], payload.get("options", {}))',
    '        elif route == "/api/process":',
    '            out = s.process(payload["id"], payload.get("options", {}))',
    '        elif route == "/api/shared":',
    '            out = s.shared(payload.get("ids", []), payload.get("options", {}))',
    '        elif route == "/api/export":',
    '            name, ctype, data = s.export(payload["id"], payload.get("kind", "csv"))',
    '            out = {"name": name, "ctype": ctype, "b64": base64.b64encode(data).decode()}',
    '        elif route == "/api/coherence":',
    '            out = s.coherence(payload["id"], payload.get("options", {}))',
    '        elif route == "/api/posterior":',
    '            out = s.posterior(payload["id"], payload.get("options", {}))',
    '        elif route == "/api/annihilation":',
    '            out = s.annihilation(payload.get("ids", []), payload.get("options", {}))',
    '        elif route == "/api/fluence":',
    '            out = s.fluence(payload.get("options", {}))',
    '        elif route == "/api/state":',
    '            out = {"datasets": s.state()}',
    '        elif route == "/api/demo":',
    '            out = {"datasets": s.demo(int(payload.get("n", 3)))}',
    '        elif route == "/api/clear":',
    '            s.datasets.clear(); out = {"ok": True}',
    '        else:',
    '            out = {"error": "no such endpoint"}',
    '        return json.dumps(out, default=_jsonable)',
    '    except Exception as exc:',
    '        return json.dumps({"error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc(limit=4)})',
  ].join('\n');

  function b64bytes(b64) {
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  async function createEngine(progress) {
    progress = progress || function () {};
    if (typeof root.loadPyodide === 'undefined') {
      progress('Loading the Python runtime');
      if (typeof importScripts === 'function') {
        importScripts(PYODIDE + 'pyodide.js');
      } else {
        await new Promise(function (res, rej) {
          var s = document.createElement('script'); s.src = PYODIDE + 'pyodide.js';
          s.onload = res; s.onerror = function () { rej(new Error('could not load Pyodide from the CDN')); };
          document.head.appendChild(s);
        });
      }
    }
    progress('Starting Python');
    var py = await root.loadPyodide({ indexURL: PYODIDE });
    progress('Loading NumPy and SciPy (about 35 MB; your browser caches them after the first visit)');
    await py.loadPackage(['numpy', 'scipy']);
    progress('Installing Starling');
    if (!root.STARLING_SRC_B64) throw new Error('starling_src.js did not load');
    py.unpackArchive(b64bytes(root.STARLING_SRC_B64).buffer, 'zip');
    py.runPython(GLUE);
    var dispatch = py.globals.get('dispatch');
    progress('Ready');
    return {
      call: function (route, body) {
        var s = dispatch(route, JSON.stringify(body || {}));
        return JSON.parse(s);
      }
    };
  }

  root.createStarlingEngine = createEngine;
})(typeof self !== 'undefined' ? self : window);
