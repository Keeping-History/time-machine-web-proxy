import {
	ASSET_URL_FALLBACKS,
	candidateFallbackUrls,
	replaceRule,
	type UrlFallbackRule,
} from "../../src/lib/asset-fallbacks";

const AKAMAI_URL =
	"http://a772.g.akamai.net/7/772/51/7648437e551b56/www.apple.com/t/2001/us/en/i/2.gif";
const AKAMAI_ORIGIN = "http://www.apple.com/t/2001/us/en/i/2.gif";

describe("candidateFallbackUrls (default rules)", () => {
	it("unwraps a path-embedded CDN origin via the built-in rule", () => {
		const out = [...candidateFallbackUrls(AKAMAI_URL)];
		expect(out).toEqual([{ rule: "cdn-embedded-origin", url: AKAMAI_ORIGIN }]);
	});

	it("yields nothing for a plain origin URL no rule applies to", () => {
		expect([...candidateFallbackUrls("http://www.example.com/logo.png")]).toEqual([]);
	});
});

describe("candidateFallbackUrls (rule ordering, dedup, safety)", () => {
	const rules: UrlFallbackRule[] = [
		{ name: "noop", transform: () => null },
		{ name: "first", transform: () => "http://a.test/x" },
		{ name: "dup", transform: () => "http://a.test/x" }, // same as "first"
		{ name: "second", transform: () => "http://b.test/y" },
	];

	it("preserves rule order and skips non-applicable rules", () => {
		expect([...candidateFallbackUrls("http://orig.test/z", rules)]).toEqual([
			{ rule: "first", url: "http://a.test/x" },
			{ rule: "second", url: "http://b.test/y" },
		]);
	});

	it("never yields the original URL even if a rule returns it unchanged", () => {
		const echo: UrlFallbackRule[] = [{ name: "echo", transform: (u) => u }];
		expect([...candidateFallbackUrls("http://orig.test/z", echo)]).toEqual([]);
	});

	it("treats a throwing rule as not-applicable rather than failing", () => {
		const boom: UrlFallbackRule[] = [
			{
				name: "boom",
				transform: () => {
					throw new Error("rule blew up");
				},
			},
			{ name: "ok", transform: () => "http://recovered.test/x" },
		];
		expect([...candidateFallbackUrls("http://orig.test/z", boom)]).toEqual([
			{ rule: "ok", url: "http://recovered.test/x" },
		]);
	});
});

describe("replaceRule", () => {
	const rule = replaceRule(
		"imgcdn",
		/^https?:\/\/images\.example\.net\/(.*)$/,
		"http://www.example.com/$1",
	);

	it("rewrites a matching URL using backreferences", () => {
		expect(rule.transform("http://images.example.net/a/b.png")).toBe(
			"http://www.example.com/a/b.png",
		);
	});

	it("returns null when the pattern does not match", () => {
		expect(rule.transform("http://other.net/a/b.png")).toBeNull();
	});
});

describe("ASSET_URL_FALLBACKS registry", () => {
	it("has unique rule names", () => {
		const names = ASSET_URL_FALLBACKS.map((r) => r.name);
		expect(new Set(names).size).toBe(names.length);
	});
});
