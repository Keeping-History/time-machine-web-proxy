import { validateTargetUrl, isHostWhitelisted, parseWhitelist } from "../../src/lib/url-validator";

describe("parseWhitelist", () => {
	it("splits comma-separated hosts", () => {
		expect(parseWhitelist("example.com,foo.com")).toEqual(["example.com", "foo.com"]);
	});

	it("trims whitespace", () => {
		expect(parseWhitelist(" example.com , foo.com ")).toEqual(["example.com", "foo.com"]);
	});

	it("filters empty entries", () => {
		expect(parseWhitelist("example.com,,foo.com")).toEqual(["example.com", "foo.com"]);
	});

	it("returns empty array for empty string", () => {
		expect(parseWhitelist("")).toEqual([]);
	});
});

describe("isHostWhitelisted", () => {
	it("allows everything when whitelist is *", () => {
		expect(isHostWhitelisted("http://any.example.com/path", "*")).toBe(true);
	});

	it("allows everything when whitelist is empty", () => {
		expect(isHostWhitelisted("http://any.example.com/path", "")).toBe(true);
	});

	it("allows exact hostname match", () => {
		expect(isHostWhitelisted("http://example.com/path", "example.com")).toBe(true);
	});

	it("rejects non-matching hostname", () => {
		expect(isHostWhitelisted("http://evil.com/path", "example.com")).toBe(false);
	});

	it("allows wildcard subdomain match", () => {
		expect(isHostWhitelisted("http://sub.example.com/path", "*.example.com")).toBe(true);
	});

	it("allows exact domain when wildcard is *.example.com", () => {
		expect(isHostWhitelisted("http://example.com/path", "*.example.com")).toBe(true);
	});

	it("rejects subdomain not matching wildcard pattern", () => {
		expect(isHostWhitelisted("http://sub.other.com/path", "*.example.com")).toBe(false);
	});

	it("allows match against one of multiple patterns", () => {
		expect(isHostWhitelisted("http://foo.com/path", "example.com,foo.com")).toBe(true);
	});

	it("returns false for invalid URL", () => {
		expect(isHostWhitelisted("not-a-url", "example.com")).toBe(false);
	});
});

describe("validateTargetUrl", () => {
	it("returns the URL when valid", () => {
		const url = "https://example.com/page";
		expect(validateTargetUrl(url)).toBe(url);
	});

	it("accepts http URLs", () => {
		expect(validateTargetUrl("http://example.com/")).toBe("http://example.com/");
	});

	it("throws on invalid URL string", () => {
		expect(() => validateTargetUrl("not a url")).toThrow("Invalid URL");
	});

	it("throws on disallowed protocol (ftp)", () => {
		expect(() => validateTargetUrl("ftp://example.com/file")).toThrow("Disallowed protocol");
	});

	it("throws on disallowed protocol (javascript)", () => {
		expect(() => validateTargetUrl("javascript:alert(1)")).toThrow("Disallowed protocol");
	});

	it("throws for localhost", () => {
		expect(() => validateTargetUrl("http://localhost/path")).toThrow("Private/internal hosts disallowed");
	});

	it("throws for 127.x loopback", () => {
		expect(() => validateTargetUrl("http://127.0.0.1/path")).toThrow("Private/internal hosts disallowed");
	});

	it("throws for 10.x private range", () => {
		expect(() => validateTargetUrl("http://10.0.0.1/path")).toThrow("Private/internal hosts disallowed");
	});

	it("throws for 192.168.x private range", () => {
		expect(() => validateTargetUrl("http://192.168.1.1/path")).toThrow("Private/internal hosts disallowed");
	});

	it("throws for 172.16-31.x private range", () => {
		expect(() => validateTargetUrl("http://172.16.0.1/path")).toThrow("Private/internal hosts disallowed");
	});

	it("throws for IPv6 loopback ::1", () => {
		expect(() => validateTargetUrl("http://[::1]/path")).toThrow("Private/internal hosts disallowed");
	});

	it("throws for link-local 169.254.x", () => {
		expect(() => validateTargetUrl("http://169.254.1.1/path")).toThrow("Private/internal hosts disallowed");
	});
});
