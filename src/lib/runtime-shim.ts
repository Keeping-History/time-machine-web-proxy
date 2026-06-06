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
 * (`/web/<url>`), matching the server-side url-rewriter behaviour so all
 * navigation falls through to the configured default time.
 */
export const generateShimScript = (
	ts: string,
	originalUrl: string,
	lockTime = false,
): string => `(function () {
  var meta = document.querySelector('meta[name="wayback-context"]');
  var _ts = (meta && meta.getAttribute('data-ts')) || ${JSON.stringify(ts)};
  var _orig = (meta && meta.getAttribute('data-url')) || ${JSON.stringify(originalUrl)};
  var _lock = (meta && meta.getAttribute('data-lock-time') === 'true') || ${JSON.stringify(lockTime)};

  // Opaque/non-network schemes that must never be rewritten.
  var SKIP_RE = /^(?:data:|blob:|javascript:|mailto:|tel:|sms:|about:|#)/i;
  // Wayback wrappers embedded in cached JS/HTML (the downloader fetches via
  // wayback's default mode, which rewrites URLs to /web/<ts>[mod_]/<url> form
  // inside JS bodies). Without unwrapping these, the browser issues
  // doubly-wrapped paths the proxy 404s on:
  //   /web/<page-ts>im_/<archive-host>/web/<inner-ts>/<url>
  var WAYBACK_ABS_RE = /^(?:https?:)?\\/\\/web\\.archive\\.org\\/web\\/(\\d{1,14})(?:[a-z]{1,3}_)?\\/(https?:\\/\\/.+)$/i;

  function rewrite(url) {
    if (!url || typeof url !== 'string') return url;
    var trimmed = url.trim();
    if (!trimmed) return url;
    // Opaque schemes: pass through unchanged.
    if (SKIP_RE.test(trimmed)) return url;
    // Wayback-wrapped (absolute or protocol-relative): unwrap to the embedded
    // (ts, url) and emit a clean path-form URL the proxy understands.
    var wm = trimmed.match(WAYBACK_ABS_RE);
    if (wm) return _lock ? '/web/' + wm[2] : '/web/' + wm[1] + '/' + wm[2];
    // Already proxied: idempotent pass-through.
    if (trimmed.indexOf('/web/') === 0) return url;
    // Resolve relative URLs against the original page URL.
    var absolute;
    try {
      absolute = new URL(trimmed, _orig).href;
    } catch (e) {
      return url;
    }
    // Only rewrite http/https.
    if (absolute.indexOf('http://') !== 0 && absolute.indexOf('https://') !== 0) return url;
    return _lock ? '/web/' + absolute : '/web/' + _ts + 'im_/' + absolute;
  }

  // --- window.fetch ---
  var _origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      input = rewrite(input);
    } else if (input && typeof input === 'object' && typeof input.url === 'string') {
      input = new Request(rewrite(input.url), input);
    }
    return _origFetch.call(this, input, init);
  };

  // --- XMLHttpRequest.prototype.open ---
  var _origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
    var rewritten = rewrite(typeof url === 'string' ? url : String(url));
    if (arguments.length <= 2) {
      return _origXhrOpen.call(this, method, rewritten);
    }
    return _origXhrOpen.call(this, method, rewritten, async, user, password);
  };

  // --- Element src/href setters ---
  var PATCHES = [
    [HTMLImageElement.prototype, 'src'],
    [HTMLScriptElement.prototype, 'src'],
    [HTMLIFrameElement.prototype, 'src'],
    [HTMLLinkElement.prototype, 'href'],
    [HTMLAnchorElement.prototype, 'href'],
  ];

  PATCHES.forEach(function (pair) {
    var proto = pair[0];
    var prop = pair[1];
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    var origSetter = desc.set;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function (val) {
        origSetter.call(this, rewrite(val));
      },
    });
  });

  // --- document.write / document.writeln ---
  var ATTR_RE = /((?:src|href)s*=s*)(["'])([^"']+)\\2/gi;

  function rewriteHtmlString(html) {
    return html.replace(ATTR_RE, function (match, prefix, quote, url) {
      return prefix + quote + rewrite(url) + quote;
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

  // --- location.href / location.assign / location.replace ---
  // Intercepts JavaScript-driven navigation so redirects like
  //   location.href = 'http://www.aol.com'
  //   location.assign('...')
  //   location.replace('...')
  // stay inside the proxy instead of escaping to the live web.
  // window.location = url is sugar for location.href = url in browsers, so
  // patching Location.prototype.href covers that case as well.
  var _locHrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
  if (_locHrefDesc && _locHrefDesc.set && _locHrefDesc.configurable) {
    Object.defineProperty(Location.prototype, 'href', {
      configurable: true,
      enumerable: _locHrefDesc.enumerable,
      get: _locHrefDesc.get,
      set: function(val) {
        _locHrefDesc.set.call(this, rewrite(String(val)));
      }
    });
  }
  var _origLocAssign = Location.prototype.assign;
  Location.prototype.assign = function(url) {
    return _origLocAssign.call(this, rewrite(String(url)));
  };
  var _origLocReplace = Location.prototype.replace;
  Location.prototype.replace = function(url) {
    return _origLocReplace.call(this, rewrite(String(url)));
  };

  // --- MutationObserver: catch dynamically-inserted nodes ---
  var URL_ATTRS = ['src', 'href'];

  function rewriteNode(node) {
    if (node.nodeType !== 1) return; // elements only
    URL_ATTRS.forEach(function (attr) {
      var val = node.getAttribute && node.getAttribute(attr);
      if (val) {
        var rw = rewrite(val);
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
