import {
	rewriteCssUrls,
	rewriteHtmlUrls,
	sanitizeTimeParam,
	stripWaybackToolbar,
	unwrapNestedProxyUrl,
} from "../../src/lib/url-rewriter";

const PROXY = "http://localhost:8080";
const TIME = "20200101000000";
const PAGE = "http://www.apple.com/mac/index.html";

// Helper: build the proxy URL the rewriter is expected to emit for a target.
const toProxy = (target: string, t = TIME) =>
	`${PROXY}/?url=${encodeURIComponent(target)}&time=${t}`;

// --- sanitizeTimeParam (unchanged) -------------------------------------------

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

// --- unwrapNestedProxyUrl (unchanged) ----------------------------------------

describe("unwrapNestedProxyUrl", () => {
	it("returns unchanged url and fallback time when not a proxy URL", () => {
		expect(unwrapNestedProxyUrl("http://example.com/page", TIME, "proxy.local")).toEqual({
			url: "http://example.com/page",
			time: TIME,
		});
	});

	it("extracts inner url and time from a proxy URL", () => {
		const inner = "http://example.com/page";
		const innerTime = "20191231235959";
		const proxyUrl = `http://proxy.local/?url=${encodeURIComponent(inner)}&time=${innerTime}`;
		expect(unwrapNestedProxyUrl(proxyUrl, TIME, "proxy.local")).toEqual({
			url: inner,
			time: innerTime,
		});
	});

	it("uses fallbackTime when proxy URL has no time param", () => {
		const inner = "http://example.com/page";
		const proxyUrl = `http://proxy.local/?url=${encodeURIComponent(inner)}`;
		expect(unwrapNestedProxyUrl(proxyUrl, TIME, "proxy.local")).toEqual({
			url: inner,
			time: TIME,
		});
	});

	it("falls back to fallbackTime when proxy URL time is non-numeric", () => {
		const inner = "http://example.com/page";
		const proxyUrl = `http://proxy.local/?url=${encodeURIComponent(inner)}&time=not-a-timestamp`;
		expect(unwrapNestedProxyUrl(proxyUrl, TIME, "proxy.local")).toEqual({
			url: inner,
			time: TIME,
		});
	});

	it("returns original url for non-parseable string", () => {
		expect(unwrapNestedProxyUrl("not-a-url", TIME, "proxy.local")).toEqual({
			url: "not-a-url",
			time: TIME,
		});
	});
});

// --- rewriteHtmlUrls ---------------------------------------------------------

describe("rewriteHtmlUrls — URL-bearing attributes", () => {
	it("rewrites absolute <a href> to a proxy URL (URL parser normalizes path to /)", () => {
		const html = `<a href="http://www.mac.com">m</a>`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		// `new URL("http://www.mac.com").href` is `http://www.mac.com/` per the
		// URL spec — every parsed URL has at least a `/` path. The proxy target
		// reflects that normalization, matching browser behavior.
		expect(result).toContain(`href="${toProxy("http://www.mac.com/")}"`);
	});

	it("resolves a path-relative <a href> against pageUrl, then rewrites", () => {
		const html = `<a href="../products">p</a>`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`href="${toProxy("http://www.apple.com/products")}"`);
	});

	it("resolves a root-relative <a href> against pageUrl", () => {
		const html = `<a href="/foo">f</a>`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`href="${toProxy("http://www.apple.com/foo")}"`);
	});

	it("rewrites <img src>", () => {
		const html = `<img src="image.png">`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`src="${toProxy("http://www.apple.com/mac/image.png")}"`);
	});

	it("rewrites <link href>", () => {
		const html = `<link rel="stylesheet" href="/main.css">`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`href="${toProxy("http://www.apple.com/main.css")}"`);
	});

	it("rewrites <script src>", () => {
		const html = `<script src="app.js"></script>`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`src="${toProxy("http://www.apple.com/mac/app.js")}"`);
	});

	it("rewrites <form action>", () => {
		const html = `<form action="/submit"><input/></form>`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`action="${toProxy("http://www.apple.com/submit")}"`);
	});

	it("rewrites <video src> and <video poster> separately", () => {
		const html = `<video src="movie.mp4" poster="frame.jpg"></video>`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`src="${toProxy("http://www.apple.com/mac/movie.mp4")}"`);
		expect(result).toContain(`poster="${toProxy("http://www.apple.com/mac/frame.jpg")}"`);
	});

	it("rewrites every URL inside an <img srcset>, preserving descriptors", () => {
		const html = `<img srcset="small.png 1x, large.png 2x">`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		const small = toProxy("http://www.apple.com/mac/small.png");
		const large = toProxy("http://www.apple.com/mac/large.png");
		expect(result).toContain(`${small} 1x`);
		expect(result).toContain(`${large} 2x`);
	});

	it("rewrites <meta http-equiv=refresh> URL (case-insensitive attribute names)", () => {
		const html = `<meta http-equiv="REFRESH" content="1; URL=http://www.mac.com">`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(toProxy("http://www.mac.com/"));
		expect(result).not.toMatch(/URL=http:\/\/www\.mac\.com(?!&)/);
	});

	it("leaves <meta http-equiv=refresh> with no URL portion unchanged (just a delay)", () => {
		const html = `<meta http-equiv="refresh" content="5">`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`content="5"`);
	});
});

describe("rewriteHtmlUrls — non-proxyable references", () => {
	it("does NOT rewrite data:, mailto:, javascript:, tel:, blob:, about: URLs", () => {
		const html = [
			`<a href="data:text/plain,hi">d</a>`,
			`<a href="mailto:x@y.com">m</a>`,
			`<a href="javascript:void(0)">j</a>`,
			`<a href="tel:+15551234">t</a>`,
			`<a href="blob:abc">b</a>`,
			`<a href="about:blank">ab</a>`,
		].join("");
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`href="data:text/plain,hi"`);
		expect(result).toContain(`href="mailto:x@y.com"`);
		expect(result).toContain(`href="javascript:void(0)"`);
		expect(result).toContain(`href="tel:+15551234"`);
		expect(result).toContain(`href="blob:abc"`);
		expect(result).toContain(`href="about:blank"`);
	});

	it("does NOT rewrite same-page fragment links", () => {
		const html = `<a href="#anchor">a</a>`;
		expect(rewriteHtmlUrls(html, PAGE, PROXY, TIME)).toContain(`href="#anchor"`);
	});
});

describe("rewriteHtmlUrls — CSS inside HTML", () => {
	it("rewrites url() inside inline style attribute", () => {
		const html = `<div style="background: url(bg.png)"></div>`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`url(${toProxy("http://www.apple.com/mac/bg.png")})`);
	});

	it("rewrites url() inside a <style> block", () => {
		const html = `<style>body { background: url('img.png'); }</style>`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`url('${toProxy("http://www.apple.com/mac/img.png")}')`);
	});
});

describe("rewriteHtmlUrls — base href handling", () => {
	it("removes any <base> tag from the output so the browser does not resolve against the original origin", () => {
		const html = `<html><head><base href="http://www.apple.com/mac/"></head><body><a href="x">x</a></body></html>`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).not.toContain("<base");
	});

	it("honors a <base href> when resolving relative URLs in the same document", () => {
		// Effective base from <base> overrides pageUrl: the archived page set its
		// own base, so relative URLs would have resolved against that in the
		// original browser. We must match that resolution before stripping the tag.
		const html = `<html><head><base href="http://example.com/elsewhere/"></head><body><a href="x">x</a></body></html>`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`href="${toProxy("http://example.com/elsewhere/x")}"`);
	});
});

describe("rewriteHtmlUrls — Wayback prefix unwrapping (defense in depth)", () => {
	it("unwraps a Wayback-prefixed URL back to the original before proxying", () => {
		const html = `<a href="https://web.archive.org/web/20200101000000/http://example.com/page">p</a>`;
		const result = rewriteHtmlUrls(html, PAGE, PROXY, TIME);
		expect(result).toContain(`href="${toProxy("http://example.com/page")}"`);
	});
});

// --- rewriteCssUrls ----------------------------------------------------------

describe("rewriteCssUrls", () => {
	it("rewrites absolute url() to a proxy URL", () => {
		const css = `body { background: url("http://example.com/img.png"); }`;
		const result = rewriteCssUrls(css, PAGE, PROXY, TIME);
		expect(result).toContain(`url("${toProxy("http://example.com/img.png")}")`);
	});

	it("resolves a relative url() against pageUrl", () => {
		const css = `body { background: url('bg.png'); }`;
		const result = rewriteCssUrls(css, PAGE, PROXY, TIME);
		expect(result).toContain(`url('${toProxy("http://www.apple.com/mac/bg.png")}')`);
	});

	it("rewrites url() with no quotes", () => {
		const css = `body { background: url(bg.png); }`;
		const result = rewriteCssUrls(css, PAGE, PROXY, TIME);
		expect(result).toContain(`url(${toProxy("http://www.apple.com/mac/bg.png")})`);
	});

	it("unwraps Wayback-prefixed url() to the original", () => {
		const css = `body { background: url('https://web.archive.org/web/20200101000000/http://example.com/img.png'); }`;
		const result = rewriteCssUrls(css, PAGE, PROXY, TIME);
		expect(result).toContain(`url('${toProxy("http://example.com/img.png")}')`);
	});

	it("does not rewrite data: url()", () => {
		const css = `body { background: url('data:image/png;base64,xyz'); }`;
		expect(rewriteCssUrls(css, PAGE, PROXY, TIME)).toBe(css);
	});
});

// --- stripWaybackToolbar (no longer injects <base>) --------------------------

describe("stripWaybackToolbar", () => {
	it("removes the Wayback toolbar HTML block", () => {
		const html = `<html><head></head><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div>toolbar</div><!-- END WAYBACK TOOLBAR INSERT --></body></html>`;
		expect(stripWaybackToolbar(html)).not.toContain("toolbar");
	});

	it("removes Wayback rewrite JS block injected into <head>", () => {
		const html = `<html><head><script>// wayback js</script><!-- End Wayback Rewrite JS Include --></head><body>x</body></html>`;
		const result = stripWaybackToolbar(html);
		expect(result).not.toContain("wayback js");
		expect(result).toContain("<head>");
		expect(result).toContain("<body>x</body>");
	});

	it("does NOT inject a <base href> — the URL rewriter emits absolute proxy URLs and a stray <base> would send unrewritten refs to the live web", () => {
		const html = `<html><head></head><body></body></html>`;
		const result = stripWaybackToolbar(html);
		expect(result).not.toContain("<base");
	});
});
