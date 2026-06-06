import { unwrapRedirectUrl } from "../../src/lib/redirect-unwrapper";

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
});
