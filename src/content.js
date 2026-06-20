// Content script (isolated world). Injects the page-context network interceptor,
// receives Lark Base record/schema payloads, decompresses + analyzes them via
// LarkCore, and AUTO-RENDERS a report panel on the page. No manual export needed.
(function () {
  "use strict";

  // The page-context interceptor (src/interceptor.js) is injected by the manifest
  // as a MAIN-world content script; it forwards captures here via postMessage.

  var state = { fieldMap: null, userMap: null, recordMap: null, order: null, total: 0 };
  var recordsReq = null; // { url, headers } captured from the page, for paginated replay
  var lastAnalysis = null;
  var lastHandover = null;
  var lastDataset = null;
  var handoverRange = null; // null = current-quarter default; set by the From/To pickers
  var loadingAll = false;
  var panelOpenedOnce = false;
  var computeTimer = null;
  var filterText = "";
  var ui = null; // { host, shadow, summary, fields, meta, fab }

  // ---- receive captured payloads ----
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.source !== "lark-analytics-interceptor") return;
    if (d.type === "request") { recordsReq = { url: String(d.url || ""), headers: d.headers || {} }; return; }
    if (d.type !== "capture") return;
    var json;
    try { json = JSON.parse(d.body); } catch (e) { return; }
    onCapture(String(d.url || ""), json);
  });

  function onCapture(url, json) {
    if (!window.LarkCore) return;
    if (/clientvars/.test(url)) {
      LarkCore.extractClientvars(json).then(function (cv) {
        if (!cv) return;
        if (cv.fieldMap) state.fieldMap = cv.fieldMap;
        if (cv.userMap) state.userMap = cv.userMap;
        if (cv.timeZone) state.timeZone = cv.timeZone;
        if (cv.recordMap && !state.recordMap) { state.recordMap = cv.recordMap; state.order = cv.order; }
        scheduleCompute();
      }).catch(function () {});
    } else if (/\/records(\?|$)/.test(url)) {
      LarkCore.extractRecords(json).then(function (rc) {
        if (rc && rc.recordMap) { mergeRecords(rc); scheduleCompute(); }
      }).catch(function () {});
    }
  }

  // Accumulate record batches as the page loads more (don't overwrite).
  function mergeRecords(rc) {
    state.recordMap = state.recordMap || {};
    state.order = state.order || [];
    var seen = {};
    state.order.forEach(function (id) { seen[id] = 1; });
    Object.keys(rc.recordMap).forEach(function (id) {
      state.recordMap[id] = rc.recordMap[id];
      if (!seen[id]) { state.order.push(id); seen[id] = 1; }
    });
    if (rc.total) state.total = rc.total;
  }

  function scheduleCompute() {
    if (computeTimer) clearTimeout(computeTimer);
    computeTimer = setTimeout(compute, 400);
  }

  function compute() {
    if (!state.recordMap || !window.LarkCore) return;
    var dataset;
    try { dataset = LarkCore.buildDataset(state); } catch (e) { return; }
    if (!dataset.order.length) return;
    lastDataset = dataset;
    lastAnalysis = LarkCore.buildAnalysis(dataset, location.href);
    lastHandover = LarkCore.buildHandover(dataset, { timeZone: state.timeZone, range: handoverRange }); // null unless work-log table
    try { if (lastHandover) console.log("[Lark Analytics] handover diagnosis:", JSON.stringify(LarkCore.diagnoseHandover(dataset, { timeZone: state.timeZone, range: handoverRange }), null, 2)); } catch (e) {}
    try {
      chrome.storage.local.set({ larkAnalysis: lastAnalysis, larkHandover: lastHandover, larkUrl: location.href, larkAt: Date.now() });
    } catch (e) {}
    renderPanel();
  }

  // ---- fetch ALL rows by replaying the records API with pagination ----
  var FORBIDDEN_HEADERS = { host: 1, "content-length": 1, "accept-encoding": 1, "user-agent": 1, referer: 1, origin: 1, cookie: 1, connection: 1, accept: 1 };
  function safeHeaders(h) {
    var out = {};
    Object.keys(h || {}).forEach(function (k) {
      var lk = k.toLowerCase();
      if (lk.charAt(0) === ":" || FORBIDDEN_HEADERS[lk] || lk.indexOf("sec-") === 0) return;
      out[k] = h[k];
    });
    return out;
  }

  function loadAllRecords() {
    if (loadingAll || !recordsReq || !window.LarkCore) return;
    loadingAll = true;
    setPanelStatus("Loading all rows…");
    var headers = safeHeaders(recordsReq.headers);
    var limit = 3000;
    var merged = {}, order = [], seen = {};

    function fetchPage(offset, total) {
      if (offset >= total) return Promise.resolve();
      var u = new URL(recordsReq.url, location.origin);
      u.searchParams.set("offset", String(offset));
      u.searchParams.set("limit", String(limit));
      u.searchParams.set("viewLazyLoad", "true");
      return fetch(u.toString(), { credentials: "include", headers: headers })
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (json) { return LarkCore.extractRecords(json); })
        .then(function (rc) {
          if (!rc || !rc.recordMap) return;
          var ids = Object.keys(rc.recordMap);
          if (!ids.length) return;
          ids.forEach(function (id) { merged[id] = rc.recordMap[id]; if (!seen[id]) { order.push(id); seen[id] = 1; } });
          var newTotal = rc.total || total;
          setPanelStatus("Loaded " + order.length + (newTotal < Infinity ? " / " + newTotal : "") + " rows…");
          if (ids.length < limit) return;            // last page
          return fetchPage(offset + limit, newTotal);
        });
    }

    fetchPage(0, state.total || Infinity).then(function () {
      if (order.length) { state.recordMap = merged; state.order = order; compute(); }
      setPanelStatus("");
      loadingAll = false;
    }).catch(function (e) {
      setPanelStatus("Couldn't auto-load all rows (" + e.message + "). Try scrolling the table instead.");
      loadingAll = false;
    });
  }

  function setPanelStatus(text) { if (ui && ui.status) ui.status.textContent = text || ""; }

  // Recompute the handover pivot for the current handoverRange and re-render.
  // Only re-render if the on-page panel already exists — a popup-driven range
  // change shouldn't pop the panel open on the page.
  function recomputeHandover() {
    if (!lastDataset || !window.LarkCore) return;
    lastHandover = LarkCore.buildHandover(lastDataset, { timeZone: state.timeZone, range: handoverRange });
    try { chrome.storage.local.set({ larkHandover: lastHandover }); } catch (e) {}
    if (ui) renderPanel();
  }

  // ---- popup messaging ----
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg) return;
    if (msg.type === "GET_ANALYSIS") sendResponse({ analysis: lastAnalysis, handover: lastHandover, url: location.href });
    else if (msg.type === "SET_HANDOVER_RANGE") { handoverRange = msg.range || null; recomputeHandover(); sendResponse({ handover: lastHandover }); }
    else if (msg.type === "OPEN_PANEL") { ensureUI(); openPanel(); sendResponse({ ok: !!lastAnalysis }); }
    else if (msg.type === "CLEAR") {
      lastAnalysis = null; state = { fieldMap: null, userMap: null, recordMap: null, order: null };
      try { chrome.storage.local.remove("larkAnalysis"); } catch (e) {}
      if (ui) { ui.summary.innerHTML = ""; ui.fields.innerHTML = ""; ui.meta.textContent = "cleared"; }
      sendResponse({ ok: true });
    }
    return true;
  });

  // ---------- on-page panel (Shadow DOM, isolated from page styles/CSP) ----------

  var STYLE =
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}" +
    ".fab{position:fixed;right:18px;bottom:18px;z-index:2147483646;background:#3370ff;color:#fff;border:none;border-radius:24px;height:44px;padding:0 16px;font-size:13px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}" +
    ".panel{position:fixed;top:0;right:0;height:100vh;width:440px;max-width:96vw;background:#fff;color:#1f2329;z-index:2147483647;box-shadow:-4px 0 24px rgba(0,0,0,.18);transform:translateX(100%);transition:transform .22s ease;display:flex;flex-direction:column;font-size:13px}" +
    ".panel.open{transform:none}" +
    ".panel.wide{width:min(1180px,97vw)}.panel.wide .pivotwrap{max-height:74vh}" +
    ".hd{padding:12px 14px;border-bottom:1px solid #e5e6eb}" +
    ".hd h2{margin:0 0 6px;font-size:15px;display:flex;justify-content:space-between;align-items:center}" +
    ".x{background:none;border:none;font-size:20px;cursor:pointer;color:#646a73;line-height:1}" +
    ".meta{color:#646a73;font-size:11px;margin-bottom:8px}" +
    ".row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}" +
    ".btn{border:1px solid #e5e6eb;background:#f2f3f5;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer}" +
    ".btn:hover{border-color:#3370ff}" +
    "input.filter{flex:1;min-width:120px;border:1px solid #e5e6eb;border-radius:6px;padding:5px 8px;font-size:12px}" +
    ".body{overflow-y:auto;padding:10px 14px;flex:1}" +
    ".summary{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}" +
    ".stat{background:#f2f3f5;border-radius:6px;padding:6px 10px;min-width:70px}.stat .n{font-size:16px;font-weight:600}.stat .l{font-size:11px;color:#646a73}" +
    ".field{border:1px solid #e5e6eb;border-radius:8px;padding:10px;margin-bottom:8px}" +
    ".field h3{margin:0 0 2px;font-size:13px;display:flex;justify-content:space-between;gap:8px}.ftype{font-size:11px;color:#646a73;font-weight:400}" +
    ".kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin-top:6px}.kv .k{color:#646a73}.kv .v{text-align:right;font-variant-numeric:tabular-nums}" +
    "table.freq{width:100%;border-collapse:collapse;margin-top:6px}table.freq td{padding:2px 4px;border-top:1px solid #eee}table.freq td.c{text-align:right;color:#646a73}.bar{width:40%}.barfill{height:8px;background:#3370ff;border-radius:4px}" +
    ".empty{color:#646a73}" +
    ".sec-title{font-size:13px;font-weight:600;margin:6px 0}" +
    ".rangebar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.rangebar:empty{display:none}" +
    ".rangebar label{display:flex;gap:4px;align-items:center;color:#646a73}.rangebar .rangebar-label{font-weight:600;color:#1f2329}.rangebar .arrow{color:#646a73}" +
    "input.month{border:1px solid #e5e6eb;border-radius:6px;padding:4px 6px;font-size:12px;color:#1f2329}" +
    ".pivotwrap{overflow:auto;max-height:46vh;border:1px solid #e5e6eb;border-radius:8px;margin-bottom:10px}" +
    "table.pivot{border-collapse:collapse;font-size:12px;white-space:nowrap}table.pivot th,table.pivot td{padding:4px 8px;border:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums}" +
    "table.pivot th{position:sticky;top:0;background:#f7f8fa;font-weight:600}table.pivot td.d,table.pivot th.d{position:sticky;left:0;background:#fff;text-align:left;font-weight:500}table.pivot tr.tot td{background:#eef3ff;font-weight:600}table.pivot th.d{z-index:1;background:#f7f8fa}" +
    "hr{border:none;border-top:1px solid #e5e6eb;margin:12px 0}";

  function ensureUI() {
    if (ui) return ui;
    var host = document.createElement("div");
    host.id = "lark-analytics-host";
    var shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      "<style>" + STYLE + "</style>" +
      '<button class="fab" id="fab">📊 Base Report</button>' +
      '<div class="panel" id="panel">' +
      '  <div class="hd">' +
      '    <h2>Lark Base Analytics <button class="x" id="close">×</button></h2>' +
      '    <div class="meta" id="meta">Waiting for data…</div>' +
      '    <div class="row">' +
      '      <input class="filter" id="filter" placeholder="Filter columns by name…" />' +
      '      <button class="btn" id="loadAll">⬇ Load all rows</button>' +
      '      <button class="btn" id="expand">⛶ Expand</button>' +
      '      <button class="btn" id="expHtml">HTML</button>' +
      '      <button class="btn" id="expCsv">CSV</button>' +
      '      <button class="btn" id="expRaw">Raw CSV</button>' +
      "    </div>" +
      '    <div class="meta" id="status"></div>' +
      '    <div class="summary" id="summary"></div>' +
      "  </div>" +
      '  <div class="body"><div id="rangeBar" class="rangebar"></div><div id="handover"></div><div id="fields"></div></div>' +
      "</div>";
    (document.body || document.documentElement).appendChild(host);

    ui = {
      host: host, shadow: shadow,
      panel: shadow.getElementById("panel"),
      fab: shadow.getElementById("fab"),
      summary: shadow.getElementById("summary"),
      rangeBar: shadow.getElementById("rangeBar"),
      handover: shadow.getElementById("handover"),
      fields: shadow.getElementById("fields"),
      meta: shadow.getElementById("meta"),
      status: shadow.getElementById("status")
    };
    shadow.getElementById("loadAll").addEventListener("click", loadAllRecords);
    shadow.getElementById("expand").addEventListener("click", function () { ui.panel.classList.toggle("wide"); });
    ui.fab.addEventListener("click", openPanel);
    shadow.getElementById("close").addEventListener("click", closePanel);
    shadow.getElementById("filter").addEventListener("input", function (e) {
      filterText = e.target.value;
      if (lastAnalysis) ui.fields.innerHTML = LarkCore.renderFields(lastAnalysis, filterText);
    });
    shadow.getElementById("expHtml").addEventListener("click", function () {
      if (lastAnalysis) download("lark-base-report-" + stamp() + ".html", LarkCore.buildReportHTML(lastAnalysis), "text/html");
    });
    shadow.getElementById("expCsv").addEventListener("click", function () {
      if (lastAnalysis) download("lark-base-report-" + stamp() + ".csv", LarkCore.buildReportCSV(lastAnalysis), "text/csv");
    });
    shadow.getElementById("expRaw").addEventListener("click", function () {
      if (lastDataset) download("lark-base-rawdata-" + stamp() + ".csv", LarkCore.buildRawCSV(lastDataset), "text/csv");
    });
    return ui;
  }

  function openPanel() { ensureUI(); ui.panel.classList.add("open"); ui.fab.style.display = "none"; }
  function closePanel() { if (ui) { ui.panel.classList.remove("open"); ui.fab.style.display = ""; } }

  function renderPanel() {
    ensureUI();
    ui.meta.textContent = lastAnalysis.rowCount.toLocaleString() + " rows × " + lastAnalysis.columns.length +
      " columns · auto-generated " + new Date().toLocaleTimeString();
    ui.summary.innerHTML = LarkCore.renderSummary(lastAnalysis);

    if (lastHandover) {
      ui.rangeBar.innerHTML = LarkCore.renderRangeControls(lastHandover.range);
      var fromEl = ui.shadow.getElementById("hvFrom"), toEl = ui.shadow.getElementById("hvTo");
      function applyRange() {
        handoverRange = LarkCore.parseRangeControls(fromEl.value, toEl.value); // null -> default quarter
        recomputeHandover();
      }
      if (fromEl) fromEl.addEventListener("change", applyRange);
      if (toEl) toEl.addEventListener("change", applyRange);
      var rs = ui.shadow.getElementById("hvReset");
      if (rs) rs.addEventListener("click", function () { handoverRange = null; recomputeHandover(); });

      ui.handover.innerHTML =
        '<div class="sec-title">Translator productivity · ' + lastHandover.window +
        ' <span style="float:right">' +
        '<button class="btn" id="copyPivot">📋 Copy for sheet</button> ' +
        '<button class="btn" id="expPivot">CSV</button></span></div>' +
        '<div class="pivotwrap">' + LarkCore.renderHandover(lastHandover) + "</div>" +
        '<hr><div class="sec-title">All columns</div>';
      var cp = ui.shadow.getElementById("copyPivot");
      if (cp) cp.addEventListener("click", function () { copyText(LarkCore.buildHandoverTSV(lastHandover), cp); });
      var bp = ui.shadow.getElementById("expPivot");
      if (bp) bp.addEventListener("click", function () {
        download("handover-pivot-" + stamp() + ".csv", LarkCore.buildHandoverCSV(lastHandover), "text/csv");
      });
    } else {
      ui.rangeBar.innerHTML = "";
      ui.handover.innerHTML = "";
    }

    ui.fields.innerHTML = LarkCore.renderFields(lastAnalysis, filterText);
    if (!panelOpenedOnce) { panelOpenedOnce = true; openPanel(); }
  }

  function download(name, content, mime) {
    var url = URL.createObjectURL(new Blob([content], { type: mime }));
    var a = document.createElement("a");
    a.href = url; a.download = name;
    (document.body || document.documentElement).appendChild(a);
    a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); }

  // Copy text to clipboard (tab-separated grid for pasting into a sheet).
  function copyText(text, btn) {
    var original = btn ? btn.textContent : "";
    function done(ok) { if (btn) { btn.textContent = ok ? "✓ Copied!" : "Copy failed"; setTimeout(function () { btn.textContent = original; }, 1600); } }
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
        (document.body || document.documentElement).appendChild(ta);
        ta.focus(); ta.select();
        var ok = document.execCommand("copy");
        ta.remove(); done(ok);
      } catch (e) { done(false); }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
      } else { fallback(); }
    } catch (e) { fallback(); }
  }
})();
