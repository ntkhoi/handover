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

  // Per-person color bands (matches the handover sheet style). Each person gets one
  // entry, cycling if there are more people than colors. `head` = the person name
  // band, `sub` = the stage row underneath, both light enough for black text.
  // Hex WITHOUT the leading "#": used as "#"+hex in CSS and "FF"+hex (ARGB) in xlsx.
  var PERSON_PALETTE = [
    { head: "F48FB1", sub: "FCE4EC" }, // pink
    { head: "A5D6A7", sub: "E8F5E9" }, // green
    { head: "FFE082", sub: "FFFDE7" }, // amber
    { head: "90CAF9", sub: "E3F2FD" }, // blue
    { head: "CE93D8", sub: "F3E5F5" }, // purple
    { head: "FFCC80", sub: "FFF3E0" }, // orange
    { head: "80CBC4", sub: "E0F2F1" }, // teal
    { head: "BCAAA4", sub: "EFEBE9" }, // brown
    { head: "B0BEC5", sub: "ECEFF1" }, // blue-grey
    { head: "EF9A9A", sub: "FFEBEE" }  // red
  ];
  function personColor(i) { return PERSON_PALETTE[((i % PERSON_PALETTE.length) + PERSON_PALETTE.length) % PERSON_PALETTE.length]; }
  function personColorMap(persons) {
    var m = {};
    (persons || []).forEach(function (p, i) { m[p] = personColor(i); });
    return m;
  }
  // The non-date pivot rows that get a highlighted (summary) style.
  function isSpecialKey(k) { return k === IN_PROGRESS_KEY || k === CANCELED_KEY || k === BANNER_KEY; }
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

      // Each stage is routed INDEPENDENTLY by ITS OWN status field:
      //  - In progress / Canceled  -> the special summary rows, filtered by CREATION
      //    time (创建时间) being inside the window.
      //  - Completed                -> the per-day rows, filtered by the COMPLETION date.
      // So a record whose Translation is completed but Proofreading is still in
      // progress contributes to the day row (Translate) AND the in-progress row
      // (Proofread) at once — each column reflects only its own stage's status.
      var createdIn = f.created ? winKeyOf(r[f.created]) : "all"; // no created field -> count all
      var winKey = winKeyOf(f.done ? r[f.done] : null);
      function route(persons, statusFieldId, stage) {
        if (!persons.length) return;
        var status = statusFieldId ? r[statusFieldId] : null;
        var key = null;
        if (isInProgress(status)) key = createdIn ? IN_PROGRESS_KEY : null;
        else if (isCanceled(status)) key = createdIn ? CANCELED_KEY : null;
        else if (statusFieldId ? isCompleted(status) : true) key = winKey; // outside window -> null
        if (key) persons.forEach(function (p) { add(key, p, stage, wc); });
      }
      route(translators, f.transStatus, "Translate");
      route(proofreaders, f.proofStatus, "Proofread");
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

  // Colored, grouped pivot table (shared by the on-page panel, the popup, and the
  // standalone full-view page). Header is two rows: a person-name band (colspan =
  // #stages) over a stage row (Translate/Proofread/Haibao), each tinted by person.
  function pivotTableHTML(h) {
    if (!h || !h.persons.length) return '<p class="empty">No completed translator work in this window among the loaded rows. Click “⬇ Load all rows”, or scroll the table to load more.</p>';
    var colors = personColorMap(h.persons);
    var nStages = h.stages.length;
    var groupRow = '<th class="d" rowspan="2">Translation Completion Date</th>' + h.persons.map(function (p) {
      return '<th class="grp" colspan="' + nStages + '" style="background:#' + colors[p].head + '">' + esc(p) + "</th>";
    }).join("");
    var stageRow = h.persons.map(function (p) {
      return h.stages.map(function (st) { return '<th class="stg" style="background:#' + colors[p].sub + '">' + esc(st) + "</th>"; }).join("");
    }).join("");
    var cols = handoverColumns(h);
    function dataRow(label, getter, cls) {
      return "<tr" + (cls ? ' class="' + cls + '"' : "") + '><td class="d">' + esc(label) + "</td>" + cols.map(function (c) {
        var v = getter(c);
        return "<td>" + (v ? fmt(v) : "") + "</td>";
      }).join("") + "</tr>";
    }
    var totalRow = dataRow("Total", function (c) { return h.totals[c.person][c.stage] || 0; }, "tot");
    var body = h.dateKeys.map(function (k) {
      return dataRow(k, function (c) { return (h.pivot[k] && h.pivot[k][c.person] && h.pivot[k][c.person][c.stage]) || 0; }, isSpecialKey(k) ? "special" : "");
    }).join("");
    return '<table class="pivot"><thead><tr class="grouprow">' + groupRow + '</tr><tr class="stagerow">' + stageRow +
      "</tr></thead><tbody>" + totalRow + body + "</tbody></table>";
  }

  function renderHandover(h) { return pivotTableHTML(h); }

  // ---- Standalone full-view HTML page (opened in a new tab) ----
  var FULLVIEW_CSS =
    "*{box-sizing:border-box}" +
    "body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2329;background:#f5f6f8}" +
    "header{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;" +
    "padding:14px 22px;background:#fff;border-bottom:1px solid #e5e6eb;box-shadow:0 1px 4px rgba(0,0,0,.04)}" +
    "header h1{font-size:18px;margin:0}header .meta{color:#646a73;font-size:12px;margin-top:3px}" +
    ".tools{display:flex;gap:8px;flex-wrap:wrap}" +
    ".btn{border:1px solid #d4d6dc;background:#fff;color:#1f2329;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:500;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}" +
    ".btn:hover{border-color:#3370ff;color:#3370ff}.btn.primary{background:#3370ff;border-color:#3370ff;color:#fff}.btn.primary:hover{background:#2860e0;color:#fff}" +
    ".legend{display:flex;gap:14px;flex-wrap:wrap;padding:12px 22px 0;font-size:12px;color:#646a73}.legend .lg{display:inline-flex;align-items:center;gap:6px}.legend i{width:14px;height:14px;border-radius:4px;display:inline-block;border:1px solid rgba(0,0,0,.08)}" +
    ".tablewrap{margin:14px 22px 30px;overflow:auto;max-height:calc(100vh - 150px);border:1px solid #e5e6eb;border-radius:10px;background:#fff}" +
    "table.pivot{border-collapse:separate;border-spacing:0;font-size:13px;white-space:nowrap;width:max-content}" +
    "table.pivot th,table.pivot td{padding:7px 12px;border-right:1px solid #eef0f2;border-bottom:1px solid #eef0f2;text-align:right;font-variant-numeric:tabular-nums}" +
    "table.pivot thead th{position:sticky;font-weight:600;color:#1f2329}" +
    "table.pivot tr.grouprow th{top:0;z-index:6;text-align:center;font-weight:700;font-size:13px}" +
    "table.pivot tr.stagerow th{top:38px;z-index:5;text-align:center;font-weight:600;color:#3c4043}" +
    "table.pivot th.d,table.pivot td.d{position:sticky;left:0;text-align:left;font-weight:600;background:#fff}" +
    "table.pivot tr.grouprow th.d{top:0;z-index:8;background:#f0f2f5}" +
    "table.pivot td.d{z-index:3}" +
    "table.pivot tbody td{background:#fff}" +
    "table.pivot tr.tot td{background:#eef3ff!important;font-weight:700}" +
    "table.pivot tr.special td{background:#fff7e6!important;font-weight:600}" +
    "table.pivot tbody tr:hover td{background:#f7f9ff}" +
    "@media print{header{position:static;box-shadow:none}.tools{display:none}.tablewrap{max-height:none;overflow:visible;border:none}body{background:#fff}}";

  function buildHandoverHTML(h, opts) {
    opts = opts || {};
    var colors = personColorMap((h && h.persons) || []);
    var legend = ((h && h.persons) || []).map(function (p) {
      return '<span class="lg"><i style="background:#' + colors[p].head + '"></i>' + esc(p) + "</span>";
    }).join("");
    var base = opts.fileBase || "handover-pivot";
    var links = "";
    if (opts.xlsxBase64) links += '<a class="btn primary" download="' + esc(base) + '.xlsx" href="data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + opts.xlsxBase64 + '">⬇ Excel (.xlsx)</a>';
    if (opts.csvBase64) links += '<a class="btn" download="' + esc(base) + '.csv" href="data:text/csv;charset=utf-8;base64,' + opts.csvBase64 + '">⬇ CSV</a>';
    var meta = [];
    if (h && h.window) meta.push(esc(h.window));
    if (opts.rowCount != null) meta.push(fmt(opts.rowCount) + " rows loaded");
    if (h && h.timeZone) meta.push(esc(h.timeZone));
    if (opts.generatedAt) meta.push("generated " + esc(opts.generatedAt));
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<title>Translator Productivity" + (h && h.window ? " · " + esc(h.window) : "") + "</title>" +
      "<style>" + FULLVIEW_CSS + "</style></head><body>" +
      '<header><div><h1>Translator Productivity</h1><div class="meta">' + meta.join(" · ") + "</div></div>" +
      '<div class="tools"><button class="btn" onclick="window.print()">🖨 Print / PDF</button>' + links + "</div></header>" +
      (legend ? '<div class="legend">' + legend + "</div>" : "") +
      '<div class="tablewrap">' + pivotTableHTML(h) + "</div></body></html>";
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

  // ---------- .xlsx export (real OOXML, colored like the handover sheet) ----------
  // A self-contained, dependency-free .xlsx writer. We emit the handful of XML parts
  // Excel needs and pack them into a ZIP with the STORE method (no compression — the
  // pivot is tiny), so we only need a CRC-32, not a deflate implementation.

  // 1-based column index -> spreadsheet column letters (1->A, 27->AA).
  function colLetter(n) {
    var s = "";
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
  }

  var _crcTable = null;
  function crc32(bytes) {
    if (!_crcTable) {
      _crcTable = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = _crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Pack [{name, data:Uint8Array}] into a ZIP archive (stored). Returns Uint8Array.
  function zipStore(files) {
    var enc = new TextEncoder();
    var chunks = [], central = [], offset = 0;
    function u16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
    function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }
    var DOSDATE = 0x21, DOSTIME = 0; // 1980-01-01 00:00, fixed for determinism
    files.forEach(function (f) {
      var nameBytes = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      var local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(DOSTIME), u16(DOSDATE),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0));
      chunks.push(new Uint8Array(local), nameBytes, f.data);
      var cd = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(DOSTIME), u16(DOSDATE),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push(new Uint8Array(cd), nameBytes);
      offset += local.length + nameBytes.length + size;
    });
    var cdStart = offset, cdLen = 0;
    central.forEach(function (c) { chunks.push(c); cdLen += c.length; });
    chunks.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0),
      u16(files.length), u16(files.length), u32(cdLen), u32(cdStart), u16(0))));
    var total = chunks.reduce(function (a, c) { return a + c.length; }, 0);
    var out = new Uint8Array(total), p = 0;
    chunks.forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  var XLSX_CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    "</Types>";
  var XLSX_ROOT_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";
  var XLSX_WORKBOOK =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Productivity" sheetId="1" r:id="rId1"/></sheets></workbook>';
  var XLSX_WORKBOOK_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    "</Relationships>";

  var XLSX_DATE_HDR = "D9D9D9", XLSX_TOTAL = "DCE6F1"; // grey date header, light-blue total

  // Build styles.xml + a lookup of cell-style (xf) indices keyed by role/person.
  function buildXlsxStyles(persons) {
    var palette = personColorMap(persons);
    var colorList = [], colorIdx = {};
    function need(hex) { if (!(hex in colorIdx)) { colorIdx[hex] = colorList.length; colorList.push(hex); } }
    persons.forEach(function (p) { need(palette[p].head); need(palette[p].sub); });
    need(XLSX_DATE_HDR); need(XLSX_TOTAL);
    function fillOf(hex) { return 2 + colorIdx[hex]; } // 0 = none, 1 = gray125

    var fills = '<fills count="' + (2 + colorList.length) + '">' +
      '<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      colorList.map(function (hex) { return '<fill><patternFill patternType="solid"><fgColor rgb="FF' + hex + '"/><bgColor indexed="64"/></patternFill></fill>'; }).join("") + "</fills>";
    var fonts = '<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/></font></fonts>';
    var borders = '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right>' +
      '<top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>';

    var xfs = [], idx = {};
    function push(o) {
      var s = '<xf numFmtId="' + (o.numFmt || 0) + '" fontId="' + (o.font || 0) + '" fillId="' + (o.fill || 0) + '" borderId="' + (o.border || 0) + '" xfId="0"';
      if (o.numFmt) s += ' applyNumberFormat="1"';
      if (o.font) s += ' applyFont="1"';
      if (o.fill) s += ' applyFill="1"';
      if (o.border) s += ' applyBorder="1"';
      if (o.align) s += ' applyAlignment="1"><alignment' + (o.align.h ? ' horizontal="' + o.align.h + '"' : "") + (o.align.v ? ' vertical="' + o.align.v + '"' : "") + (o.align.wrap ? ' wrapText="1"' : "") + "/></xf>";
      else s += "/>";
      xfs.push(s);
      return xfs.length - 1;
    }
    idx.def = push({});
    idx.dateHdr = push({ font: 1, fill: fillOf(XLSX_DATE_HDR), border: 1, align: { h: "center", v: "center", wrap: true } });
    idx.dataNum = push({ numFmt: 164, fill: 0, border: 1, align: { h: "right" } });
    idx.dataLabel = push({ fill: 0, border: 1, align: { h: "left" } });
    idx.totLabel = push({ font: 1, fill: fillOf(XLSX_TOTAL), border: 1, align: { h: "left" } });
    idx.totNum = push({ font: 1, numFmt: 164, fill: fillOf(XLSX_TOTAL), border: 1, align: { h: "right" } });
    idx.head = {}; idx.sub = {};
    persons.forEach(function (p) {
      idx.head[p] = push({ font: 1, fill: fillOf(palette[p].head), border: 1, align: { h: "center", v: "center", wrap: true } });
      idx.sub[p] = push({ font: 1, fill: fillOf(palette[p].sub), border: 1, align: { h: "center" } });
    });

    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>' +
      fonts + fills + borders +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xfs.length + '">' + xfs.join("") + "</cellXfs>" +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    return { xml: xml, idx: idx };
  }

  function buildHandoverXLSX(h) {
    var persons = (h && h.persons) || [];
    var styles = buildXlsxStyles(persons), idx = styles.idx;
    var cols = handoverColumns(h), nStages = h.stages.length;
    var lastColN = cols.length + 1; // + the date column
    var rows = [];

    // Row 1: person-name band (label sits in the first stage column, merged over the rest).
    var c1 = ['<c r="A1" s="' + idx.dateHdr + '" t="inlineStr"><is><t xml:space="preserve">Translation Completion Date</t></is></c>'];
    var n = 2;
    persons.forEach(function (p) {
      for (var st = 0; st < nStages; st++) {
        var ref = colLetter(n) + "1";
        c1.push(st === 0
          ? '<c r="' + ref + '" s="' + idx.head[p] + '" t="inlineStr"><is><t xml:space="preserve">' + esc(p) + "</t></is></c>"
          : '<c r="' + ref + '" s="' + idx.head[p] + '"/>');
        n++;
      }
    });
    rows.push('<row r="1">' + c1.join("") + "</row>");

    // Row 2: stage row (Translate / Proofread / Haibao).
    var c2 = ['<c r="A2" s="' + idx.dateHdr + '"/>'];
    n = 2;
    persons.forEach(function (p) {
      h.stages.forEach(function (stage) {
        c2.push('<c r="' + colLetter(n) + '2" s="' + idx.sub[p] + '" t="inlineStr"><is><t xml:space="preserve">' + esc(stage) + "</t></is></c>");
        n++;
      });
    });
    rows.push('<row r="2">' + c2.join("") + "</row>");

    var rowNum = 3;
    function dataRow(label, getter, hi) {
      var labelS = hi ? idx.totLabel : idx.dataLabel, numS = hi ? idx.totNum : idx.dataNum;
      var cells = ['<c r="A' + rowNum + '" s="' + labelS + '" t="inlineStr"><is><t xml:space="preserve">' + esc(label) + "</t></is></c>"];
      var cn = 2;
      cols.forEach(function (c) {
        var v = getter(c), ref = colLetter(cn) + rowNum;
        cells.push(v ? '<c r="' + ref + '" s="' + numS + '"><v>' + v + "</v></c>" : '<c r="' + ref + '" s="' + numS + '"/>');
        cn++;
      });
      rows.push('<row r="' + rowNum + '">' + cells.join("") + "</row>");
      rowNum++;
    }
    dataRow("Total", function (c) { return h.totals[c.person][c.stage] || 0; }, true);
    h.dateKeys.forEach(function (k) {
      dataRow(k, function (c) { return (h.pivot[k] && h.pivot[k][c.person] && h.pivot[k][c.person][c.stage]) || 0; }, isSpecialKey(k));
    });

    var merges = ['<mergeCell ref="A1:A2"/>'];
    var mc = 2;
    persons.forEach(function () { merges.push('<mergeCell ref="' + colLetter(mc) + "1:" + colLetter(mc + nStages - 1) + '1"/>'); mc += nStages; });

    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<dimension ref="A1:' + colLetter(lastColN) + (rowNum - 1) + '"/>' +
      '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/><selection pane="bottomRight"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols><col min="1" max="1" width="26" customWidth="1"/><col min="2" max="' + lastColN + '" width="13" customWidth="1"/></cols>' +
      "<sheetData>" + rows.join("") + "</sheetData>" +
      '<mergeCells count="' + merges.length + '">' + merges.join("") + "</mergeCells></worksheet>";

    var enc = new TextEncoder();
    var zip = zipStore([
      { name: "[Content_Types].xml", data: enc.encode(XLSX_CONTENT_TYPES) },
      { name: "_rels/.rels", data: enc.encode(XLSX_ROOT_RELS) },
      { name: "xl/workbook.xml", data: enc.encode(XLSX_WORKBOOK) },
      { name: "xl/_rels/workbook.xml.rels", data: enc.encode(XLSX_WORKBOOK_RELS) },
      { name: "xl/styles.xml", data: enc.encode(styles.xml) },
      { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheet) }
    ]);
    return new Blob([zip], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  root.LarkCore = {
    FIELD_TYPE: FIELD_TYPE,
    detectHandover: detectHandover,
    buildHandover: buildHandover,
    diagnoseHandover: diagnoseHandover,
    renderHandover: renderHandover,
    buildHandoverHTML: buildHandoverHTML,
    buildHandoverXLSX: buildHandoverXLSX,
    personColor: personColor,
    personColorMap: personColorMap,
    PERSON_PALETTE: PERSON_PALETTE,
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
