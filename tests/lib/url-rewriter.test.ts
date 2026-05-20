import {
	arcUrl,
	collectWaybackResourceUrls,
	rewriteArchiveLinks,
	rewriteCssUrls,
	rewriteCssUrlsFiltered,
	rewriteImageUrlsFiltered,
	sanitizeTimeParam,
	stripWaybackToolbar,
	unwrapNestedProxyUrl,
} from "../../src/lib/url-rewriter";

const PROXY = "http://localhost:8080";
const PREFIX = "https://web.archive.org/web";
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

describe("arcUrl", () => {
	it("builds a simple archive URL without proxyPrefix", () => {
		expect(arcUrl("http://example.com/", TIME, PREFIX, "")).toBe(
			`${PREFIX}/${TIME}/http://example.com/`,
		);
	});

	it("inserts proxyPrefix when provided", () => {
		expect(arcUrl("http://example.com/", TIME, PREFIX, "if_")).toBe(
			`${PREFIX}/${TIME}/if_/http://example.com/`,
		);
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
});

describe("collectWaybackResourceUrls", () => {
	it("collects img src URLs from absolute archive references", () => {
		const html = `<img src="https://web.archive.org/web/20200101000000/http://example.com/img.png">`;
		expect(collectWaybackResourceUrls(html)).toContain("http://example.com/img.png");
	});

	it("collects img src URLs from relative archive references", () => {
		const html = `<img src="/web/20200101000000/http://example.com/img.png">`;
		expect(collectWaybackResourceUrls(html)).toContain("http://example.com/img.png");
	});

	it("returns deduplicated list", () => {
		const html = `<img src="/web/20200101000000/http://example.com/img.png"><img src="/web/20200101000000/http://example.com/img.png">`;
		expect(collectWaybackResourceUrls(html)).toHaveLength(1);
	});
});

describe("rewriteImageUrlsFiltered", () => {
	it("rewrites img src only when URL is in cachedUrls", () => {
		const url = "http://example.com/img.png";
		const html = `<img src="https://web.archive.org/web/${TIME}/http://example.com/img.png">`;
		const result = rewriteImageUrlsFiltered(html, PROXY, TIME, new Set([url]));
		expect(result).toContain(`src="${PROXY}/?url=${encodeURIComponent(url)}&time=${TIME}"`);
	});

	it("leaves img src untouched when URL is not in cachedUrls", () => {
		const html = `<img src="https://web.archive.org/web/${TIME}/http://example.com/img.png">`;
		const result = rewriteImageUrlsFiltered(html, PROXY, TIME, new Set());
		expect(result).toBe(html);
	});
});

describe("rewriteCssUrlsFiltered", () => {
	it("rewrites CSS url() only when URL is in cachedUrls", () => {
		const url = "http://example.com/bg.png";
		const css = `background: url('https://web.archive.org/web/${TIME}/http://example.com/bg.png')`;
		const result = rewriteCssUrlsFiltered(css, PROXY, TIME, new Set([url]));
		expect(result).toContain(`url('${PROXY}/?url=${encodeURIComponent(url)}&time=${TIME}')`);
	});

	it("leaves CSS url() untouched when URL is not in cachedUrls", () => {
		const css = `background: url('https://web.archive.org/web/${TIME}/http://example.com/bg.png')`;
		const result = rewriteCssUrlsFiltered(css, PROXY, TIME, new Set());
		expect(result).toBe(css);
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
