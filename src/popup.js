// Popup: a thin viewer over LarkCore. It reads the analysis the content script
// already computed (auto-generated when you open a Lark Base), renders it, and
// can export the report. Data extraction + analytics all live in lark-core.js.
"use strict";

var els = {
  openPanel: document.getElementById("openPanel"),
  refresh: document.getElementById("refresh"),
  exportHtml: document.getElementById("exportHtml"),
  exportCsv: document.getElementById("exportCsv"),
  filter: document.getElementById("filter"),
  status: document.getElementById("status"),
  summary: document.getElementById("summary"),
  rangeBar: document.getElementById("rangeBar"),
  handover: document.getElementById("handover"),
  report: document.getElementById("report")
};

var analysis = null;
var handover = null;
var filterText = "";

init();

function init() {
  els.refresh.addEventListener("click", load);
  els.openPanel.addEventListener("click", openOnPage);
  els.exportHtml.addEventListener("click", function () {
    if (analysis) download("lark-base-report-" + stamp() + ".html", LarkCore.buildReportHTML(analysis), "text/html");
  });
  els.exportCsv.addEventListener("click", function () {
    if (analysis) download("lark-base-report-" + stamp() + ".csv", LarkCore.buildReportCSV(analysis), "text/csv");
  });
  els.filter.addEventListener("input", function (e) {
    filterText = e.target.value;
    if (analysis) els.report.innerHTML = LarkCore.renderFields(analysis, filterText);
  });
  load();
}

function setStatus(msg, isError) {
  els.status.textContent = msg || "";
  els.status.className = "status" + (isError ? " error" : "");
}

function activeTab() {
  return new Promise(function (r) { chrome.tabs.query({ active: true, currentWindow: true }, function (t) { r(t[0]); }); });
}
function sendToTab(id, msg) {
  return new Promise(function (r) {
    try { chrome.tabs.sendMessage(id, msg, function (resp) { r(chrome.runtime.lastError ? null : resp); }); }
    catch (e) { r(null); }
  });
}
function getStored() {
  return new Promise(function (r) { chrome.storage.local.get(["larkAnalysis", "larkHandover", "larkUrl"], function (o) { r(o || {}); }); });
}

async function load() {
  setStatus("Loading report…");
  var tab = await activeTab();
  var url = tab ? tab.url : "";

  if (tab && tab.id != null) {
    var resp = await sendToTab(tab.id, { type: "GET_ANALYSIS" });
    if (resp && resp.analysis) { analysis = resp.analysis; handover = resp.handover || null; url = resp.url || url; }
  }
  if (!analysis) {
    var stored = await getStored();
    if (stored.larkAnalysis) { analysis = stored.larkAnalysis; handover = stored.larkHandover || null; url = stored.larkUrl || url; }
  }

  if (!analysis || !analysis.columns) {
    els.summary.innerHTML = els.report.innerHTML = "";
    els.exportHtml.disabled = els.exportCsv.disabled = true;
    if (url && /\/base\//.test(url)) {
      setStatus("No data captured yet. Reload the Base tab (so capture starts at load), wait for it to render, then click Refresh.", true);
    } else {
      setStatus("Open a Lark Base (URL contains /base/) in the active tab.", true);
    }
    return;
  }

  render();
  setStatus(analysis.rowCount.toLocaleString() + " rows × " + analysis.columns.length + " columns. Generated " + analysis.generatedAt + ".");
}

function render() {
  els.summary.innerHTML = LarkCore.renderSummary(analysis);
  if (handover) {
    els.rangeBar.innerHTML = LarkCore.renderRangeControls(handover.range);
    var fromEl = document.getElementById("hvFrom"), toEl = document.getElementById("hvTo");
    function onRange() { applyRange(LarkCore.parseRangeControls(fromEl.value, toEl.value)); }
    if (fromEl) fromEl.addEventListener("change", onRange);
    if (toEl) toEl.addEventListener("change", onRange);
    var rs = document.getElementById("hvReset");
    if (rs) rs.addEventListener("click", function () { applyRange(null); });

    els.handover.innerHTML =
      '<div class="sec-title">Translator productivity · ' + handover.window +
      ' <span style="float:right"><button class="btn" id="copyPivot">📋 Copy for sheet</button> ' +
      '<button class="btn" id="expPivot">CSV</button></span></div>' +
      '<div class="pivotwrap">' + LarkCore.renderHandover(handover) + "</div>" +
      '<div class="sec-title">All columns</div>';
    var cp = document.getElementById("copyPivot");
    if (cp) cp.addEventListener("click", function () {
      var t = cp.textContent;
      navigator.clipboard.writeText(LarkCore.buildHandoverTSV(handover))
        .then(function () { cp.textContent = "✓ Copied!"; setTimeout(function () { cp.textContent = t; }, 1600); });
    });
    var bp = document.getElementById("expPivot");
    if (bp) bp.addEventListener("click", function () {
      download("handover-pivot-" + stamp() + ".csv", LarkCore.buildHandoverCSV(handover), "text/csv");
    });
  } else {
    els.rangeBar.innerHTML = "";
    els.handover.innerHTML = "";
  }
  els.report.innerHTML = LarkCore.renderFields(analysis, filterText);
  els.exportHtml.disabled = els.exportCsv.disabled = false;
}

// Send the chosen month range to the content script, which recomputes the pivot
// (it holds the raw dataset). null range -> back to the default current quarter.
async function applyRange(range) {
  setStatus("Updating window…");
  var tab = await activeTab();
  var resp = tab && tab.id != null ? await sendToTab(tab.id, { type: "SET_HANDOVER_RANGE", range: range }) : null;
  if (resp && resp.handover) {
    handover = resp.handover;
    render();
    setStatus(analysis.rowCount.toLocaleString() + " rows × " + analysis.columns.length + " columns. Generated " + analysis.generatedAt + ".");
  } else {
    setStatus("Couldn't reach the Base page. Reload the Lark Base tab (so the latest extension loads), then try again.", true);
  }
}

async function openOnPage() {
  var tab = await activeTab();
  if (tab && tab.id != null) await sendToTab(tab.id, { type: "OPEN_PANEL" });
  window.close();
}

function download(name, content, mime) {
  var url = URL.createObjectURL(new Blob([content], { type: mime }));
  var a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}
function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); }
