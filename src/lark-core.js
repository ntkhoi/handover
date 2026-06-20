// Shared engine used by BOTH the content script (on-page panel) and the popup.
// Knows the Lark Base wire format (gzip+base64 payloads, fieldMap, recordMap),
// resolves cell values to readable text, and computes/render summary analytics.
(function (root) {
  "use strict";

  // Lark Base field type id -> coarse analytics category. Types left out
  // (e.g. 19 lookup, 20 formula) are inferred from their actual values.
  var FIELD_TYPE = {
    1: "text", 2: "number", 3: "category", 4: "category", 5: "date",
    7: "checkbox", 11: "user", 13: "text", 15: "link", 17: "attachment",
    18: "link", 21: "link", 22: "text", 23: "user",
    1001: "date", 1002: "date", 1003: "user", 1004: "user", 1005: "number"
  };

  // ---------- decompression ----------

  // Lark sends big payloads as base64(gzip(json)). Decode with the built-in
  // DecompressionStream (available in content scripts and extension pages).
  function gunzipBase64(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }

  function recordIdOrder(container) {
    var order = [];
    if (container && container.groupList) {
      container.groupList.forEach(function (g) {
        if (g && g.recordIDList) order = order.concat(g.recordIDList);
      });
    }
    return order;
  }

  // Parse the .../records response -> { recordMap, order }.
  function extractRecords(json) {
    var data = json && json.data;
    if (!data) return Promise.resolve(null);
    if (typeof data.records === "string") {
      return gunzipBase64(data.records).then(function (txt) {
        var obj = JSON.parse(txt);
        return obj.recordMap ? { recordMap: obj.recordMap, order: recordIdOrder(obj), total: obj.tableRecordNum } : null;
      });
    }
    if (data.recordMap) return Promise.resolve({ recordMap: data.recordMap, order: recordIdOrder(data), total: data.tableRecordNum });
    return Promise.resolve(null);
  }

  // Parse the .../clientvars response -> { fieldMap, userMap, recordMap?, order? }.
  function extractClientvars(json) {
    var data = json && json.data;
    if (!data) return Promise.resolve(null);
    var tz = data.timeZone;
    var done = function (tbl) {
      if (!tbl || !tbl.fieldMap) return null;
      return { fieldMap: tbl.fieldMap, userMap: tbl.userMap, recordMap: tbl.recordMap, order: recordIdOrder(tbl), timeZone: tz };
    };
    if (typeof data.table === "string") return gunzipBase64(data.table).then(function (t) { return done(JSON.parse(t)); });
    if (data.fieldMap) return Promise.resolve(done(data));
    if (data.table && data.table.fieldMap) return Promise.resolve(done(data.table));
    return Promise.resolve(null);
  }

  // ---------- cell resolution ----------

  function segText(v) {
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return v.map(segText).join("");
    if (typeof v === "object") {
      if (v.text != null) return String(v.text);
      if (v.name != null) return String(v.name);
      if (v.number != null) return String(v.number);
      if (v.link != null) return String(v.link);
      return JSON.stringify(v);
    }
    return String(v);
  }

  // Turn a raw cell value into something the analytics layer understands:
  // strings for categories/text/users, numbers for number/date fields.
  // optMap is a base-wide option-id -> label map (handles "dynamic" selects
  // whose option pool is shared from another field).
  function resolveCell(value, field, optMap) {
    if (value == null) return null;
    var t = field ? field.type : undefined;
    var opts = field && field.property && field.property.options;
    function optName(id) {
      if (opts) for (var i = 0; i < opts.length; i++) if (opts[i].id === id && opts[i].name) return opts[i].name;
      if (optMap && optMap[id]) return optMap[id];
      return id; // orphaned option (label not present in captured schema)
    }
    switch (t) {
      case 3: // single select
        return (Array.isArray(value) ? value.map(optName) : [optName(value)]).join(", ");
      case 4: // multiple select
        return (Array.isArray(value) ? value : [value]).map(optName).join(", ");
      case 5: case 1001: case 1002: // datetime (ms)
        return typeof value === "number" ? value : (Array.isArray(value) ? value[0] : value);
      case 7: // checkbox
        return value === true || value === 1;
      case 2: // number
        return typeof value === "number" ? value : (segText(value) || null);
      case 11: case 23: case 1003: case 1004: { // user / chat
        var arr = value.users || (Array.isArray(value) ? value : [value]);
        return arr.map(function (u) { return u && (u.name || u.enName || u.userId) || ""; }).filter(Boolean).join(", ");
      }
      case 1005: // auto number
        if (Array.isArray(value)) return value.map(function (v) { return v.number || v.sequence || ""; }).join("");
        return String(value);
      default: // text(1), url(15), link(18), lookup(19), formula(20), etc.
        return segText(value);
    }
  }

  // Build a uniform dataset { fields:[{id,name,type}], recordsById, order }.
  function buildDataset(state) {
    var fm = state.fieldMap || {};
    var rm = state.recordMap || {};
    var fields = Object.keys(fm).map(function (id) { return { id: id, name: fm[id].name, type: fm[id].type }; });

    // Base-wide option-id -> label map (some selects inherit options from others).
    var optMap = {};
    Object.keys(fm).forEach(function (id) {
      var o = fm[id].property && fm[id].property.options;
      if (Array.isArray(o)) o.forEach(function (opt) { if (opt && opt.id && opt.name) optMap[opt.id] = opt.name; });
    });

    var order = (state.order || []).filter(function (id) { return rm[id]; });
    Object.keys(rm).forEach(function (id) { if (order.indexOf(id) === -1) order.push(id); });

    if (!fields.length) {
      var ks = {};
      order.forEach(function (rid) { var r = rm[rid] || {}; for (var k in r) ks[k] = 1; });
      fields = Object.keys(ks).map(function (k) { return { id: k, name: k, type: undefined }; });
    }

    var recordsById = {};
    order.forEach(function (rid) {
      var r = rm[rid] || {};
      var cells = {};
      fields.forEach(function (f) {
        var cell = r[f.id];
        var raw = (cell && typeof cell === "object" && "value" in cell) ? cell.value : cell;
        cells[f.id] = raw == null ? null : resolveCell(raw, fm[f.id] || f, optMap);
      });
      recordsById[rid] = cells;
    });
    return { fields: fields, recordsById: recordsById, order: order };
  }

  // ---------- analytics ----------

  function isEmpty(v) {
    return v === null || v === undefined || v === "" ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
  }

  function cellToString(v) {
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return v.map(cellToString).filter(Boolean).join(", ");
    if (typeof v === "object") {
      var c = v.text != null ? v.text : (v.name != null ? v.name : (v.value != null ? v.value : null));
      return c != null ? cellToString(c) : JSON.stringify(v);
    }
    return String(v);
  }

  function cellToNumber(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "boolean") return null;
    if (typeof v === "string") {
      var t = v.replace(/[,\s]/g, "");
      if (t === "" || !/^-?\d*\.?\d+([eE]-?\d+)?$/.test(t)) return null;
      var n = parseFloat(t);
      return isNaN(n) ? null : n;
    }
    return null;
  }

  function toTimestampMs(v) {
    if (v == null || v === "") return NaN;
    if (typeof v === "number") {
      if (!isFinite(v)) return NaN;
      // Lark date cells normally use milliseconds, while auto-created timestamps
      // can arrive as Unix seconds.
      if (v > 1e9 && v < 1e11) return v * 1000;
      return v;
    }
    var parsed = Date.parse(v);
    return isNaN(parsed) ? NaN : parsed;
  }

  function cellToDate(v) {
    if (typeof v === "number") {
      var ms = toTimestampMs(v);
      return (ms > 1e11 && ms < 4e12) ? ms : null;
    }
    if (typeof v === "string") {
      if (!/\d{4}|\d{1,2}[/-]\d{1,2}/.test(v)) return null;
      var t = Date.parse(v);
      return isNaN(t) ? null : t;
    }
    return null;
  }

  function inferType(values) {
    if (!values.length) return "text";
    var s = values.slice(0, 60), nums = 0, dates = 0, bools = 0;
    s.forEach(function (v) {
      if (v === true || v === false) bools++;
      if (cellToNumber(v) !== null) nums++;
      if (cellToDate(v) !== null) dates++;
    });
    var n = s.length;
    if (bools / n > 0.8) return "checkbox";
    if (nums / n > 0.8) return "number";
    if (dates / n > 0.8) return "date";
    var distinct = {};
    s.forEach(function (v) { distinct[cellToString(v)] = 1; });
    return Object.keys(distinct).length <= Math.max(2, n * 0.4) ? "category" : "text";
  }

  function median(sorted) { var n = sorted.length, m = n >> 1; return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2; }
  function stddev(nums, mean) {
    if (nums.length < 2) return 0;
    var v = nums.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (nums.length - 1);
    return Math.sqrt(v);
  }

  function analyzeColumn(field, values, total) {
    var nonEmpty = values.filter(function (v) { return !isEmpty(v); });
    var col = { name: field.name, filled: nonEmpty.length, empty: total - nonEmpty.length, total: total };
    var type = FIELD_TYPE[field.type] || inferType(nonEmpty);
    col.type = type;

    if (type === "number") {
      var nums = nonEmpty.map(cellToNumber).filter(function (n) { return n !== null; });
      if (nums.length) {
        nums.sort(function (a, b) { return a - b; });
        var sum = nums.reduce(function (a, b) { return a + b; }, 0), mean = sum / nums.length;
        col.stats = { count: nums.length, sum: sum, mean: mean, median: median(nums), min: nums[0], max: nums[nums.length - 1], stddev: stddev(nums, mean) };
      } else { type = col.type = "text"; }
    }
    if (type === "date") {
      var ds = nonEmpty.map(cellToDate).filter(Boolean);
      if (ds.length) {
        ds.sort(function (a, b) { return a - b; });
        col.stats = { count: ds.length, min: new Date(ds[0]).toLocaleDateString(), max: new Date(ds[ds.length - 1]).toLocaleDateString(), spanDays: Math.round((ds[ds.length - 1] - ds[0]) / 86400000) };
      } else { type = col.type = "text"; }
    }
    if (type === "checkbox") {
      var truthy = nonEmpty.filter(function (v) { return v === true || v === "true" || v === 1; }).length;
      col.stats = { checked: truthy, unchecked: col.filled - truthy };
    }
    if (["category", "user", "link", "text", "attachment"].indexOf(type) !== -1) {
      var freq = {}, distinct = 0;
      nonEmpty.forEach(function (v) {
        var sVal = cellToString(v);
        if (sVal === "") return;
        if (!(sVal in freq)) distinct++;
        freq[sVal] = (freq[sVal] || 0) + 1;
      });
      col.distinct = distinct;
      col.top = Object.keys(freq).map(function (k) { return { value: k, count: freq[k] }; })
        .sort(function (a, b) { return b.count - a.count; }).slice(0, 8);
      col.stats = col.stats || {};
    }
    return col;
  }

  function inferFields(rows) {
    var keys = {};
    rows.forEach(function (r) { for (var k in r) keys[k] = 1; });
    return Object.keys(keys).map(function (k) { return { id: k, name: k, type: undefined }; });
  }

  function buildAnalysis(dataset, source) {
    var rows = dataset.order.map(function (id) { return dataset.recordsById[id] || {}; });
    var fields = (dataset.fields && dataset.fields.length) ? dataset.fields : inferFields(rows);
    var columns = fields.map(function (f) {
      return analyzeColumn(f, rows.map(function (r) { return r[f.id]; }), rows.length);
    });
    columns.sort(function (a, b) { return b.filled - a.filled; }); // most-populated first
    return { rowCount: rows.length, columns: columns, sourceUrl: source || "", generatedAt: new Date().toLocaleString() };
  }

  // ---------- formatting + rendering (HTML strings) ----------

  function fmt(n) {
    if (typeof n !== "number" || !isFinite(n)) return String(n);
    return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function kv(k, v) { return '<div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div>"; }
  function statChip(n, label) { return '<div class="stat"><div class="n">' + fmt(n) + '</div><div class="l">' + esc(label) + "</div></div>"; }

  function renderSummary(a) {
    return statChip(a.rowCount, "rows") + statChip(a.columns.length, "columns") +
      statChip(a.columns.filter(function (c) { return c.type === "number"; }).length, "numeric") +
      statChip(a.columns.filter(function (c) { return c.type === "category"; }).length, "categorical") +
      statChip(a.columns.filter(function (c) { return c.type === "date"; }).length, "date");
  }

  function fieldCard(c) {
    var html = '<div class="field"><h3><span>' + esc(c.name) + '</span><span class="ftype">' + esc(c.type) + "</span></h3>";
    html += '<div class="kv">' + kv("Filled", fmt(c.filled) + " / " + fmt(c.total)) + (c.empty ? kv("Empty", fmt(c.empty)) : "");
    var s = c.stats || {};
    if (c.type === "number") {
      html += kv("Sum", fmt(s.sum)) + kv("Mean", fmt(s.mean)) + kv("Median", fmt(s.median)) + kv("Min", fmt(s.min)) + kv("Max", fmt(s.max)) + kv("Std dev", fmt(s.stddev));
    } else if (c.type === "date") {
      html += kv("Earliest", esc(s.min)) + kv("Latest", esc(s.max)) + kv("Span", fmt(s.spanDays) + " days");
    } else if (c.type === "checkbox") {
      html += kv("Checked", fmt(s.checked)) + kv("Unchecked", fmt(s.unchecked));
    } else if (c.distinct != null) {
      html += kv("Distinct", fmt(c.distinct));
    }
    html += "</div>";
    if (c.top && c.top.length) {
      var max = c.top[0].count || 1;
      html += '<table class="freq">' + c.top.map(function (t) {
        var label = t.value.length > 44 ? t.value.slice(0, 44) + "…" : t.value;
        return "<tr><td>" + esc(label) + '</td><td class="bar"><div class="barfill" style="width:' + Math.round((t.count / max) * 100) + '%"></div></td><td class="c">' + fmt(t.count) + "</td></tr>";
      }).join("") + "</table>";
    }
    return html + "</div>";
  }

  function renderFields(a, filter) {
    var cols = a.columns;
    if (filter) {
      var f = filter.toLowerCase();
      cols = cols.filter(function (c) { return c.name.toLowerCase().indexOf(f) !== -1; });
    }
    if (!cols.length) return '<p class="empty">No columns match.</p>';
    return cols.map(fieldCard).join("");
  }

  // ---------- export ----------

  var EXPORT_CSS =
    "body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1f2329;max-width:780px;margin:24px auto;padding:0 16px}" +
    "h1{font-size:20px}.meta{color:#646a73;font-size:12px}.stat{display:inline-block;background:#f2f3f5;border-radius:6px;padding:6px 10px;margin:0 6px 6px 0}.stat .n{font-size:16px;font-weight:600}.stat .l{font-size:11px;color:#646a73}" +
    ".field{border:1px solid #e5e6eb;border-radius:8px;padding:12px;margin:10px 0}.field h3{margin:0 0 6px;display:flex;justify-content:space-between}.ftype{color:#646a73;font-weight:400;font-size:12px}" +
    ".kv{display:grid;grid-template-columns:auto 1fr;gap:2px 16px}.kv .k{color:#646a73}.kv .v{text-align:right}" +
    "table.freq{width:100%;border-collapse:collapse;margin-top:8px}table.freq td{padding:3px 4px;border-top:1px solid #eee}table.freq td.c{text-align:right;color:#646a73}.bar{width:40%}.barfill{height:8px;background:#3370ff;border-radius:4px}";

  function buildReportHTML(a) {
    var body = "<h1>Lark Base Analytics Report</h1>" +
      '<p class="meta">Generated ' + esc(a.generatedAt) + " · " + fmt(a.rowCount) + " rows · " + fmt(a.columns.length) + " columns<br>" + esc(a.sourceUrl) + "</p>" +
      "<div>" + renderSummary(a) + "</div>" + a.columns.map(fieldCard).join("");
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lark Base Report</title><style>' + EXPORT_CSS + "</style></head><body>" + body + "</body></html>";
  }

  function buildReportCSV(a) {
    var rows = [["Column", "Type", "Filled", "Empty", "Distinct", "Sum", "Mean", "Median", "Min", "Max", "StdDev", "TopValues"]];
    a.columns.forEach(function (c) {
      var s = c.stats || {};
      var top = (c.top || []).map(function (t) { return t.value + " (" + t.count + ")"; }).join(" | ");
      var r = function (n) { return typeof n === "number" ? Math.round(n * 100) / 100 : n; };
      rows.push([c.name, c.type, c.filled, c.empty, c.distinct != null ? c.distinct : "",
        s.sum != null ? s.sum : "", s.mean != null ? r(s.mean) : "", s.median != null ? s.median : "",
        s.min != null ? s.min : "", s.max != null ? s.max : "", s.stddev != null ? r(s.stddev) : "", top]);
    });
    return "﻿" + rows.map(function (row) {
      return row.map(function (cell) {
        var v = String(cell == null ? "" : cell);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(",");
    }).join("\n");
  }

  // ---------- Handover pivot (Translator productivity by completion date) ----------
  // Built from the translation work-log table: rows = completion date, columns =
  // person × {Translate, Proofread, Haibao}, values = summed word counts.

  var HANDOVER_FIELDS = {
    translator: ["Translator"],
    proofreader: ["Proofreader"],
    reviewer: ["UI Reviewer"],
    wc: ["Word Count"],
    uiwc: ["#UI Review Word Count", "UI Review Word Count"],
    done: ["Translation Completion Time", "Translation Completion Date", "翻译实际完成时间"],
    transStatus: ["Translation Status"],
    proofStatus: ["Proofreading Status"],
    uiStatus: ["UI-Design Review Status", "UI Review Status"]
  };
  var IN_PROGRESS_KEY = "Task in progress";
  var CANCELED_KEY = "Task Canceled";
  var BANNER_KEY = "Banner";
  // Candidate names for the record creation time. NOTE: a field may be NAMED like a
  // creation time but actually be a broken text/formula constant (seen in real data:
  // a "创建时间" field holding the same number for every row) — so we only accept a
  // candidate that is genuinely a DATE-typed field (5 = date, 1001/1002 = auto times).
  var CREATED_NAMES = ["Creation Time", "Created Time", "Created time", "创建时间", "建立时间"];
  var BANNER_CREATED_NAMES = ["创建时间", "Creation Time", "Created Time", "Created time", "建立时间"];
  var DATE_TYPES = { 5: 1, 1001: 1, 1002: 1 };

  function findFieldId(dataset, names) {
    for (var i = 0; i < names.length; i++) {
      var f = dataset.fields.filter(function (x) { return x.name === names[i]; })[0];
      if (f) return f.id;
    }
    return null;
  }

  // Does a field actually hold timestamp values?
  function looksLikeDateField(dataset, fieldId) {
    var order = dataset.order || [], seen = 0, dates = 0;
    for (var i = 0; i < order.length && seen < 40; i++) {
      var v = (dataset.recordsById[order[i]] || {})[fieldId];
      if (v == null || v === "") continue;
      seen++;
      var ms = toTimestampMs(v);
      if (!isNaN(ms) && ms > 1e11 && ms < 4e12) dates++;
    }
    return seen > 0 && dates >= seen * 0.6;
  }

  // Record creation time, resolved to a field that genuinely holds dates:
  // 1) an explicitly-named creation field that is date-typed OR holds date values,
  // 2) else the Lark auto "Created Time" field (type 1001) under any name,
  // 3) else any creation-hinted field that holds date values.
  function findCreatedField(dataset) {
    for (var i = 0; i < CREATED_NAMES.length; i++) {
      var named = dataset.fields.filter(function (x) { return x.name === CREATED_NAMES[i]; });
      for (var j = 0; j < named.length; j++) {
        if (DATE_TYPES[named[j].type] || looksLikeDateField(dataset, named[j].id)) return named[j].id;
      }
    }
    var auto = dataset.fields.filter(function (x) { return x.type === 1001; })[0];
    if (auto) return auto.id;
    var hint = dataset.fields.filter(function (x) {
      return /创建|建立|created|creation/i.test(x.name) && (DATE_TYPES[x.type] || looksLikeDateField(dataset, x.id));
    })[0];
    return hint ? hint.id : null;
  }

  function findDateFieldByNames(dataset, names) {
    for (var i = 0; i < names.length; i++) {
      var named = dataset.fields.filter(function (x) { return x.name === names[i]; });
      for (var j = 0; j < named.length; j++) {
        if (DATE_TYPES[named[j].type] || looksLikeDateField(dataset, named[j].id)) return named[j].id;
      }
    }
    return null;
  }

  function detectHandover(dataset) {
    var ids = {};
    Object.keys(HANDOVER_FIELDS).forEach(function (k) { ids[k] = findFieldId(dataset, HANDOVER_FIELDS[k]); });
    ids.created = findCreatedField(dataset);
    ids.bannerCreated = findDateFieldByNames(dataset, BANNER_CREATED_NAMES) || ids.created;
    return (ids.translator && ids.proofreader && ids.wc) ? ids : null;
  }

  function splitPersons(v) {
    if (v == null || v === "") return [];
    return (Array.isArray(v) ? v : String(v).split(", ")).map(function (s) { return String(s).trim(); }).filter(Boolean);
  }
  function toNum(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    if (typeof v === "string") { var n = parseFloat(v.replace(/[,\s]/g, "")); return isNaN(n) ? 0 : n; }
    return 0;
  }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function isCompleted(v) { return String(v == null ? "" : v).trim().toLowerCase() === "completed"; }
  function isInProgress(v) { return String(v == null ? "" : v).trim().toLowerCase() === "in progress"; }
  function isCanceled(v) { var s = String(v == null ? "" : v).trim().toLowerCase(); return /^cancel/.test(s) || s === "取消" || s === "已取消"; }

  // Calendar parts (year/month/day) of a timestamp AS SEEN in a given timezone.
  // Lark buckets dates by the base timezone (e.g. Asia/Saigon), not the browser's.
  function tzParts(ms, tz) {
    var fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    var o = {};
    fmt.formatToParts(new Date(ms)).forEach(function (p) { if (p.type !== "literal") o[p.type] = p.value; });
    return { y: +o.year, m: +o.month, d: +o.day };
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m is 1-based

  var MAX_WINDOW_MONTHS = 24; // safety cap so a huge range can't produce thousands of day rows

  // The CALENDAR QUARTER containing month p.m (Q1 Jan-Mar, Q2 Apr-Jun, Q3 Jul-Sep,
  // Q4 Oct-Dec). A quarter is always within one year — used as the default window.
  function quarterRange(p) {
    var sm = Math.floor((p.m - 1) / 3) * 3 + 1; // first month of the quarter
    return { fromYear: p.y, fromMonth: sm, toYear: p.y, toMonth: sm + 2 };
  }

  // Validate/clamp a month range: swap if from > to, then cap the span at
  // MAX_WINDOW_MONTHS months (clamping the start forward, keeping the end fixed).
  function normalizeRange(r) {
    var a = r.fromYear * 12 + (r.fromMonth - 1);
    var b = r.toYear * 12 + (r.toMonth - 1);
    if (a > b) { var t = a; a = b; b = t; }
    if (b - a > MAX_WINDOW_MONTHS - 1) a = b - (MAX_WINDOW_MONTHS - 1);
    return { fromYear: Math.floor(a / 12), fromMonth: (a % 12) + 1, toYear: Math.floor(b / 12), toMonth: (b % 12) + 1 };
  }

  function buildHandover(dataset, opts) {
    var f = detectHandover(dataset);
    if (!f) return null;
    var tz = (opts && opts.timeZone) || (dataset && dataset.timeZone);
    if (!tz) { try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { tz = "UTC"; } }
    var nowMs = (opts && opts.now) ? new Date(opts.now).getTime() : Date.now();
    var nowP = tzParts(nowMs, tz);

    // The window is an inclusive month range (1-based months), in the base timezone.
    // Default = the current calendar quarter. Per-day rows, date-descending.
    var rangeOpt = opts && opts.range;
    var range = (rangeOpt && rangeOpt.fromYear && rangeOpt.fromMonth && rangeOpt.toYear && rangeOpt.toMonth)
      ? normalizeRange(rangeOpt) : quarterRange(nowP);
    var multiYear = range.fromYear !== range.toYear;

    var pivot = {}, persons = {}, windowKeys = [], inWin = {};
    var y = range.toYear, mm = range.toMonth;
    while (y > range.fromYear || (y === range.fromYear && mm >= range.fromMonth)) {
      var dim = daysInMonth(y, mm);
      for (var d = dim; d >= 1; d--) {
        // Disambiguate identical day-month labels across years (e.g. "8-Jun-2025").
        var key = d + "-" + MON[mm - 1] + (multiYear ? "-" + y : "");
        pivot[key] = {};
        windowKeys.push(key);
        inWin[y + "-" + mm + "-" + d] = key;
      }
      mm--; if (mm < 1) { mm = 12; y--; }
    }
    pivot[CANCELED_KEY] = {};
    pivot[IN_PROGRESS_KEY] = {};
    pivot[BANNER_KEY] = {};
    var STAGES = ["Translate", "Proofread", "Haibao"];

    function add(key, person, stage, amt) {
      if (!key || !person || !amt) return;
      persons[person] = 1;
      pivot[key] = pivot[key] || {};
      pivot[key][person] = pivot[key][person] || {};
      pivot[key][person][stage] = (pivot[key][person][stage] || 0) + amt;
    }

    // Map a timestamp to its in-window day key, or null.
    function winKeyOf(raw) {
      var ms = toTimestampMs(raw);
      if (isNaN(ms)) return null;
      var p = tzParts(ms, tz);
      return inWin[p.y + "-" + p.m + "-" + p.d] || null;
    }

    dataset.order.forEach(function (id) {
      var r = dataset.recordsById[id] || {};
      var wc = toNum(r[f.wc]), uiwc = f.uiwc ? toNum(r[f.uiwc]) : 0;
      var translators = splitPersons(r[f.translator]);
      var proofreaders = splitPersons(r[f.proofreader]);

      // Banner row: each UI Reviewer's UI Review Word Count, filtered by CREATION
      // time (created within the window), regardless of status. Shown in the
      // Proofread column. Computed for every record (incl. in-progress/canceled).
      if (f.reviewer && uiwc) {
        var bannerIn = f.bannerCreated ? winKeyOf(r[f.bannerCreated]) : "all";
        if (bannerIn) splitPersons(r[f.reviewer]).forEach(function (p) { add(BANNER_KEY, p, "Proofread", uiwc); });
      }

      // Special rows ("Task in progress" / "Task Canceled") are keyed off the
      // Translation Status and filtered by CREATION time (创建时间), not completion.
      // Each credits its Word Count to both the Translator and the Proofreader.
      var ts = f.transStatus ? r[f.transStatus] : null;
      var inProg = isInProgress(ts), canceled = isCanceled(ts);
      if (inProg || canceled) {
        var createdIn = f.created ? winKeyOf(r[f.created]) : "all"; // no created field -> count all
        if (createdIn) {
          var specialKey = canceled ? CANCELED_KEY : IN_PROGRESS_KEY;
          translators.forEach(function (p) { add(specialKey, p, "Translate", wc); });
          proofreaders.forEach(function (p) { add(specialKey, p, "Proofread", wc); });
        }
        return; // in-progress/canceled tasks don't contribute to the completed day rows
      }

      // Day rows: each stage counts only when ITS status is Completed and the
      // completion date (in base tz) is inside the window.
      var winKey = winKeyOf(f.done ? r[f.done] : null);
      function dayKey(statusFieldId) {
        var completed = statusFieldId ? isCompleted(r[statusFieldId]) : true;
        return completed ? winKey : null; // completed but outside window -> excluded
      }
      var kT = dayKey(f.transStatus);
      var kP = dayKey(f.proofStatus);
      translators.forEach(function (p) { add(kT, p, "Translate", wc); });
      proofreaders.forEach(function (p) { add(kP, p, "Proofread", wc); });
      // Haibao day data intentionally not populated — the column stays (header +
      // 0 total) but holds no values. UI-review word count now feeds the Banner row.
    });

    var personList = Object.keys(persons).sort();
    // Canceled, in-progress, then banner rows first (above the daily breakdown), then dates desc.
    var dateKeys = [CANCELED_KEY, IN_PROGRESS_KEY, BANNER_KEY].concat(windowKeys);

    var totals = {};
    personList.forEach(function (p) {
      totals[p] = {};
      STAGES.forEach(function (st) {
        var sum = 0;
        windowKeys.forEach(function (k) { sum += (pivot[k] && pivot[k][p] && pivot[k][p][st]) || 0; });
        totals[p][st] = sum;
      });
    });

    return {
      persons: personList, stages: STAGES, dateKeys: dateKeys, pivot: pivot, totals: totals,
      rowCount: dataset.order.length,
      window: windowKeys[windowKeys.length - 1] + " → " + windowKeys[0], range: range, timeZone: tz
    };
  }

  // Diagnostic: explains why the in-progress / canceled rows may be empty. Reports
  // the detected status & creation fields, the distinct status values, how many
  // records match each status, whether they have a Word Count, and the months they
  // were CREATED in (so you can see whether they fall inside the selected window).
  function diagnoseHandover(dataset, opts) {
    var f = detectHandover(dataset);
    if (!f) return { error: "Translator / Proofreader / Word Count fields not detected" };
    var tz = (opts && opts.timeZone) || (dataset && dataset.timeZone) || "UTC";
    function nameOf(id) { var x = dataset.fields.filter(function (z) { return z.id === id; })[0]; return x ? x.name : null; }
    var statusCounts = {}, matched = { inProgress: 0, canceled: 0 }, wcPos = { inProgress: 0, canceled: 0 }, createdMonths = {};
    dataset.order.forEach(function (id) {
      var r = dataset.recordsById[id] || {};
      var v = f.transStatus ? r[f.transStatus] : null;
      var sk = (v == null || v === "") ? "(empty)" : String(v);
      statusCounts[sk] = (statusCounts[sk] || 0) + 1;
      var which = isCanceled(v) ? "canceled" : (isInProgress(v) ? "inProgress" : null);
      if (!which) return;
      matched[which]++;
      if (toNum(r[f.wc]) > 0) wcPos[which]++;
      var raw = f.created ? r[f.created] : null;
      var ms = toTimestampMs(raw);
      var ym = isNaN(ms) ? "(no creation date)" : (function () { var p = tzParts(ms, tz); return p.y + "-" + (p.m < 10 ? "0" : "") + p.m; })();
      createdMonths[ym] = (createdMonths[ym] || 0) + 1;
    });
    var top = Object.keys(statusCounts).sort(function (a, b) { return statusCounts[b] - statusCounts[a]; })
      .slice(0, 15).map(function (k) { return k + " ×" + statusCounts[k]; });

    // Banner breakdown: per UI Reviewer, total vs in-window UI Review Word Count,
    // so you can tell apart a window issue (records exist but fall outside) from a
    // data-loading issue (records simply aren't loaded). Mirrors the Banner math.
    var nowMs = (opts && opts.now) ? new Date(opts.now).getTime() : Date.now();
    var nowP = tzParts(nowMs, tz);
    var ro = opts && opts.range;
    var range = (ro && ro.fromYear && ro.fromMonth && ro.toYear && ro.toMonth) ? normalizeRange(ro) : quarterRange(nowP);
    var fromIdx = range.fromYear * 12 + (range.fromMonth - 1), toIdx = range.toYear * 12 + (range.toMonth - 1);
    var banner = {};
    dataset.order.forEach(function (id) {
      var r = dataset.recordsById[id] || {};
      var amt = f.uiwc ? toNum(r[f.uiwc]) : 0;
      if (!amt || !f.reviewer) return;
      var raw = f.bannerCreated ? r[f.bannerCreated] : null;
      var ms = toTimestampMs(raw);
      var idx = isNaN(ms) ? null : (function () { var p = tzParts(ms, tz); return p.y * 12 + (p.m - 1); })();
      var inWin = idx != null && idx >= fromIdx && idx <= toIdx;
      splitPersons(r[f.reviewer]).forEach(function (p) {
        banner[p] = banner[p] || { uiwcAllDates: 0, uiwcInWindow: 0, recordsAllDates: 0, recordsInWindow: 0 };
        banner[p].uiwcAllDates += amt; banner[p].recordsAllDates++;
        if (inWin) { banner[p].uiwcInWindow += amt; banner[p].recordsInWindow++; }
      });
    });

    return {
      rowsLoaded: dataset.order.length,
      statusField: nameOf(f.transStatus),
      statusValuesTop: top,
      matchedInProgress: matched.inProgress, matchedCanceled: matched.canceled,
      ofThoseWithWordCount: { inProgress: wcPos.inProgress, canceled: wcPos.canceled },
      creationField: nameOf(f.created),
      bannerCreationField: nameOf(f.bannerCreated),
      creationSampleValue: f.created && dataset.order.length ? dataset.recordsById[dataset.order[0]][f.created] : null,
      createdMonthsOfMatched: createdMonths,
      uiReviewWordCountField: nameOf(f.uiwc),
      windowRange: range.fromYear + "-" + range.fromMonth + " .. " + range.toYear + "-" + range.toMonth,
      bannerByReviewer: banner
    };
  }

  // ---- month-range picker helpers (shared by popup + on-page panel) ----

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function monthInputValue(y, m) { return y + "-" + pad2(m); } // -> "YYYY-MM"
  function parseMonthInput(str) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(str || ""));
    if (!m) return null;
    var mo = +m[2];
    if (mo < 1 || mo > 12) return null;
    return { year: +m[1], month: mo };
  }
  function parseRangeControls(fromStr, toStr) {
    var a = parseMonthInput(fromStr), b = parseMonthInput(toStr);
    if (!a || !b) return null;
    return { fromYear: a.year, fromMonth: a.month, toYear: b.year, toMonth: b.month };
  }
  // HTML for the From/To month pickers; values seeded from the resolved range.
  function renderRangeControls(range) {
    var r = range || {};
    var from = (r.fromYear && r.fromMonth) ? monthInputValue(r.fromYear, r.fromMonth) : "";
    var to = (r.toYear && r.toMonth) ? monthInputValue(r.toYear, r.toMonth) : "";
    return '<span class="rangebar-label">Productivity window:</span>' +
      '<label>From <input type="month" id="hvFrom" class="month" value="' + from + '"></label>' +
      '<span class="arrow">→</span>' +
      '<label>To <input type="month" id="hvTo" class="month" value="' + to + '"></label>' +
      '<button class="btn small" id="hvReset">Reset to quarter</button>';
  }

  // Full flat export of the resolved dataset (every record × every field).
  function buildRawCSV(dataset) {
    var fields = dataset.fields;
    var rows = [fields.map(function (f) { return f.name; })];
    dataset.order.forEach(function (id) {
      var r = dataset.recordsById[id] || {};
      rows.push(fields.map(function (f) { return cellToString(r[f.id]); }));
    });
    return "﻿" + rows.map(function (row) {
      return row.map(function (cell) { var v = String(cell == null ? "" : cell); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(",");
    }).join("\n");
  }

  function handoverColumns(h) {
    var cols = [];
    h.persons.forEach(function (p) { h.stages.forEach(function (st) { cols.push({ person: p, stage: st, label: p + " - " + st }); }); });
    return cols;
  }

  function renderHandover(h) {
    if (!h || !h.persons.length) return '<p class="empty">No completed translator work in this window among the loaded rows. Click “⬇ Load all rows”, or scroll the table to load more.</p>';
    var cols = handoverColumns(h);
    var th = '<th class="d">Translation Completion Date</th>' + cols.map(function (c) { return "<th>" + esc(c.label) + "</th>"; }).join("");
    var totalRow = '<tr class="tot"><td class="d">Total</td>' + cols.map(function (c) {
      return "<td>" + fmt(h.totals[c.person][c.stage] || 0) + "</td>";
    }).join("") + "</tr>";
    var body = h.dateKeys.map(function (k) {
      return '<tr><td class="d">' + esc(k) + "</td>" + cols.map(function (c) {
        var v = (h.pivot[k] && h.pivot[k][c.person] && h.pivot[k][c.person][c.stage]) || 0;
        return "<td>" + (v ? fmt(v) : "") + "</td>";
      }).join("") + "</tr>";
    }).join("");
    return '<table class="pivot"><thead><tr>' + th + "</tr></thead><tbody>" + totalRow + body + "</tbody></table>";
  }

  // Build the pivot as a 2D grid: header + Total + (in-progress, daily…) rows.
  function handoverGrid(h) {
    var cols = handoverColumns(h);
    var rows = [["Translation Completion Date"].concat(cols.map(function (c) { return c.label; }))];
    rows.push(["Total"].concat(cols.map(function (c) { return h.totals[c.person][c.stage] || 0; })));
    h.dateKeys.forEach(function (k) {
      rows.push([k].concat(cols.map(function (c) {
        return (h.pivot[k] && h.pivot[k][c.person] && h.pivot[k][c.person][c.stage]) || 0;
      })));
    });
    return rows;
  }

  function buildHandoverCSV(h) {
    return "﻿" + handoverGrid(h).map(function (r) {
      return r.map(function (cell) { var v = String(cell == null ? "" : cell); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(",");
    }).join("\n");
  }

  // Tab-separated — pastes straight into a spreadsheet with columns aligned.
  function buildHandoverTSV(h) {
    return handoverGrid(h).map(function (r) { return r.join("\t"); }).join("\n");
  }

  root.LarkCore = {
    FIELD_TYPE: FIELD_TYPE,
    detectHandover: detectHandover,
    buildHandover: buildHandover,
    diagnoseHandover: diagnoseHandover,
    renderHandover: renderHandover,
    renderRangeControls: renderRangeControls,
    parseRangeControls: parseRangeControls,
    monthInputValue: monthInputValue,
    buildHandoverCSV: buildHandoverCSV,
    buildHandoverTSV: buildHandoverTSV,
    buildRawCSV: buildRawCSV,
    gunzipBase64: gunzipBase64,
    extractRecords: extractRecords,
    extractClientvars: extractClientvars,
    buildDataset: buildDataset,
    buildAnalysis: buildAnalysis,
    renderSummary: renderSummary,
    renderFields: renderFields,
    buildReportHTML: buildReportHTML,
    buildReportCSV: buildReportCSV
  };
})(typeof window !== "undefined" ? window : this);
