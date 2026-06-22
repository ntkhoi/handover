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
  var autoLoadKey = null;   // records-URL signature already auto-loaded (or loading); re-fires on table/view switch
  var autoLoadTimer = null;
  var panelOpenedOnce = false;
  var computeTimer = null;
  var filterText = "";
  var ui = null; // { host, shadow, summary, fields, meta, fab }

  // ---- receive captured payloads ----
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.source !== "lark-analytics-interceptor") return;
    if (d.type === "request") { recordsReq = { url: String(d.url || ""), headers: d.headers || {} }; scheduleAutoLoadAll(); return; }
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
        // Lark's reported table timezone is intentionally ignored: date bucketing is
        // pinned to UTC+8 in lark-core (BASE_TZ), not the table's zone or the browser's.
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
    lastHandover = LarkCore.buildHandover(dataset, { range: handoverRange }); // null unless work-log table
    try { if (lastHandover) console.log("[Lark Analytics] handover diagnosis:", JSON.stringify(LarkCore.diagnoseHandover(dataset, { range: handoverRange }), null, 2)); } catch (e) {}
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

  // ---- auto-load: by default pull EVERY row, so the pivot is never partial ----
  // Fires once per table/view the moment the records-request template is captured,
  // and again whenever the user switches table/view (the records URL changes).
  function recordsSignature(url) {
    try {
      var u = new URL(url, location.origin);
      ["offset", "limit", "viewLazyLoad"].forEach(function (k) { u.searchParams.delete(k); });
      return u.pathname + "?" + u.searchParams.toString();
    } catch (e) { return String(url || ""); }
  }
  function scheduleAutoLoadAll() {
    if (!recordsReq) return;
    if (recordsSignature(recordsReq.url) === autoLoadKey) return; // this table/view already handled
    if (autoLoadTimer) clearTimeout(autoLoadTimer);
    // Small delay so the page's own initial requests settle and LarkCore is ready.
    autoLoadTimer = setTimeout(function () {
      if (!recordsReq) return;
      var sig = recordsSignature(recordsReq.url);
      if (sig === autoLoadKey) return;
      if (!window.LarkCore || loadingAll) { autoLoadTimer = setTimeout(scheduleAutoLoadAll, 500); return; }
      autoLoadKey = sig;
      loadAllRecords();
    }, 800);
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function loadAllRecords() {
    if (loadingAll || !recordsReq || !window.LarkCore) return Promise.resolve();
    loadingAll = true;
    setPanelStatus("Loading all rows…");
    var headers = safeHeaders(recordsReq.headers);
    var limit = 3000;
    var merged = {}, order = [], seen = {};

    // Fetch one page, retrying a few times so a transient network blip never drops rows.
    function getPage(offset, attempt) {
      var u = new URL(recordsReq.url, location.origin);
      u.searchParams.set("offset", String(offset));
      u.searchParams.set("limit", String(limit));
      u.searchParams.set("viewLazyLoad", "true");
      return fetch(u.toString(), { credentials: "include", headers: headers })
        .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function (json) { return LarkCore.extractRecords(json); })
        .catch(function (e) {
          if ((attempt || 0) >= 3) throw e;
          return wait(500 * ((attempt || 0) + 1)).then(function () { return getPage(offset, (attempt || 0) + 1); });
        });
    }

    // Page until we've collected the table's OWN reported row count (tableRecordNum).
    // Advance by the rows ACTUALLY returned — Lark caps a response below the requested
    // `limit`, so stepping by a fixed `limit` would silently skip every gap.
    function fetchFrom(offset, total, page) {
      if (page > 5000) return total; // backstop against a server that ignores offset
      return getPage(offset, 0).then(function (rc) {
        if (!rc || !rc.recordMap) return total;
        var ids = Object.keys(rc.recordMap);
        if (!ids.length) return total;                 // empty page -> genuinely no more rows
        var added = 0;
        ids.forEach(function (id) {
          merged[id] = rc.recordMap[id];
          if (!seen[id]) { order.push(id); seen[id] = 1; added++; }
        });
        var newTotal = rc.total || total;
        setPanelStatus("Loaded " + order.length + (newTotal < Infinity ? " / " + newTotal : "") + " rows…");
        if (newTotal < Infinity && order.length >= newTotal) return newTotal; // have everything
        if (added === 0) return newTotal;              // no new rows -> stop (server ignored offset)
        return fetchFrom(offset + ids.length, newTotal, page + 1);
      });
    }

    return fetchFrom(0, state.total || Infinity, 0).then(function (total) {
      if (order.length) { state.recordMap = merged; state.order = order; if (total < Infinity) state.total = total; compute(); }
      if (total < Infinity && order.length < total) {
        // Surface incompleteness instead of silently presenting a short pivot.
        setPanelStatus("⚠ Loaded " + order.length + " of " + total + " rows — data may be incomplete. Reload the page and try again.");
      } else {
        setPanelStatus("");
      }
      loadingAll = false;
    }).catch(function (e) {
      autoLoadKey = null; // allow auto-load to retry on the next captured request
      setPanelStatus("Couldn't auto-load all rows (" + e.message + "). Showing rows captured so far.");
      loadingAll = false;
    });
  }

  function setPanelStatus(text) { if (ui && ui.status) ui.status.textContent = text || ""; }

  // Recompute the handover pivot for the current handoverRange and re-render.
  // Only re-render if the on-page panel already exists — a popup-driven range
  // change shouldn't pop the panel open on the page.
  function recomputeHandover() {
    if (!lastDataset || !window.LarkCore) return;
    lastHandover = LarkCore.buildHandover(lastDataset, { range: handoverRange });
    try { chrome.storage.local.set({ larkHandover: lastHandover }); } catch (e) {}
    if (ui) renderPanel();
  }

  // ---- popup messaging ----
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg) return;
    if (msg.type === "GET_ANALYSIS") sendResponse({ analysis: lastAnalysis, handover: lastHandover, url: location.href });
    else if (msg.type === "SET_HANDOVER_RANGE") { handoverRange = msg.range || null; recomputeHandover(); sendResponse({ handover: lastHandover }); }
    else if (msg.type === "OPEN_PANEL") { ensureUI(); openPanel(); sendResponse({ ok: !!lastAnalysis }); }
    else if (msg.type === "OPEN_FULL_PIVOT") { openFullPivot(); sendResponse({ ok: !!lastHandover }); }
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
    ".btn:hover{border-color:#3370ff}.btn.small{padding:3px 8px;font-size:11px}" +
    ".btn.primary{background:#3370ff;color:#fff;border-color:#3370ff}.btn.primary:hover{background:#2860e0}" +
    ".toolbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.toolbar:empty{display:none}" +
    ".legend{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 8px;font-size:11px;color:#646a73}.legend:empty{display:none}.legend .lg{display:inline-flex;align-items:center;gap:4px}.legend i{width:12px;height:12px;border-radius:3px;display:inline-block;border:1px solid rgba(0,0,0,.08)}" +
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
    ".pivotwrap{overflow:auto;max-height:62vh;border:1px solid #e5e6eb;border-radius:8px;margin-bottom:10px}.panel.wide .pivotwrap{max-height:78vh}" +
    "table.pivot{border-collapse:separate;border-spacing:0;font-size:12px;white-space:nowrap}" +
    "table.pivot th,table.pivot td{padding:4px 8px;border-right:1px solid #eef0f2;border-bottom:1px solid #eef0f2;text-align:right;font-variant-numeric:tabular-nums}" +
    "table.pivot thead th{position:sticky;font-weight:600}" +
    "table.pivot tr.grouprow th{top:0;z-index:4;text-align:center;font-weight:700}" +
    "table.pivot tr.stagerow th{top:25px;z-index:3;text-align:center;background:#f7f8fa}" +
    "table.pivot td.d,table.pivot th.d{position:sticky;left:0;text-align:left;font-weight:600;background:#fff}" +
    "table.pivot tr.grouprow th.d{top:0;z-index:6;background:#eef0f2}table.pivot td.d{z-index:2}" +
    "table.pivot tbody td{background:#fff}" +
    "table.pivot tr.tot td{background:#eef3ff;font-weight:700}table.pivot tr.tot td.d{background:#eef3ff}" +
    "table.pivot tr.special td{background:#fff7e6;font-weight:600}table.pivot tr.special td.d{background:#fff7e6}" +
    "hr{border:none;border-top:1px solid #e5e6eb;margin:12px 0}";

  function ensureUI() {
    if (ui) return ui;
    var host = document.createElement("div");
    host.id = "lark-analytics-host";
    var shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      "<style>" + STYLE + "</style>" +
      '<button class="fab" id="fab">📊 Productivity</button>' +
      '<div class="panel" id="panel">' +
      '  <div class="hd">' +
      '    <h2><span id="title">Lark Base Analytics</span> <button class="x" id="close">×</button></h2>' +
      '    <div class="meta" id="meta">Waiting for data…</div>' +
      '    <div class="meta" id="status"></div>' +
      '    <div id="rangeBar" class="rangebar"></div>' +
      '    <div id="toolbar" class="toolbar"></div>' +
      "  </div>" +
      '  <div class="body">' +
      '    <div id="legend" class="legend"></div>' +
      '    <div id="handover"></div>' +
      '    <div id="summary" class="summary"></div>' +
      '    <div id="fields"></div>' +
      "  </div>" +
      "</div>";
    (document.body || document.documentElement).appendChild(host);

    ui = {
      host: host, shadow: shadow,
      panel: shadow.getElementById("panel"),
      fab: shadow.getElementById("fab"),
      title: shadow.getElementById("title"),
      summary: shadow.getElementById("summary"),
      rangeBar: shadow.getElementById("rangeBar"),
      toolbar: shadow.getElementById("toolbar"),
      legend: shadow.getElementById("legend"),
      handover: shadow.getElementById("handover"),
      fields: shadow.getElementById("fields"),
      meta: shadow.getElementById("meta"),
      status: shadow.getElementById("status")
    };
    ui.fab.addEventListener("click", openPanel);
    shadow.getElementById("close").addEventListener("click", closePanel);

    // Delegated handlers — the toolbar/pivot are re-rendered on each compute, so we
    // listen on the stable panel element and dispatch by data-act / control id.
    ui.panel.addEventListener("click", function (e) {
      var t = e.target;
      var act = t && t.getAttribute && t.getAttribute("data-act");
      if (t && t.id === "hvReset") { handoverRange = null; recomputeHandover(); return; }
      if (!act) return;
      if (act === "loadAll") loadAllRecords();
      else if (act === "expand") ui.panel.classList.toggle("wide");
      else if (act === "openFull") openFullPivot();
      else if (act === "excel") { if (lastHandover) downloadBlob("handover-pivot-" + stamp() + ".xlsx", LarkCore.buildHandoverXLSX(lastHandover)); }
      else if (act === "csv") { if (lastHandover) download("handover-pivot-" + stamp() + ".csv", LarkCore.buildHandoverCSV(lastHandover), "text/csv"); }
      else if (act === "copy") { if (lastHandover) copyText(LarkCore.buildHandoverTSV(lastHandover), t); }
      else if (act === "repHtml") { if (lastAnalysis) download("lark-base-report-" + stamp() + ".html", LarkCore.buildReportHTML(lastAnalysis), "text/html"); }
      else if (act === "repCsv") { if (lastAnalysis) download("lark-base-report-" + stamp() + ".csv", LarkCore.buildReportCSV(lastAnalysis), "text/csv"); }
      else if (act === "rawCsv") { if (lastDataset) download("lark-base-rawdata-" + stamp() + ".csv", LarkCore.buildRawCSV(lastDataset), "text/csv"); }
    });
    ui.panel.addEventListener("change", function (e) {
      if (e.target.id === "hvFrom" || e.target.id === "hvTo") {
        var f = shadow.getElementById("hvFrom"), to = shadow.getElementById("hvTo");
        handoverRange = LarkCore.parseRangeControls(f && f.value, to && to.value); // null -> default quarter
        recomputeHandover();
      }
    });
    ui.panel.addEventListener("input", function (e) {
      if (e.target.id === "filter") {
        filterText = e.target.value;
        if (lastAnalysis) ui.fields.innerHTML = LarkCore.renderFields(lastAnalysis, filterText);
      }
    });
    return ui;
  }

  function openPanel() { ensureUI(); ui.panel.classList.add("open"); ui.fab.style.display = "none"; }
  function closePanel() { if (ui) { ui.panel.classList.remove("open"); ui.fab.style.display = ""; } }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function legendHTML(h) {
    if (!h || !h.persons || !h.persons.length) return "";
    return h.persons.map(function (p, i) {
      return '<span class="lg"><i style="background:#' + LarkCore.personColor(i).head + '"></i>' + escHtml(p) + "</span>";
    }).join("");
  }

  function renderPanel() {
    ensureUI();
    if (lastHandover) {
      // Pivot-focused view: the Productivity window is the whole point of the panel.
      ui.title.textContent = "Translator Productivity";
      ui.meta.textContent = lastHandover.rowCount.toLocaleString() + " rows loaded · " + lastHandover.window +
        (lastHandover.timeZone ? " · " + lastHandover.timeZone : "") + " · auto-generated " + new Date().toLocaleTimeString();
      ui.rangeBar.innerHTML = LarkCore.renderRangeControls(lastHandover.range);
      ui.toolbar.innerHTML =
        '<button class="btn" data-act="loadAll">⬇ Load all rows</button>' +
        '<button class="btn primary" data-act="openFull">⛶ Open full view</button>' +
        '<button class="btn" data-act="excel">⬇ Excel</button>' +
        '<button class="btn" data-act="csv">CSV</button>' +
        '<button class="btn" data-act="copy">📋 Copy</button>' +
        '<button class="btn" data-act="expand">↔ Wide</button>';
      ui.legend.innerHTML = legendHTML(lastHandover);
      ui.handover.innerHTML = '<div class="pivotwrap">' + LarkCore.renderHandover(lastHandover) + "</div>";
      ui.summary.innerHTML = "";
      ui.fields.innerHTML = "";
    } else {
      // Fallback (non-work-log tables): keep the generic per-column analytics.
      ui.title.textContent = "Lark Base Analytics";
      ui.meta.textContent = lastAnalysis.rowCount.toLocaleString() + " rows × " + lastAnalysis.columns.length +
        " columns · auto-generated " + new Date().toLocaleTimeString();
      ui.rangeBar.innerHTML = "";
      ui.legend.innerHTML = "";
      ui.handover.innerHTML = "";
      ui.toolbar.innerHTML =
        '<input class="filter" id="filter" placeholder="Filter columns by name…" />' +
        '<button class="btn" data-act="loadAll">⬇ Load all rows</button>' +
        '<button class="btn" data-act="expand">↔ Wide</button>' +
        '<button class="btn" data-act="repHtml">HTML</button>' +
        '<button class="btn" data-act="repCsv">CSV</button>' +
        '<button class="btn" data-act="rawCsv">Raw CSV</button>';
      var fEl = ui.shadow.getElementById("filter");
      if (fEl) fEl.value = filterText;
      ui.summary.innerHTML = LarkCore.renderSummary(lastAnalysis);
      ui.fields.innerHTML = LarkCore.renderFields(lastAnalysis, filterText);
    }
    if (!panelOpenedOnce) { panelOpenedOnce = true; openPanel(); }
  }

  // Open the full, colored pivot in a new browser tab — easier to review than the
  // narrow panel. The page embeds Excel/CSV download links so it's self-contained.
  function openFullPivot() {
    if (!lastHandover || !window.LarkCore) return;
    setPanelStatus("Building full view…");
    var xlsxBlob = LarkCore.buildHandoverXLSX(lastHandover);
    blobToBase64(xlsxBlob).then(function (xb) {
      var csvB64 = utf8ToBase64(LarkCore.buildHandoverCSV(lastHandover));
      var html = LarkCore.buildHandoverHTML(lastHandover, {
        xlsxBase64: xb, csvBase64: csvB64, rowCount: lastHandover.rowCount,
        generatedAt: new Date().toLocaleString(), fileBase: "handover-pivot-" + stamp()
      });
      var url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      var w = window.open(url, "_blank");
      setPanelStatus(w ? "" : "Pop-up blocked — allow pop-ups for this site to open the full view.");
      setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
    }).catch(function (e) { setPanelStatus("Couldn't build full view (" + e.message + ")."); });
  }

  function download(name, content, mime) { downloadBlob(name, new Blob([content], { type: mime })); }
  function downloadBlob(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    (document.body || document.documentElement).appendChild(a);
    a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function blobToBase64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(",")[1] || ""); };
      r.onerror = function () { rej(new Error("read failed")); };
      r.readAsDataURL(blob);
    });
  }
  function utf8ToBase64(str) { return btoa(unescape(encodeURIComponent(str))); }
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
