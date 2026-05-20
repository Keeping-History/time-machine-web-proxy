import {
	rewriteArchiveLinks,
	rewriteCssUrls,
	sanitizeTimeParam,
	stripWaybackToolbar,
	unwrapNestedProxyUrl,
} from "../../src/lib/url-rewriter";

const PROXY = "http://localhost:8080";
const TIME = "20200101000000";

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

	it("falls back to fallbackTime when proxy URL time has wrong digit length", () => {
		const inner = "http://example.com/page";
		const proxyUrl = `http://proxy.local/?url=${encodeURIComponent(inner)}&time=20200101`;
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

describe("rewriteArchiveLinks", () => {
	it("rewrites absolute archive hrefs", () => {
		const html = `<a href="https://web.archive.org/web/20200101000000/http://example.com/page">link</a>`;
		const result = rewriteArchiveLinks(html, PROXY);
		expect(result).toContain(
			`href="${PROXY}/?url=${encodeURIComponent("http://example.com/page")}&time=${TIME}"`,
		);
	});

	it("rewrites relative archive hrefs", () => {
		const html = `<a href="/web/20200101000000/http://example.com/page">link</a>`;
		const result = rewriteArchiveLinks(html, PROXY);
		expect(result).toContain(
			`href="${PROXY}/?url=${encodeURIComponent("http://example.com/page")}&time=${TIME}"`,
		);
	});

	it("leaves non-archive hrefs untouched", () => {
		const html = `<a href="http://example.com/page">link</a>`;
		expect(rewriteArchiveLinks(html, PROXY)).toBe(html);
	});
});

describe("rewriteCssUrls", () => {
	it("rewrites absolute archive url() references", () => {
		const css = `background: url('https://web.archive.org/web/20200101000000/http://example.com/img.png')`;
		const result = rewriteCssUrls(css, PROXY, TIME);
		expect(result).toContain(
			`url('${PROXY}/?url=${encodeURIComponent("http://example.com/img.png")}&time=${TIME}')`,
		);
	});

	it("rewrites relative archive url() references", () => {
		const css = `background: url('/web/20200101000000/http://example.com/img.png')`;
		const result = rewriteCssUrls(css, PROXY, TIME);
		expect(result).toContain(
			`url('${PROXY}/?url=${encodeURIComponent("http://example.com/img.png")}&time=${TIME}')`,
		);
	});

	it("leaves non-archive url() references unchanged", () => {
		const css = `background: url('http://example.com/plain.png')`;
		expect(rewriteCssUrls(css, PROXY, TIME)).toBe(css);
	});
});

describe("stripWaybackToolbar", () => {
	it("removes the Wayback toolbar insert", () => {
		const html = `<html><head></head><body><!-- BEGIN WAYBACK TOOLBAR INSERT --><div>toolbar</div><!-- END WAYBACK TOOLBAR INSERT --></body></html>`;
		expect(stripWaybackToolbar(html, "http://example.com/")).not.toContain("toolbar");
	});

	it("injects base href into <head>", () => {
		const html = `<html><head></head><body></body></html>`;
		const result = stripWaybackToolbar(html, "http://example.com/page");
		expect(result).toContain(`<base href="http://example.com/page">`);
	});

	it("encodes special characters in base href", () => {
		const html = `<html><head></head><body></body></html>`;
		const result = stripWaybackToolbar(html, "http://example.com/?a=1&b=2");
		expect(result).toContain(`<base href="http://example.com/?a=1%26b=2">`);
	});
});
