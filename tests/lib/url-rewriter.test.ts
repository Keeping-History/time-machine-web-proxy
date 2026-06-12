import {
	discoverNavLinks,
	type DiscoveredAsset,
	parseWaybackPath,
	rewriteCssUrls,
	rewriteHtmlUrls,
	sanitizeTimeParam,
	stripWaybackToolbar,
	unwrapNestedProxyUrl,
} from "../../src/lib/url-rewriter";

const TARGET = "http://www.apple.com/products/iphone";
const TIME = "20200101000000";

const enc = (s: string) => encodeURIComponent(s);

describe("sanitizeTimeParam", () => {
	it("returns the value when it is a 14-digit timestamp", () => {
		expect(sanitizeTimeParam("20231015120000", "20000101000000")).toBe("20231015120000");
	});

	it("returns defaultTime when rawTime is null", () => {
		expect(sanitizeTimeParam(null, "20000101000000")).toBe("20000101000000");
	});

	it("returns defaultTime when rawTime is empty string", () => {
		expect(sanitizeTimeParam("", "20000101000000")).toBe("20000101000000");
	});

	it("throws on non-14-digit string", () => {
		expect(() => sanitizeTimeParam("2023", "20000101000000")).toThrow("Invalid time parameter");
	});
});

describe("unwrapNestedProxyUrl", () => {
	it("returns unchanged url and fallback time when not a proxy URL", () => {
		expect(unwrapNestedProxyUrl("http://example.com/page", TIME, "proxy.local")).toEqual({
			url: "http://example.com/page",
			time: TIME,
		});
	});

	it("extracts inner url and time from a legacy ?url=&time= proxy URL", () => {
		const inner = "http://example.com/page";
		const innerTime = "20191231235959";
		const proxyUrl = `http://proxy.local/?url=${enc(inner)}&time=${innerTime}`;
		expect(unwrapNestedProxyUrl(proxyUrl, TIME, "proxy.local")).toEqual({
			url: inner,
			time: innerTime,
		});
	});

	it("uses fallbackTime when legacy proxy URL has no time param", () => {
		const inner = "http://example.com/page";
		const proxyUrl = `http://proxy.local/?url=${enc(inner)}`;
		expect(unwrapNestedProxyUrl(proxyUrl, TIME, "proxy.local")).toEqual({
			url: inner,
			time: TIME,
		});
	});

	it("falls back to fallbackTime when legacy proxy URL time is non-numeric", () => {
		const inner = "http://example.com/page";
		const proxyUrl = `http://proxy.local/?url=${enc(inner)}&time=not-a-timestamp`;
		expect(unwrapNestedProxyUrl(proxyUrl, TIME, "proxy.local")).toEqual({
			url: inner,
			time: TIME,
		});
	});

	it("falls back to fallbackTime when legacy proxy URL time has wrong digit length", () => {
		const inner = "http://example.com/page";
		const proxyUrl = `http://proxy.local/?url=${enc(inner)}&time=20200101`;
		expect(unwrapNestedProxyUrl(proxyUrl, TIME, "proxy.local")).toEqual({
			url: inner,
			time: TIME,
		});
	});

	it("extracts inner url and time from a /web/<ts>/<url> proxy URL", () => {
		const proxyUrl = "http://proxy.local/web/20191231235959/http://example.com/page";
		expect(unwrapNestedProxyUrl(proxyUrl, TIME, "proxy.local")).toEqual({
			url: "http://example.com/page",
			time: "20191231235959",
		});
	});

	it("preserves the target URL's query string when unwrapping path-based format", () => {
		const proxyUrl = "http://proxy.local/web/20191231235959/http://example.com/page?x=1&y=2";
		expect(unwrapNestedProxyUrl(proxyUrl, TIME, "proxy.local")).toEqual({
			url: "http://example.com/page?x=1&y=2",
			time: "20191231235959",
		});
	});

	it("tolerates a modifier in nested path-based proxy URL", () => {
		const proxyUrl = "http://proxy.local/web/20191231235959im_/http://example.com/img.png";
		expect(unwrapNestedProxyUrl(proxyUrl, TIME, "proxy.local")).toEqual({
			url: "http://example.com/img.png",
			time: "20191231235959",
		});
	});

	it("returns original url for non-parseable string", () => {
		expect(unwrapNestedProxyUrl("not-a-url", TIME, "proxy.local")).toEqual({
			url: "not-a-url",
			time: TIME,
		});
	});

	it("does NOT unwrap when host does not match proxyBaseHostname", () => {
		const proxyUrl = "http://other.host/web/20191231235959/http://example.com/page";
		expect(unwrapNestedProxyUrl(proxyUrl, TIME, "proxy.local")).toEqual({
			url: proxyUrl,
			time: TIME,
		});
	});
});

describe("parseWaybackPath", () => {
	it("parses /web/{14-digit-ts}/{url} with no modifier", () => {
		expect(parseWaybackPath("/web/20020401000000/http://www.apple.com/")).toEqual({
			time: "20020401000000",
			url: "http://www.apple.com/",
		});
	});

	it("parses /web/{ts}im_/{url} — strips modifier", () => {
		expect(parseWaybackPath("/web/20020401000000im_/http://www.apple.com/logo.png")).toEqual({
			time: "20020401000000",
			url: "http://www.apple.com/logo.png",
		});
	});

	it("parses /web/{ts}cs_/{url} — strips modifier", () => {
		expect(parseWaybackPath("/web/20020401000000cs_/http://www.apple.com/main.css")).toEqual({
			time: "20020401000000",
			url: "http://www.apple.com/main.css",
		});
	});

	it("preserves target URL query string when present in raw path", () => {
		expect(parseWaybackPath("/web/20020401000000/http://example.com/?foo=bar&baz=qux")).toEqual({
			time: "20020401000000",
			url: "http://example.com/?foo=bar&baz=qux",
		});
	});

	it("returns null for non-/web paths", () => {
		expect(parseWaybackPath("/?url=http%3A%2F%2Fexample.com&time=20020401000000")).toBeNull();
		expect(parseWaybackPath("/health")).toBeNull();
		expect(parseWaybackPath("/")).toBeNull();
	});

	it("returns null when timestamp is not exactly 14 digits", () => {
		expect(parseWaybackPath("/web/2002/http://www.apple.com/")).toBeNull();
		expect(parseWaybackPath("/web/123456789012345/http://www.apple.com/")).toBeNull();
	});

	it("returns null when URL segment is empty", () => {
		expect(parseWaybackPath("/web/20020401000000/")).toBeNull();
	});

	it("parses /web/{url} with no timestamp — time defaults to null", () => {
		expect(parseWaybackPath("/web/http://www.apple.com/")).toEqual({
			time: null,
			url: "http://www.apple.com/",
		});
	});

	it("parses /web/{url} with no timestamp for https targets", () => {
		expect(parseWaybackPath("/web/https://example.com/page?x=1&y=2")).toEqual({
			time: null,
			url: "https://example.com/page?x=1&y=2",
		});
	});
});

describe("rewriteHtmlUrls — archive-prefixed URLs", () => {
	it("rewrites absolute web.archive.org URL with no modifier", () => {
		const html = `<a href="https://web.archive.org/web/20191231235959/http://example.com/page">x</a>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/page`);
	});

	it("rewrites absolute web.archive.org URL with im_ modifier", () => {
		const html = `<img src="https://web.archive.org/web/20191231235959im_/http://example.com/img.png">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/img.png`);
	});

	it("rewrites absolute web.archive.org URL with cs_ modifier", () => {
		const html = `<link rel="stylesheet" href="https://web.archive.org/web/20191231235959cs_/http://example.com/main.css">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/main.css`);
	});

	it("rewrites relative /web/<ts>/<url>", () => {
		const html = `<a href="/web/20191231235959/http://example.com/page">x</a>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/page`);
	});

	it("rewrites relative /web/<ts>im_/<url>", () => {
		const html = `<img src="/web/20191231235959im_/http://example.com/img.png">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/img.png`);
	});

	it("rewrites protocol-relative //web.archive.org with im_ modifier (downloader form)", () => {
		const html = `<img src="//web.archive.org/web/20191231235959im_/http://example.com/img.png">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/img.png`);
		expect(r).not.toContain(`web.archive.org`);
	});

	it("rewrites protocol-relative //web.archive.org with no modifier", () => {
		const html = `<a href="//web.archive.org/web/20191231235959/http://example.com/page">x</a>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/page`);
		expect(r).not.toContain(`web.archive.org`);
	});

	it("rewrites protocol-relative //web.archive.org with cs_ modifier in <link>", () => {
		const html = `<link rel="stylesheet" href="//web.archive.org/web/20191231235959cs_/http://example.com/main.css">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/main.css`);
		expect(r).not.toContain(`web.archive.org`);
	});

	it("rewrites protocol-relative //web.archive.org cross-origin asset (not page host)", () => {
		const html = `<img src="//web.archive.org/web/20010913100802im_/http://i.ihost.com/i/c.gif">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20010913100802/http://i.ihost.com/i/c.gif`);
		expect(r).not.toContain(`web.archive.org`);
	});
});

describe("rewriteHtmlUrls — relative URLs resolved against targetUrl", () => {
	it("resolves path-absolute relative URL against targetUrl", () => {
		const html = `<img src="/images/foo.png">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/images/foo.png`);
	});

	it("resolves document-relative URL against targetUrl directory", () => {
		const html = `<img src="foo.png">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/products/foo.png`);
	});

	it("preserves already-absolute non-archive URL but wraps it", () => {
		const html = `<a href="https://example.com/other">x</a>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/https://example.com/other`);
	});
});

describe("rewriteHtmlUrls — covers all URL-bearing tags", () => {
	it("rewrites <a href>", () => {
		const { html: r } = rewriteHtmlUrls(`<a href="/x">x</a>`, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/x`);
	});

	it("rewrites <link href>", () => {
		const { html: r } = rewriteHtmlUrls(
			`<link rel="stylesheet" href="/css/main.css">`,
			TARGET,
			TIME,
		);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/css/main.css`);
	});

	it("rewrites <script src>", () => {
		const { html: r } = rewriteHtmlUrls(`<script src="/js/app.js"></script>`, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/js/app.js`);
	});

	it("rewrites <iframe src>", () => {
		const { html: r } = rewriteHtmlUrls(`<iframe src="/embed"></iframe>`, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/embed`);
	});

	it("rewrites <form action>", () => {
		const { html: r } = rewriteHtmlUrls(`<form action="/submit"></form>`, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/submit`);
	});

	it("rewrites <video src> and <audio src>", () => {
		const { html: r } = rewriteHtmlUrls(
			`<video src="/v.mp4"></video><audio src="/a.mp3"></audio>`,
			TARGET,
			TIME,
		);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/v.mp4`);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/a.mp3`);
	});
});

describe("rewriteHtmlUrls — srcset", () => {
	it("rewrites <img srcset> with descriptors", () => {
		const html = `<img srcset="/a.png 1x, /b.png 2x" src="/default.png">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/a.png`);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/b.png`);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/default.png`);
		expect(r).toMatch(/1x/);
		expect(r).toMatch(/2x/);
	});

	it("rewrites <source srcset> with width descriptors", () => {
		const html = `<source srcset="/s.png 480w, /l.png 1024w">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/s.png`);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/l.png`);
		expect(r).toMatch(/480w/);
		expect(r).toMatch(/1024w/);
	});
});

describe("rewriteHtmlUrls — inline style url()", () => {
	it("rewrites url(...) inside style attribute", () => {
		const html = `<div style="background: url('/img/bg.png')">x</div>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/img/bg.png`);
	});
});

describe("rewriteHtmlUrls — schemes left alone", () => {
	it("leaves data: URIs untouched", () => {
		const html = `<img src="data:image/png;base64,iVBORw0KGgo=">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`src="data:image/png;base64,iVBORw0KGgo="`);
	});

	it("leaves mailto: untouched", () => {
		const { html: r } = rewriteHtmlUrls(`<a href="mailto:x@y.com">m</a>`, TARGET, TIME);
		expect(r).toContain(`href="mailto:x@y.com"`);
	});

	it("leaves javascript: untouched", () => {
		const { html: r } = rewriteHtmlUrls(`<a href="javascript:void(0)">j</a>`, TARGET, TIME);
		expect(r).toContain(`href="javascript:void(0)"`);
	});

	it("leaves tel: untouched", () => {
		const { html: r } = rewriteHtmlUrls(`<a href="tel:+15551234">t</a>`, TARGET, TIME);
		expect(r).toContain(`href="tel:+15551234"`);
	});

	it("leaves fragment-only URLs untouched", () => {
		const { html: r } = rewriteHtmlUrls(`<a href="#top">x</a>`, TARGET, TIME);
		expect(r).toContain(`href="#top"`);
	});

	it.each([
		["sms:+15551234", "sms"],
		["ftp://example.com/x", "ftp"],
		["geo:37.78,-122.4", "geo"],
		["ws://example.com/sock", "ws"],
		["wss://example.com/sock", "wss"],
		["magnet:?xt=urn:btih:abc", "magnet"],
		["view-source:http://example.com/", "view-source"],
		["chrome://settings/", "chrome"],
		["file:///etc/hosts", "file"],
		["blob:https://example.com/abc", "blob"],
		["about:blank", "about"],
	])("leaves %s URLs untouched (scheme %s)", (uri) => {
		const { html: r } = rewriteHtmlUrls(`<a href="${uri}">x</a>`, TARGET, TIME);
		expect(r).toContain(`href="${uri}"`);
	});
});

// Wayback indexed CDN-fronted assets under the CDN URL (the key the original
// page used). Rewriting must preserve that key so the browser asks Wayback for
// the URL Wayback actually has. ProxyService.fetch handles the rare inverse
// case — CDN URL not in archive but bare origin is — via a 404 retry with
// extractCdnEmbeddedUrl. These tests pin the rewriter to the recoverable
// order: CDN URL first, origin only when needed.
describe("rewriteHtmlUrls — CDN URLs preserved (Wayback indexed under CDN key)", () => {
	it("preserves an Akamai URL on <img src> so the browser requests the indexed CDN key", () => {
		const html = `<img src="http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/images/newmain/top.main.special.report.gif">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(
			`/web/${TIME}/http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/images/newmain/top.main.special.report.gif`,
		);
		expect(r).not.toContain(`/web/${TIME}/http://www.cnn.com/images/`);
	});

	it("preserves an Akamai URL inside a wayback-prefixed wrapper and the wrapper's TS", () => {
		const ts = "20011201213912";
		const html = `<img src="https://web.archive.org/web/${ts}im_/http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/images/newmain/top.main.special.report.gif">`;
		const { html: r, discoveredAssets } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(
			`/web/${ts}/http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/images/newmain/top.main.special.report.gif`,
		);
		expect(discoveredAssets).toContainEqual<DiscoveredAsset>({
			url: "http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/images/newmain/top.main.special.report.gif",
			embeddedTs: ts,
		});
	});

	it("preserves Akamai URLs inside srcset entries", () => {
		const html = `<img srcset="http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/a.png 1x, http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/b.png 2x">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/a.png`);
		expect(r).toContain(`/web/${TIME}/http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/b.png`);
	});

	it("preserves an Akamai URL inside an inline style url()", () => {
		const html = `<div style="background: url('http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/bg.png')">x</div>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/bg.png`);
	});

	it("preserves a non-CDN absolute URL unchanged through the rewrite path", () => {
		const html = `<a href="http://images.example.com/photo.jpg">x</a>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://images.example.com/photo.jpg`);
	});

	// Regression: 2001 apple.com homepage served every t/2001/us/en/i/*.gif from
	// a772.g.akamai.net. The bare http://www.apple.com/t/... URL was never
	// archived; stripping the CDN wrapper here previously caused every nav-bar
	// image to 404 against Wayback.
	it("preserves Akamai-wrapped apple.com nav images so they resolve against Wayback", () => {
		const ts = "20010917011416";
		const html = `<img src="https://web.archive.org/web/${ts}im_/http://a772.g.akamai.net/7/772/51/822294b0908aa4/www.apple.com/t/2001/us/en/i/1c.gif">`;
		const { html: r, discoveredAssets } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(
			`/web/${ts}/http://a772.g.akamai.net/7/772/51/822294b0908aa4/www.apple.com/t/2001/us/en/i/1c.gif`,
		);
		expect(r).not.toContain(`http://www.apple.com/t/2001/us/en/i/1c.gif`);
		expect(discoveredAssets).toContainEqual<DiscoveredAsset>({
			url: "http://a772.g.akamai.net/7/772/51/822294b0908aa4/www.apple.com/t/2001/us/en/i/1c.gif",
			embeddedTs: ts,
		});
	});
});

describe("rewriteCssUrls — CDN URLs preserved (Wayback indexed under CDN key)", () => {
	it("preserves an Akamai URL in a CSS url() reference", () => {
		const css = `body { background: url(http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/bg.png); }`;
		const r = rewriteCssUrls(css, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://a388.g.akamai.net/f/388/21/1d/www.cnn.com/bg.png`);
	});
});

describe("rewriteHtmlUrls — <base href> handling", () => {
	it("strips the <base> tag from the output", () => {
		const html = `<html><head><base href="https://cdn.example.com/"></head><body></body></html>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).not.toMatch(/<base\b/i);
	});

	it("honors <base href> as the effective base for relative-URL resolution", () => {
		const html = `<html><head><base href="https://cdn.example.com/"></head><body><a href="/x">x</a></body></html>`;
		// Without honoring base, relative "/x" would resolve against TARGET
		// (www.apple.com). With base honored, it resolves against cdn.example.com.
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/https://cdn.example.com/x`);
		expect(r).not.toContain(`/web/${TIME}/http://www.apple.com/x`);
	});

	it("unwraps a wayback-wrapped <base href> before resolving relative URLs", () => {
		// Wayback injects this shape of <base> on many archived pages. Without
		// unwrapping, "r/ar" resolves to https://web.archive.org/web/<inner>/
		// http://www.yahoo.com/r/ar and gets re-proxied verbatim.
		const html = `<html><head><base href="https://web.archive.org/web/20010913013843/http://www.yahoo.com/" target="_top"></head><body><a href="r/ar">x</a></body></html>`;
		const { html: r } = rewriteHtmlUrls(html, "http://www.yahoo.com/", TIME);
		expect(r).toContain(`href="/web/${TIME}/http://www.yahoo.com/r/ar"`);
		expect(r).not.toContain(`/web/${TIME}/https://web.archive.org`);
	});

	it("unwraps a protocol-relative wayback <base href>", () => {
		const html = `<html><head><base href="//web.archive.org/web/20010913013843/http://www.yahoo.com/"></head><body><a href="r/ar">x</a></body></html>`;
		const { html: r } = rewriteHtmlUrls(html, "http://www.yahoo.com/", TIME);
		expect(r).toContain(`href="/web/${TIME}/http://www.yahoo.com/r/ar"`);
		expect(r).not.toContain(`/web/${TIME}//web.archive.org`);
	});
});

describe("rewriteHtmlUrls — <meta http-equiv='refresh'>", () => {
	it("rewrites the url= portion of meta refresh content", () => {
		const html = `<meta http-equiv="refresh" content="5;url=/foo">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/foo`);
	});

	it("leaves meta refresh without url= unchanged", () => {
		const html = `<meta http-equiv="refresh" content="5">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`content="5"`);
	});

	it("does not touch non-refresh meta tags", () => {
		const html = `<meta name="description" content="visit /home">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`content="visit /home"`);
	});
});

describe("rewriteHtmlUrls — extended URL-bearing attributes", () => {
	it.each([
		[`<blockquote cite="/q">x</blockquote>`, "cite"],
		[`<q cite="/q">x</q>`, "cite"],
		[`<del cite="/q">x</del>`, "cite"],
		[`<ins cite="/q">x</ins>`, "cite"],
		[`<html manifest="/app.appcache"></html>`, "manifest"],
		[`<body background="/bg.png"></body>`, "background"],
		[`<table background="/tbg.png"></table>`, "background"],
		[`<img longdesc="/desc.html" src="/i.png">`, "longdesc"],
	])("rewrites %s (%s)", (html, attr) => {
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toMatch(new RegExp(`${attr}="\\/web\\/\\d{14}\\/`));
	});
});

describe("rewriteHtmlUrls — output is path-based", () => {
	it("rewritten URLs start with /web/, not the proxy host", () => {
		const html = `<a href="/foo"><img src="/bar"><script src="/baz"></script>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		// Each rewrite must produce an attribute value beginning with /web/{ts}/,
		// never a value that begins with http:// or https:// (which would mean
		// the proxy host got baked into the cached HTML).
		expect(r).not.toMatch(/(?:src|href)="https?:\/\//);
		expect(r).toMatch(/(?:src|href)="\/web\/\d{14}\//);
	});

	it("emits unencoded original URL inside the /web/<ts>/ path", () => {
		const html = `<a href="/foo">x</a>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		// The original URL is appended verbatim (no encodeURIComponent), so
		// the scheme separator and slashes survive intact.
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/foo`);
	});
});

describe("rewriteCssUrls", () => {
	it("rewrites absolute archive url() to path-based", () => {
		const css = `background: url('https://web.archive.org/web/20191231235959/http://example.com/img.png')`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME);
		expect(r).toContain(`url('/web/20191231235959/http://example.com/img.png')`);
	});

	it("rewrites relative archive url() to path-based", () => {
		const css = `background: url('/web/20191231235959/http://example.com/img.png')`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME);
		expect(r).toContain(`url('/web/20191231235959/http://example.com/img.png')`);
	});

	it("rewrites relative url() against targetUrl", () => {
		const css = `background: url('/img/bg.png')`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME);
		expect(r).toContain(`url('/web/${TIME}/http://example.com/img/bg.png')`);
	});

	it("leaves data: url() untouched", () => {
		const css = `background: url('data:image/png;base64,iVBORw0KGgo=')`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME);
		expect(r).toContain(`url('data:image/png;base64,iVBORw0KGgo=')`);
	});

	it("rewrites protocol-relative archive url() to path-based", () => {
		const css = `background: url('//web.archive.org/web/20191231235959im_/http://example.com/img.png')`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME);
		expect(r).toContain(`url('/web/20191231235959/http://example.com/img.png')`);
		expect(r).not.toContain(`web.archive.org`);
	});
});

describe("stripWaybackToolbar", () => {
	it("removes the Wayback toolbar insert", () => {
		const html = `<html><head></head><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div>toolbar</div><!-- END WAYBACK TOOLBAR INSERT --></body></html>`;
		expect(stripWaybackToolbar(html)).not.toContain("toolbar");
	});

	it("does NOT inject <base href>", () => {
		const html = `<html><head></head><body></body></html>`;
		expect(stripWaybackToolbar(html)).not.toContain("<base href");
	});

	it("strips the Wayback rewrite JS include block", () => {
		const html = `<html><head><script>before</script><!-- BEGIN Wayback Rewrite JS Include --><script>wb</script><!-- End Wayback Rewrite JS Include --><script>after</script></head></html>`;
		const r = stripWaybackToolbar(html);
		// The exact comment text in current impl ends with "End Wayback Rewrite JS Include";
		// the goal is that wayback's injected JS is gone.
		expect(r).not.toContain("wb");
	});
});

describe("rewriteHtmlUrls — discoveredAssets", () => {
	it("returns { html, discoveredAssets } shape and html is a non-empty string", () => {
		const result = rewriteHtmlUrls(`<a href="/x">x</a>`, TARGET, TIME);
		expect(result).toHaveProperty("html");
		expect(result).toHaveProperty("discoveredAssets");
		expect(typeof result.html).toBe("string");
		expect(Array.isArray(result.discoveredAssets)).toBe(true);
	});

	it("callers that ignore discoveredAssets still get correct html", () => {
		const { html } = rewriteHtmlUrls(`<a href="/x">x</a>`, TARGET, TIME);
		expect(html).toContain(`/web/${TIME}/http://www.apple.com/x`);
	});

	it("captures embedded TS from an absolute web.archive.org URL with im_ modifier", () => {
		const ts = "20030401120000";
		const html = `<img src="https://web.archive.org/web/${ts}im_/http://example.com/logo.png">`;
		const { discoveredAssets } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(discoveredAssets).toContainEqual<DiscoveredAsset>({
			url: "http://example.com/logo.png",
			embeddedTs: ts,
		});
	});

	it("captures embedded TS from a path-relative /web/<ts>/<url>", () => {
		const ts = "20030401120000";
		const html = `<a href="/web/${ts}/http://example.com/page">x</a>`;
		const { discoveredAssets } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(discoveredAssets).toContainEqual<DiscoveredAsset>({
			url: "http://example.com/page",
			embeddedTs: ts,
		});
	});

	it("plain relative URL without embedded TS is rewritten but not added to discoveredAssets", () => {
		const html = `<img src="/images/foo.png">`;
		const { html: out, discoveredAssets } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(out).toContain(`/web/${TIME}/http://www.apple.com/images/foo.png`);
		expect(discoveredAssets).toHaveLength(0);
	});

	it("deduplicates identical (url, embeddedTs) pairs", () => {
		const ts = "20030401120000";
		const ref = `href="/web/${ts}/http://example.com/page"`;
		const html = `<a ${ref}>x</a><a ${ref}>y</a>`;
		const { discoveredAssets } = rewriteHtmlUrls(html, TARGET, TIME);
		const matches = discoveredAssets.filter(
			(a) => a.url === "http://example.com/page" && a.embeddedTs === ts,
		);
		expect(matches).toHaveLength(1);
	});

	it("drops entries with a non-14-digit embedded TS and does not crash", () => {
		// RE_ARCHIVE_URL allows 1-14 digits in capture group 1; a short TS
		// must be filtered out, not stored.
		const html = `<a href="/web/2003/http://example.com/page">x</a>`;
		// RE_ARCHIVE_URL requires at least 1 digit but parseWaybackPath requires
		// exactly 14; however RE_ARCHIVE_URL allows 1–14 digits so short ones match
		// the regex. A 4-digit TS must not appear in discoveredAssets.
		const { discoveredAssets } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(discoveredAssets.every((a) => /^\d{14}$/.test(a.embeddedTs))).toBe(true);
	});

	it("captures embedded TS from srcset attribute", () => {
		const ts = "20030401120000";
		const html = `<img srcset="/web/${ts}im_/http://example.com/a.png 1x, /web/${ts}/http://example.com/b.png 2x">`;
		const { discoveredAssets } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(discoveredAssets).toContainEqual<DiscoveredAsset>({
			url: "http://example.com/a.png",
			embeddedTs: ts,
		});
		expect(discoveredAssets).toContainEqual<DiscoveredAsset>({
			url: "http://example.com/b.png",
			embeddedTs: ts,
		});
	});

	it("captures embedded TS from inline style url()", () => {
		const ts = "20030401120000";
		const html = `<div style="background: url('/web/${ts}/http://example.com/bg.png')">x</div>`;
		const { discoveredAssets } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(discoveredAssets).toContainEqual<DiscoveredAsset>({
			url: "http://example.com/bg.png",
			embeddedTs: ts,
		});
	});

	it("captures embedded TS from <style> element url()", () => {
		const ts = "20030401120000";
		const html = `<style>body { background: url('/web/${ts}/http://example.com/bg.png'); }</style>`;
		const { discoveredAssets } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(discoveredAssets).toContainEqual<DiscoveredAsset>({
			url: "http://example.com/bg.png",
			embeddedTs: ts,
		});
	});

	it("captures embedded TS from meta http-equiv refresh url", () => {
		const ts = "20030401120000";
		const html = `<meta http-equiv="refresh" content="0;url=/web/${ts}/http://example.com/page">`;
		const { discoveredAssets } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(discoveredAssets).toContainEqual<DiscoveredAsset>({
			url: "http://example.com/page",
			embeddedTs: ts,
		});
	});
});

describe("rewriteCssUrls — discoveredAssets", () => {
	it("captures embedded TS when collect/assets are provided", () => {
		const ts = "20030401120000";
		const css = `body { background: url('/web/${ts}/http://example.com/bg.png'); }`;
		const collect = new Set<string>();
		const assets: DiscoveredAsset[] = [];
		rewriteCssUrls(css, "http://example.com/page", TIME, false, collect, assets);
		expect(assets).toContainEqual<DiscoveredAsset>({
			url: "http://example.com/bg.png",
			embeddedTs: ts,
		});
	});

	it("does not record assets when collect/assets are omitted", () => {
		// Regression: calling without optional params must not throw
		const ts = "20030401120000";
		const css = `body { background: url('/web/${ts}/http://example.com/bg.png'); }`;
		expect(() => rewriteCssUrls(css, "http://example.com/page", TIME)).not.toThrow();
	});

	it("deduplicates within the same CSS string", () => {
		const ts = "20030401120000";
		const url = "http://example.com/bg.png";
		const css = `a { background: url('/web/${ts}/${url}'); } b { background: url('/web/${ts}/${url}'); }`;
		const collect = new Set<string>();
		const assets: DiscoveredAsset[] = [];
		rewriteCssUrls(css, "http://example.com/page", TIME, false, collect, assets);
		const matches = assets.filter((a) => a.url === url && a.embeddedTs === ts);
		expect(matches).toHaveLength(1);
	});
});

describe("rewriteHtmlUrls — lockTime", () => {
	it("strips the timestamp segment from archive-prefixed URLs when lockTime is true", () => {
		const html = `<a href="/web/20010913100802/http://commerce.www.ibm.com/cgi-bin/ncommerce/AdvantageCode?shoprfnbr=1&cntry=840&lang=en_US&cntrfnbr=1&mmerfnbr=1&q=W201">x</a>`;
		const { html: r } = rewriteHtmlUrls(html, "http://www.ibm.com", TIME, true);
		expect(r).toContain(
			"/web/http://commerce.www.ibm.com/cgi-bin/ncommerce/AdvantageCode?shoprfnbr=1&amp;cntry=840&amp;lang=en_US&amp;cntrfnbr=1&amp;mmerfnbr=1&amp;q=W201",
		);
		expect(r).not.toMatch(/\/web\/\d{14}\//);
	});

	it("strips the timestamp segment from relative URLs when lockTime is true", () => {
		const html = `<a href="/foo">x</a>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME, true);
		expect(r).toContain("/web/http://www.apple.com/foo");
		expect(r).not.toContain(`/web/${TIME}/`);
	});

	it("keeps the timestamp segment when lockTime is false (default)", () => {
		const html = `<a href="/foo">x</a>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/foo`);
	});

	it("keeps an image's embedded TS even when lockTime is true (asset, not a link)", () => {
		const html = `<img src="/web/20010913100802/http://www.ibm.com/img.png">`;
		const { html: r, discoveredAssets } = rewriteHtmlUrls(html, "http://www.ibm.com", TIME, true);
		// img is an asset → keep the snapshot timestamp so it resolves exactly.
		expect(r).toContain("/web/20010913100802/http://www.ibm.com/img.png");
		expect(discoveredAssets).toContainEqual<DiscoveredAsset>({
			url: "http://www.ibm.com/img.png",
			embeddedTs: "20010913100802",
		});
	});

	it("keeps the timestamp on srcset entries when lockTime is true (asset)", () => {
		const html = `<img srcset="/a.png 1x, /b.png 2x">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME, true);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/a.png 1x`);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/b.png 2x`);
	});

	it.each([
		["form", "action", `<form action="/login">`, "http://www.apple.com/login"],
		["iframe", "src", `<iframe src="/embed">`, "http://www.apple.com/embed"],
		["frame", "src", `<frameset><frame src="/embed"></frameset>`, "http://www.apple.com/embed"],
	])("strips the timestamp from <%s %s> navigation when lockTime is true", (_tag, _attr, html, url) => {
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME, true);
		expect(r).toContain(`/web/${url}`);
		expect(r).not.toContain(`/web/${TIME}/${url}`);
	});

	it.each([
		["img", `<img src="/logo.png">`, "http://www.apple.com/logo.png"],
		["script", `<script src="/app.js"></script>`, "http://www.apple.com/app.js"],
		["link", `<link rel="icon" href="/favicon.ico">`, "http://www.apple.com/favicon.ico"],
		["object", `<object data="/movie.swf"></object>`, "http://www.apple.com/movie.swf"],
		["video-poster", `<video poster="/thumb.jpg"></video>`, "http://www.apple.com/thumb.jpg"],
	])("keeps the timestamp on <%s> asset URLs when lockTime is true", (_label, html, url) => {
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME, true);
		expect(r).toContain(`/web/${TIME}/${url}`);
	});

	it("strips the timestamp from a meta-refresh redirect (navigation) when lockTime is true", () => {
		const html = `<meta http-equiv="refresh" content="5;url=/next">`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME, true);
		expect(r).toContain("url=/web/http://www.apple.com/next");
		expect(r).not.toContain(`/web/${TIME}/http://www.apple.com/next`);
	});

	it("keeps the timestamp on CSS url() inside <style> when lockTime is true (asset)", () => {
		const html = `<style>.a{background:url('/bg.png')}</style>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME, true);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/bg.png`);
	});

	it("keeps the timestamp on a style-attribute url() when lockTime is true (asset)", () => {
		const html = `<div style="background:url('/bg.png')"></div>`;
		const { html: r } = rewriteHtmlUrls(html, TARGET, TIME, true);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/bg.png`);
	});
});

describe("rewriteCssUrls — position: fixed containment", () => {
	it("rewrites position: fixed to position: absolute", () => {
		const css = `.nav { position: fixed; top: 0; }`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME);
		expect(r).toContain("position: absolute");
		expect(r).not.toContain("position: fixed");
	});

	it("rewrites position:fixed (no spaces) to position: absolute", () => {
		const css = `.nav { position:fixed; top: 0; }`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME);
		expect(r).toContain("position: absolute");
		expect(r).not.toContain("position:fixed");
	});

	it("rewrites POSITION: FIXED (uppercase) to position: absolute", () => {
		const css = `.nav { POSITION: FIXED; top: 0; }`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME);
		expect(r).toContain("position: absolute");
		expect(r).not.toMatch(/POSITION\s*:\s*FIXED/i);
	});

	it("rewrites all occurrences when multiple rules use position: fixed", () => {
		const css = `.a { position: fixed; } .b { position: fixed; }`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME);
		expect(r).not.toContain("position: fixed");
		expect((r.match(/position: absolute/g) ?? []).length).toBe(2);
	});

	it("leaves position: absolute untouched", () => {
		const css = `.box { position: absolute; top: 10px; }`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME);
		expect(r).toContain("position: absolute");
	});

	it("leaves position: relative untouched", () => {
		const css = `.box { position: relative; }`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME);
		expect(r).toContain("position: relative");
	});
});

describe("rewriteCssUrls — lockTime", () => {
	it("strips the timestamp segment from url() values when lockTime is true", () => {
		const css = `background: url('/web/20191231235959/http://example.com/img.png')`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME, true);
		expect(r).toContain("url('/web/http://example.com/img.png')");
		expect(r).not.toContain("/web/20191231235959/");
	});

	it("strips the timestamp from relative url() values when lockTime is true", () => {
		const css = `background: url('./img.png')`;
		const r = rewriteCssUrls(css, "http://example.com/page", TIME, true);
		expect(r).toContain("url('/web/http://example.com/img.png')");
		expect(r).not.toContain(`/web/${TIME}/`);
	});
});

describe("discoverNavLinks", () => {
	const CNN = "www.cnn.com";
	const PAGE = "http://www.cnn.com/";

	it("collects same-host nav links (a/area href, form action, frame/iframe src)", () => {
		const html = `<html><body>
			<a href="/US/">US</a>
			<area href="/SPORTS/">
			<form action="/search"></form>
			<iframe src="/embed/widget"></iframe>
		</body></html>`;
		expect(discoverNavLinks(html, PAGE, CNN)).toEqual([
			"http://www.cnn.com/US/",
			"http://www.cnn.com/SPORTS/",
			"http://www.cnn.com/search",
			"http://www.cnn.com/embed/widget",
		]);
	});

	it("excludes external hosts, asset (img) URLs, and opaque schemes; de-dupes", () => {
		const html = `<html><body>
			<a href="http://other.com/x">external</a>
			<img src="/logo.gif">
			<a href="#frag">frag</a>
			<a href="javascript:void(0)">js</a>
			<a href="/US/">a</a>
			<a href="/US/">dup</a>
		</body></html>`;
		expect(discoverNavLinks(html, PAGE, CNN)).toEqual(["http://www.cnn.com/US/"]);
	});

	it("resolves absolute same-host links and honors <base href>", () => {
		const html = `<html><head><base href="http://www.cnn.com/section/"></head><body>
			<a href="story.html">rel</a>
			<a href="http://www.cnn.com/WORLD/">abs</a>
		</body></html>`;
		expect(discoverNavLinks(html, PAGE, CNN)).toEqual([
			"http://www.cnn.com/section/story.html",
			"http://www.cnn.com/WORLD/",
		]);
	});

	it("unwraps /web/<ts>/<url> wrapped links to the original before host-filtering", () => {
		const html = `<a href="/web/20010912000000/http://www.cnn.com/US/">x</a>`;
		expect(discoverNavLinks(html, PAGE, CNN)).toEqual(["http://www.cnn.com/US/"]);
	});

	it("returns [] for unparseable or empty input", () => {
		expect(discoverNavLinks("", PAGE, CNN)).toEqual([]);
	});
});
