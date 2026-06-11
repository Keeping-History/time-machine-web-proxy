import {
	CDN_SUFFIXES,
	normalizeHostname,
	parseDomainRemap,
} from "../../src/lib/hostname-normalizer";

describe("parseDomainRemap", () => {
	it("returns empty object for undefined", () => {
		expect(parseDomainRemap(undefined)).toEqual({});
	});

	it("returns empty object for empty string", () => {
		expect(parseDomainRemap("")).toEqual({});
	});

	it("parses a single from=to pair", () => {
		expect(parseDomainRemap("www.foo.com.edgesuite.net=www.foo.com")).toEqual({
			"www.foo.com.edgesuite.net": "www.foo.com",
		});
	});

	it("parses multiple pairs", () => {
		expect(parseDomainRemap("a.edgesuite.net=a.com,b.edgesuite.net=b.com")).toEqual({
			"a.edgesuite.net": "a.com",
			"b.edgesuite.net": "b.com",
		});
	});

	it("trims whitespace around pairs and delimiters", () => {
		expect(parseDomainRemap(" a.net = b.com , c.net = d.com ")).toEqual({
			"a.net": "b.com",
			"c.net": "d.com",
		});
	});

	it("skips malformed entries without an = sign", () => {
		expect(parseDomainRemap("valid.net=ok.com,noequalssign,another.net=fine.com")).toEqual({
			"valid.net": "ok.com",
			"another.net": "fine.com",
		});
	});

	it("skips entries with empty from", () => {
		expect(parseDomainRemap("=to.com,valid.net=ok.com")).toEqual({ "valid.net": "ok.com" });
	});

	it("skips entries with empty to", () => {
		expect(parseDomainRemap("from.net=,valid.net=ok.com")).toEqual({ "valid.net": "ok.com" });
	});
});

describe("normalizeHostname", () => {
	it("returns original string for unparseable URLs", () => {
		expect(normalizeHostname("not a url", {})).toBe("not a url");
	});

	it("returns original string when no rule matches", () => {
		const url = "http://www.example.com/path?q=1";
		expect(normalizeHostname(url, {})).toBe(url);
	});

	it("applies explicit domain remap (exact hostname match)", () => {
		const remap = { "www.msnbc.com.edgesuite.net": "www.msnbc.com" };
		expect(normalizeHostname("http://www.msnbc.com.edgesuite.net/news/123.asp", remap)).toBe(
			"http://www.msnbc.com/news/123.asp",
		);
	});

	it("remap preserves path, query, and fragment", () => {
		const remap = { "cdn.foo.com.edgesuite.net": "cdn.foo.com" };
		expect(normalizeHostname("http://cdn.foo.com.edgesuite.net/file.js?v=2&x=3#sec", remap)).toBe(
			"http://cdn.foo.com/file.js?v=2&x=3#sec",
		);
	});

	it("explicit remap takes precedence over CDN suffix stripping", () => {
		const remap = { "assets.foo.com.edgesuite.net": "static.foo.com" };
		expect(normalizeHostname("http://assets.foo.com.edgesuite.net/img.png", remap)).toBe(
			"http://static.foo.com/img.png",
		);
	});

	it.each(CDN_SUFFIXES)("strips CDN suffix %s", (suffix) => {
		const url = `http://www.example${suffix}/path/file.css`;
		expect(normalizeHostname(url, {})).toBe("http://www.example/path/file.css");
	});

	it("strips .edgesuite.net and preserves subdomain structure", () => {
		expect(normalizeHostname("http://www.msnbc.com.edgesuite.net/news/534548.asp", {})).toBe(
			"http://www.msnbc.com/news/534548.asp",
		);
	});

	it("does not strip when suffix match would leave empty hostname", () => {
		expect(normalizeHostname("http://edgesuite.net/path", {})).toBe("http://edgesuite.net/path");
	});

	it("does not strip when the remaining prefix is an edge-node name (path-embedded origin)", () => {
		// a772.g.akamai.net embeds the origin in the PATH, not the hostname.
		// Stripping .akamai.net would leave "a772.g" — a bogus host. Left intact
		// so extractCdnEmbeddedUrl can unwrap the path downstream.
		const url =
			"http://a772.g.akamai.net/7/772/51/7648437e551b56/www.apple.com/t/2001/us/en/i/2.gif";
		expect(normalizeHostname(url, {})).toBe(url);
	});

	it("does not strip when the remaining prefix has a one-letter final label", () => {
		expect(normalizeHostname("http://foo.x.akamai.net/bar.gif", {})).toBe(
			"http://foo.x.akamai.net/bar.gif",
		);
	});

	it("still strips when the remaining prefix is a plausible origin host", () => {
		expect(normalizeHostname("http://www.cnn.com.akamai.net/img.png", {})).toBe(
			"http://www.cnn.com/img.png",
		);
	});

	it("does not alter https scheme", () => {
		const remap = { "cdn.bar.com.edgesuite.net": "cdn.bar.com" };
		expect(normalizeHostname("https://cdn.bar.com.edgesuite.net/x.js", remap)).toBe(
			"https://cdn.bar.com/x.js",
		);
	});
});
