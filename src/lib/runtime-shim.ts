// DEFERRED (2026-05-23) — Web Worker URLs (new Worker(...)) are not intercepted by this shim.

/**
 * Generates a self-contained JS IIFE string that, when injected into a page,
 * patches runtime URL-building APIs so archived pages work correctly through
 * the proxy.
 *
 * The shim reads its configuration from:
 *   <meta name="wayback-context" data-ts="<timestamp>" data-url="<originalUrl>"
 *         data-lock-time="<true|false>">
 *
 * Patched APIs:
 *   - window.fetch
 *   - XMLHttpRequest.prototype.open
 *   - HTMLImageElement, HTMLScriptElement, HTMLLinkElement, HTMLIFrameElement,
 *     HTMLAnchorElement src/href setters
 *   - document.write / document.writeln
 *   - MutationObserver on document.documentElement (catches dynamic inserts)
 *
 * When `lockTime` is true, generated proxy paths omit the timestamp segment
 * (`/web/<url>`) ONLY for navigation links (anchor href, iframe/frame src),
 * matching the server-side url-rewriter so navigation falls through to the
 * configured default time. Asset URLs (img/script/css/fetch/XHR) always keep
 * their timestamp so they resolve to the exact captured snapshot.
 */
export const generateShimScript = (
	ts: string,
	originalUrl: string,
	lockTime = false,
	proxyBase = "",
): string => `(function () {
  var meta = document.querySelector('meta[name="wayback-context"]');
  var _ts = (meta && meta.getAttribute('data-ts')) || ${JSON.stringify(ts)};
  var _orig = (meta && meta.getAttribute('data-url')) || ${JSON.stringify(originalUrl)};
  var _lock = (meta && meta.getAttribute('data-lock-time') === 'true') || ${JSON.stringify(lockTime)};
  var _base = (meta && meta.getAttribute('data-proxy-base')) || ${JSON.stringify(proxyBase)};

  // Opaque/non-network schemes that must never be rewritten.
  var SKIP_RE = /^(?:data:|blob:|javascript:|mailto:|tel:|sms:|about:|#)/i;
  // Wayback wrappers embedded in cached JS/HTML (the downloader fetches via
  // wayback's default mode, which rewrites URLs to /web/<ts>[mod_]/<url> form
  // inside JS bodies). Without unwrapping these, the browser issues
  // doubly-wrapped paths the proxy 404s on:
  //   /web/<page-ts>im_/<archive-host>/web/<inner-ts>/<url>
  var WAYBACK_ABS_RE = /^(?:https?:)?\\/\\/web\\.archive\\.org\\/web\\/(\\d{1,14})(?:[a-z]{1,3}_)?\\/(https?:\\/\\/.+)$/i;

  // isLink marks a navigation target (anchor href, iframe/frame src). lockTime
  // strips the timestamp from those only; assets (the default, isLink falsey)
  // always keep their snapshot timestamp.
  function isNavTag(tag, attr) {
    tag = (tag || '').toLowerCase();
    if (attr === 'href') return tag === 'a' || tag === 'area';
    if (attr === 'src') return tag === 'iframe' || tag === 'frame';
    return false;
  }

  // Prepend the configured proxyBase so emitted URLs are ABSOLUTE, mirroring the
  // server-side url-rewriter's buildProxyUrl. When pages are embedded cross-origin
  // (e.g. inside beta.911realtime.org or reached via the box DNS dev.keepinghistory.org),
  // a root-relative /web/... path resolves against the embedding/browsing host
  // instead of the canonical proxy host. Absolute output pins every runtime-built
  // URL to proxyBase. When proxyBase is unset, output stays root-relative (the
  // backward-compatible direct-proxy default).
  function proxify(path) {
    return _base ? _base + path : path;
  }

  function rewrite(url, isLink) {
    if (!url || typeof url !== 'string') return url;
    var trimmed = url.trim();
    if (!trimmed) return url;
    // Opaque schemes: pass through unchanged.
    if (SKIP_RE.test(trimmed)) return url;
    var lock = _lock && !!isLink;
    // Wayback-wrapped (absolute or protocol-relative): unwrap to the embedded
    // (ts, url) and emit a clean proxy URL the proxy understands.
    var wm = trimmed.match(WAYBACK_ABS_RE);
    if (wm) return proxify(lock ? '/web/' + wm[2] : '/web/' + wm[1] + '/' + wm[2]);
    // Already an absolute proxy URL pointing at proxyBase (emitted by the
    // server-side url-rewriter, or by a previous pass of this shim): leave it
    // untouched. It is already in canonical absolute form — stripping it back to
    // a root-relative path would re-introduce the cross-origin leak, and
    // re-wrapping it would double-wrap as /web/<ts>im_/<proxyBase>/web/...
    if (_base && trimmed.indexOf(_base + '/web/') === 0) return url;
    // Root-relative proxy path: idempotent, but upgrade to absolute when
    // proxyBase is set so it resolves against the proxy host, not the embedder.
    if (trimmed.indexOf('/web/') === 0) return _base ? _base + trimmed : url;
    // Resolve relative URLs against the original page URL.
    var absolute;
    try {
      absolute = new URL(trimmed, _orig).href;
    } catch (e) {
      return url;
    }
    // Only rewrite http/https.
    if (absolute.indexOf('http://') !== 0 && absolute.indexOf('https://') !== 0) return url;
    return proxify(lock ? '/web/' + absolute : '/web/' + _ts + 'im_/' + absolute);
  }

  // --- window.fetch ---
  var _origFetch = window.fetch;
  window.fetch = function (input, init) {
    // fetch targets are subresources/APIs → assets, keep the timestamp.
    if (typeof input === 'string') {
      input = rewrite(input, false);
    } else if (input && typeof input === 'object' && typeof input.url === 'string') {
      input = new Request(rewrite(input.url, false), input);
    }
    return _origFetch.call(this, input, init);
  };

  // --- XMLHttpRequest.prototype.open ---
  var _origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
    // XHR targets are assets/APIs → keep the timestamp.
    var rewritten = rewrite(typeof url === 'string' ? url : String(url), false);
    if (arguments.length <= 2) {
      return _origXhrOpen.call(this, method, rewritten);
    }
    return _origXhrOpen.call(this, method, rewritten, async, user, password);
  };

  // --- Element src/href setters ---
  // Third element marks navigation targets (anchor href, iframe src) whose date
  // is hidden under lockTime; img/script src and link href are assets (false).
  var PATCHES = [
    [HTMLImageElement.prototype, 'src', false],
    [HTMLScriptElement.prototype, 'src', false],
    [HTMLIFrameElement.prototype, 'src', true],
    [HTMLLinkElement.prototype, 'href', false],
    [HTMLAnchorElement.prototype, 'href', true],
  ];

  PATCHES.forEach(function (pair) {
    var proto = pair[0];
    var prop = pair[1];
    var isLink = pair[2];
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    var origSetter = desc.set;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function (val) {
        origSetter.call(this, rewrite(val, isLink));
      },
    });
  });

  // --- document.write / document.writeln ---
  var ATTR_RE = /((?:src|href)\\s*=\\s*)(["'])([^"']+)\\2/gi;

  function rewriteHtmlString(html) {
    // The regex sees the attribute but not its element, so we can't tell an
    // <a href> from a <link href>. Treat document.write URLs as assets (keep
    // the timestamp); statically-authored links are handled server-side and
    // .href assignments by the setter patch above.
    return html.replace(ATTR_RE, function (match, prefix, quote, url) {
      return prefix + quote + rewrite(url, false) + quote;
    });
  }

  var _origWrite = document.write.bind(document);
  var _origWriteln = document.writeln.bind(document);
  document.write = function (html) {
    return _origWrite(rewriteHtmlString(String(html)));
  };
  document.writeln = function (html) {
    return _origWriteln(rewriteHtmlString(String(html)));
  };

  // --- MutationObserver: catch dynamically-inserted nodes ---
  var URL_ATTRS = ['src', 'href'];

  function rewriteNode(node) {
    if (node.nodeType !== 1) return; // elements only
    URL_ATTRS.forEach(function (attr) {
      var val = node.getAttribute && node.getAttribute(attr);
      if (val) {
        var rw = rewrite(val, isNavTag(node.tagName, attr));
        if (rw !== val) node.setAttribute(attr, rw);
      }
    });
  }

  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(function (node) {
        rewriteNode(node);
        if (node.querySelectorAll) {
          node.querySelectorAll('[src],[href]').forEach(rewriteNode);
        }
      });
    });
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();`;
