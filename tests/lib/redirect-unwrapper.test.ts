import { extractCdnEmbeddedUrl, unwrapRedirectUrl } from "../../src/lib/redirect-unwrapper";

describe("extractCdnEmbeddedUrl", () => {
	it("extracts embedded origin URL from an Akamai URL", () => {
		expect(
			extractCdnEmbeddedUrl(
				"http://a284.g.akamai.net/7/284/3299/6d43dd55efa485/www.usrobotics.com/products/images-prod/p-global-xja.gif",
			),
		).toBe("http://www.usrobotics.com/products/images-prod/p-global-xja.gif");
	});

	it("preserves query string from the CDN URL on the result", () => {
		expect(
			extractCdnEmbeddedUrl(
				"http://a284.g.akamai.net/7/284/3299/abcdef/www.example.com/img.gif?v=2",
			),
		).toBe("http://www.example.com/img.gif?v=2");
	});

	it("returns null for a non-CDN URL", () => {
		expect(extractCdnEmbeddedUrl("http://www.usrobotics.com/products/img.gif")).toBeNull();
	});

	it("returns null when no hostname-like segment exists in the path", () => {
		expect(extractCdnEmbeddedUrl("http://a284.g.akamai.net/7/284/3299/6d43dd55efa485")).toBeNull();
	});

	it("returns null when path segment has a file-extension TLD (not a hostname)", () => {
		// /only-segment.gif would be misidentified without the extension check
		expect(extractCdnEmbeddedUrl("http://a284.g.akamai.net/only.gif")).toBeNull();
	});

	it("handles akamaiedge.net hostname variant", () => {
		expect(
			extractCdnEmbeddedUrl("http://foo.akamaiedge.net/1/2/hash/www.example.com/style.css"),
		).toBe("http://www.example.com/style.css");
	});

	it("handles edgekey.net hostname variant", () => {
		expect(
			extractCdnEmbeddedUrl("http://foo.edgekey.net/1/2/hash/img.example.com/logo.png"),
		).toBe("http://img.example.com/logo.png");
	});

	it("returns null for an invalid URL string", () => {
		expect(extractCdnEmbeddedUrl("not a url")).toBeNull();
	});
});

describe("unwrapRedirectUrl", () => {
	it("returns unchanged URL when no pattern matches", () => {
		const url = "http://www.example.com/path?q=1";
		expect(unwrapRedirectUrl(url)).toBe(url);
	});

	it("unwraps Yahoo srd.yahoo.com redirect", () => {
		expect(
			unwrapRedirectUrl(
				"http://srd.yahoo.com/drst/37321022/*http://www.onvt.com/dec1999/art.htm",
			),
		).toBe("http://www.onvt.com/dec1999/art.htm");
	});

	it("unwraps Yahoo rd.yahoo.com redirect", () => {
		expect(
			unwrapRedirectUrl("http://rd.yahoo.com/s/123456/*https://www.example.com/page"),
		).toBe("https://www.example.com/page");
	});

	it("preserves path and query on the destination URL", () => {
		expect(
			unwrapRedirectUrl(
				"http://srd.yahoo.com/drst/99/*http://www.example.com/a/b?x=1&y=2",
			),
		).toBe("http://www.example.com/a/b?x=1&y=2");
	});

	it("resolves to the last *http:// when the path contains multiple asterisks", () => {
		expect(
			unwrapRedirectUrl(
				"http://srd.yahoo.com/s/*ignored/*http://www.actual.com/dest",
			),
		).toBe("http://www.actual.com/dest");
	});

	it("is case-insensitive on the scheme", () => {
		expect(
			unwrapRedirectUrl("HTTP://SRD.YAHOO.COM/drst/1/*http://www.dest.com/"),
		).toBe("http://www.dest.com/");
	});

	it("does not unwrap if destination after * is not http(s)", () => {
		const url = "http://srd.yahoo.com/drst/1/*ftp://files.example.com/";
		expect(unwrapRedirectUrl(url)).toBe(url);
	});

	it("does not unwrap unrelated yahoo subdomain", () => {
		const url = "http://news.yahoo.com/story/*http://example.com/";
		expect(unwrapRedirectUrl(url)).toBe(url);
	});

	it("unwraps AOL r.aol.com/cgi/redir-complex preserving trailing query", () => {
		expect(
			unwrapRedirectUrl(
				"http://r.aol.com/cgi/redir-complex?url=http://www.aol.com/shopping/&sid=nSh",
			),
		).toBe("http://www.aol.com/shopping/&sid=nSh");
	});

	it("unwraps AOL redir-complex with https destination", () => {
		expect(
			unwrapRedirectUrl(
				"http://r.aol.com/cgi/redir-complex?url=https://example.com/path?q=1",
			),
		).toBe("https://example.com/path?q=1");
	});

	it("AOL redir-complex with different sids extract distinct destinations", () => {
		const a = unwrapRedirectUrl(
			"http://r.aol.com/cgi/redir-complex?url=http://www.aol.com/news/&sid=abc",
		);
		const b = unwrapRedirectUrl(
			"http://r.aol.com/cgi/redir-complex?url=http://www.aol.com/sports/&sid=def",
		);
		expect(a).not.toBe(b);
		expect(a).toBe("http://www.aol.com/news/&sid=abc");
		expect(b).toBe("http://www.aol.com/sports/&sid=def");
	});

	it("does not unwrap AOL redir-complex without http(s) destination", () => {
		const url = "http://r.aol.com/cgi/redir-complex?url=ftp://files.example.com/";
		expect(unwrapRedirectUrl(url)).toBe(url);
	});

	it("does not unwrap unrelated r.aol.com paths", () => {
		const url = "http://r.aol.com/cgi/other?url=http://example.com/";
		expect(unwrapRedirectUrl(url)).toBe(url);
	});

	it("unwraps AOL dynamic.aol.com/cgi/redir with embedded http URL", () => {
		expect(unwrapRedirectUrl("http://dynamic.aol.com/cgi/redir?http://my.aol.com/")).toBe(
			"http://my.aol.com/",
		);
	});

	it("unwraps AOL dynamic.aol.com/cgi/redir with embedded https URL", () => {
		expect(unwrapRedirectUrl("http://dynamic.aol.com/cgi/redir?https://example.com/path")).toBe(
			"https://example.com/path",
		);
	});

	it("preserves path and query on dynamic.aol.com destination URL", () => {
		expect(
			unwrapRedirectUrl("http://dynamic.aol.com/cgi/redir?http://www.example.com/a/b?x=1&y=2"),
		).toBe("http://www.example.com/a/b?x=1&y=2");
	});

	it("does not unwrap dynamic.aol.com without http(s) destination", () => {
		const url = "http://dynamic.aol.com/cgi/redir?ftp://files.example.com/";
		expect(unwrapRedirectUrl(url)).toBe(url);
	});

	it("does not unwrap unrelated dynamic.aol.com paths", () => {
		const url = "http://dynamic.aol.com/cgi/other?http://example.com/";
		expect(unwrapRedirectUrl(url)).toBe(url);
	});

	it("unwraps Excite r.excite.com/r/ redirect with semicolon-delimited destination", () => {
		expect(
			unwrapRedirectUrl(
				"http://r.excite.com/r/co=d_nb_nb-xnt_attack;http://news.excite.com/news/ap/us/terrorism-attacks",
			),
		).toBe("http://news.excite.com/news/ap/us/terrorism-attacks");
	});

	it("unwraps Excite r.excite.com/r/ redirect with https destination", () => {
		expect(
			unwrapRedirectUrl("http://r.excite.com/r/co=some_param;https://www.excite.com/page"),
		).toBe("https://www.excite.com/page");
	});

	it("preserves path and query on Excite destination URL", () => {
		expect(
			unwrapRedirectUrl(
				"http://r.excite.com/r/co=tracking;http://news.excite.com/a/b?x=1&y=2",
			),
		).toBe("http://news.excite.com/a/b?x=1&y=2");
	});

	it("does not unwrap Excite redirect without http(s) destination", () => {
		const url = "http://r.excite.com/r/co=param;ftp://files.example.com/";
		expect(unwrapRedirectUrl(url)).toBe(url);
	});

	it("does not unwrap unrelated r.excite.com paths", () => {
		const url = "http://r.excite.com/other/path;http://example.com/";
		expect(unwrapRedirectUrl(url)).toBe(url);
	});
});
