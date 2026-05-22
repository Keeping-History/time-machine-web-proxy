import {
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
});

describe("rewriteHtmlUrls — archive-prefixed URLs", () => {
	it("rewrites absolute web.archive.org URL with no modifier", () => {
		const html = `<a href="https://web.archive.org/web/20191231235959/http://example.com/page">x</a>`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/page`);
	});

	it("rewrites absolute web.archive.org URL with im_ modifier", () => {
		const html = `<img src="https://web.archive.org/web/20191231235959im_/http://example.com/img.png">`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/img.png`);
	});

	it("rewrites absolute web.archive.org URL with cs_ modifier", () => {
		const html = `<link rel="stylesheet" href="https://web.archive.org/web/20191231235959cs_/http://example.com/main.css">`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/main.css`);
	});

	it("rewrites relative /web/<ts>/<url>", () => {
		const html = `<a href="/web/20191231235959/http://example.com/page">x</a>`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/page`);
	});

	it("rewrites relative /web/<ts>im_/<url>", () => {
		const html = `<img src="/web/20191231235959im_/http://example.com/img.png">`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/20191231235959/http://example.com/img.png`);
	});
});

describe("rewriteHtmlUrls — relative URLs resolved against targetUrl", () => {
	it("resolves path-absolute relative URL against targetUrl", () => {
		const html = `<img src="/images/foo.png">`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/images/foo.png`);
	});

	it("resolves document-relative URL against targetUrl directory", () => {
		const html = `<img src="foo.png">`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/products/foo.png`);
	});

	it("preserves already-absolute non-archive URL but wraps it", () => {
		const html = `<a href="https://example.com/other">x</a>`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/https://example.com/other`);
	});
});

describe("rewriteHtmlUrls — covers all URL-bearing tags", () => {
	it("rewrites <a href>", () => {
		const r = rewriteHtmlUrls(`<a href="/x">x</a>`, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/x`);
	});

	it("rewrites <link href>", () => {
		const r = rewriteHtmlUrls(`<link rel="stylesheet" href="/css/main.css">`, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/css/main.css`);
	});

	it("rewrites <script src>", () => {
		const r = rewriteHtmlUrls(`<script src="/js/app.js"></script>`, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/js/app.js`);
	});

	it("rewrites <iframe src>", () => {
		const r = rewriteHtmlUrls(`<iframe src="/embed"></iframe>`, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/embed`);
	});

	it("rewrites <form action>", () => {
		const r = rewriteHtmlUrls(`<form action="/submit"></form>`, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/submit`);
	});

	it("rewrites <video src> and <audio src>", () => {
		const r = rewriteHtmlUrls(
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
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/a.png`);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/b.png`);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/default.png`);
		expect(r).toMatch(/1x/);
		expect(r).toMatch(/2x/);
	});

	it("rewrites <source srcset> with width descriptors", () => {
		const html = `<source srcset="/s.png 480w, /l.png 1024w">`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/s.png`);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/l.png`);
		expect(r).toMatch(/480w/);
		expect(r).toMatch(/1024w/);
	});
});

describe("rewriteHtmlUrls — inline style url()", () => {
	it("rewrites url(...) inside style attribute", () => {
		const html = `<div style="background: url('/img/bg.png')">x</div>`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/img/bg.png`);
	});
});

describe("rewriteHtmlUrls — schemes left alone", () => {
	it("leaves data: URIs untouched", () => {
		const html = `<img src="data:image/png;base64,iVBORw0KGgo=">`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`src="data:image/png;base64,iVBORw0KGgo="`);
	});

	it("leaves mailto: untouched", () => {
		const r = rewriteHtmlUrls(`<a href="mailto:x@y.com">m</a>`, TARGET, TIME);
		expect(r).toContain(`href="mailto:x@y.com"`);
	});

	it("leaves javascript: untouched", () => {
		const r = rewriteHtmlUrls(`<a href="javascript:void(0)">j</a>`, TARGET, TIME);
		expect(r).toContain(`href="javascript:void(0)"`);
	});

	it("leaves tel: untouched", () => {
		const r = rewriteHtmlUrls(`<a href="tel:+15551234">t</a>`, TARGET, TIME);
		expect(r).toContain(`href="tel:+15551234"`);
	});

	it("leaves fragment-only URLs untouched", () => {
		const r = rewriteHtmlUrls(`<a href="#top">x</a>`, TARGET, TIME);
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
		const r = rewriteHtmlUrls(`<a href="${uri}">x</a>`, TARGET, TIME);
		expect(r).toContain(`href="${uri}"`);
	});
});

describe("rewriteHtmlUrls — <base href> handling", () => {
	it("strips the <base> tag from the output", () => {
		const html = `<html><head><base href="https://cdn.example.com/"></head><body></body></html>`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).not.toMatch(/<base\b/i);
	});

	it("honors <base href> as the effective base for relative-URL resolution", () => {
		const html = `<html><head><base href="https://cdn.example.com/"></head><body><a href="/x">x</a></body></html>`;
		// Without honoring base, relative "/x" would resolve against TARGET
		// (www.apple.com). With base honored, it resolves against cdn.example.com.
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/https://cdn.example.com/x`);
		expect(r).not.toContain(`/web/${TIME}/http://www.apple.com/x`);
	});
});

describe("rewriteHtmlUrls — <meta http-equiv='refresh'>", () => {
	it("rewrites the url= portion of meta refresh content", () => {
		const html = `<meta http-equiv="refresh" content="5;url=/foo">`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`/web/${TIME}/http://www.apple.com/foo`);
	});

	it("leaves meta refresh without url= unchanged", () => {
		const html = `<meta http-equiv="refresh" content="5">`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toContain(`content="5"`);
	});

	it("does not touch non-refresh meta tags", () => {
		const html = `<meta name="description" content="visit /home">`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
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
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		expect(r).toMatch(new RegExp(`${attr}="\\/web\\/\\d{14}\\/`));
	});
});

describe("rewriteHtmlUrls — output is path-based", () => {
	it("rewritten URLs start with /web/, not the proxy host", () => {
		const html = `<a href="/foo"><img src="/bar"><script src="/baz"></script>`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
		// Each rewrite must produce an attribute value beginning with /web/{ts}/,
		// never a value that begins with http:// or https:// (which would mean
		// the proxy host got baked into the cached HTML).
		expect(r).not.toMatch(/(?:src|href)="https?:\/\//);
		expect(r).toMatch(/(?:src|href)="\/web\/\d{14}\//);
	});

	it("emits unencoded original URL inside the /web/<ts>/ path", () => {
		const html = `<a href="/foo">x</a>`;
		const r = rewriteHtmlUrls(html, TARGET, TIME);
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
