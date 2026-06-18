// Runs in the PAGE context (not the isolated content-script world) so it can
// patch the page's own fetch / XMLHttpRequest. Lark Base loads its table data
// as JSON over the network; we capture those responses and forward them to the
// content script via window.postMessage. We never modify requests or responses.
(function () {
  "use strict";
  if (window.__larkAnalyticsInjected) return;
  window.__larkAnalyticsInjected = true;

  var MAX_BODY = 8 * 1024 * 1024; // ignore huge payloads

  function send(url, body) {
    try {
      window.postMessage(
        { source: "lark-analytics-interceptor", type: "capture", url: String(url || ""), body: body },
        "*"
      );
    } catch (e) {}
  }

  // Forward the records request template (url + headers) so the content script can
  // replay it with different offset/limit to fetch every page.
  function sendReq(url, headers) {
    try {
      window.postMessage(
        { source: "lark-analytics-interceptor", type: "request", url: String(url || ""), headers: headers || {} },
        "*"
      );
    } catch (e) {}
  }

  function headersToObj(h) {
    var out = {};
    try {
      if (!h) return out;
      if (typeof h.forEach === "function") h.forEach(function (v, k) { out[k] = v; });
      else if (Array.isArray(h)) h.forEach(function (pair) { out[pair[0]] = pair[1]; });
      else Object.keys(h).forEach(function (k) { out[k] = h[k]; });
    } catch (e) {}
    return out;
  }

  // Heuristic: only forward responses that plausibly contain Base table data,
  // to keep noise down. We look at the URL and a slice of the body.
  function looksRelevant(url, body) {
    if (typeof body !== "string" || !body.length || body.length > MAX_BODY) return false;
    if (body[0] !== "{" && body[0] !== "[") return false;
    var u = String(url || "");
    if (/record|table|view|bitable|grid|cell|field/i.test(u)) return true;
    var head = body.slice(0, 2000);
    return /"record_id"|"recordId"|"fields"|"field_id"|"field_name"/.test(head);
  }

  // ---- patch fetch ----
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function () {
      var args = arguments;
      var input = args[0], init = args[1];
      var url = input && input.url ? input.url : input;
      if (/\/records\?/.test(String(url))) {
        var h = (init && init.headers) || (input && input.headers);
        sendReq(String(url), headersToObj(h));
      }
      return origFetch.apply(this, args).then(function (res) {
        try {
          var ct = (res.headers && res.headers.get("content-type")) || "";
          if (ct.indexOf("json") !== -1) {
            res.clone().text().then(function (txt) {
              if (looksRelevant(url, txt)) send(url, txt);
            }).catch(function () {});
          }
        } catch (e) {}
        return res;
      });
    };
  }

  // ---- patch XMLHttpRequest ----
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__larkUrl = url; this.__larkHeaders = {}; } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__larkHeaders) this.__larkHeaders[k] = v; } catch (e) {}
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      var xhr = this;
      if (/\/records\?/.test(String(xhr.__larkUrl || ""))) sendReq(String(xhr.__larkUrl), xhr.__larkHeaders || {});
      xhr.addEventListener("load", function () {
        try {
          var ct = xhr.getResponseHeader("content-type") || "";
          var rt = (xhr.responseType === "" || xhr.responseType === "text") ? xhr.responseText : null;
          if (ct.indexOf("json") !== -1 && typeof rt === "string" && looksRelevant(xhr.__larkUrl, rt)) {
            send(xhr.__larkUrl, rt);
          }
        } catch (e) {}
      });
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
})();
