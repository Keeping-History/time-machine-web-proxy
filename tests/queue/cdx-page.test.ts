import { parseCdxPage, pickClosestPerUrl } from "../../src/queue/cdx-page";

const HEADER = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"];

const makeRow = (
	urlkey: string,
	timestamp: string,
	original: string,
	statuscode: string,
): string[] => [urlkey, timestamp, original, "text/html", statuscode, "ABCDEF01", "1234"];

describe("parseCdxPage", () => {
	it("strips the header row and returns structured rows", () => {
		const input = [
			HEADER,
			makeRow("com,apple)/", "19980101010101", "http://www.apple.com/", "200"),
		];
		const result = parseCdxPage(input);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			urlkey: "com,apple)/",
			timestamp: "19980101010101",
			original: "http://www.apple.com/",
			statuscode: "200",
		});
	});

	it("returns empty array for input with only a header row", () => {
		expect(parseCdxPage([HEADER])).toEqual([]);
	});

	it("returns empty array for empty input", () => {
		expect(parseCdxPage([])).toEqual([]);
	});

	it("throws on malformed row (too few fields)", () => {
		const bad = [HEADER, ["com,apple)/", "19980101010101", "http://www.apple.com/"]];
		expect(() => parseCdxPage(bad)).toThrow();
	});

	it("throws on non-array input", () => {
		expect(() => parseCdxPage("not-an-array")).toThrow();
		expect(() => parseCdxPage(null)).toThrow();
	});

	it("throws on row with non-string field", () => {
		const bad = [HEADER, ["com,apple)/", 19980101010101, "http://www.apple.com/", "text/html", "200", "ABCDEF01", "1234"]];
		expect(() => parseCdxPage(bad)).toThrow();
	});
});

describe("pickClosestPerUrl", () => {
	it("picks the capture closest to the target timestamp", () => {
		const rows = parseCdxPage([
			HEADER,
			makeRow("com,apple)/", "19980101000000", "http://www.apple.com/", "200"),
			makeRow("com,apple)/", "19980105000000", "http://www.apple.com/", "200"),
		]);
		const result = pickClosestPerUrl(rows, "19980102000000");
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ url: "http://www.apple.com/", timestamp: "19980101000000" });
	});

	it("deduplicates per original URL, keeping the closest", () => {
		const rows = parseCdxPage([
			HEADER,
			makeRow("com,apple)/", "19980101000000", "http://www.apple.com/", "200"),
			makeRow("com,apple)/page", "19980101000000", "http://www.apple.com/page", "200"),
			makeRow("com,apple)/", "19980102000000", "http://www.apple.com/", "200"),
		]);
		// target = 19980101120000; closest for apple.com/ is 19980101000000 (12h diff vs 12h, tie → first wins)
		const result = pickClosestPerUrl(rows, "19980101120000");
		const urls = result.map((r) => r.url).sort();
		expect(urls).toEqual(["http://www.apple.com/", "http://www.apple.com/page"]);
	});

	it("filters out 4xx status codes", () => {
		const rows = parseCdxPage([
			HEADER,
			makeRow("com,apple)/404", "19980101000000", "http://www.apple.com/404", "404"),
			makeRow("com,apple)/ok", "19980101000000", "http://www.apple.com/ok", "200"),
		]);
		const result = pickClosestPerUrl(rows, "19980101000000");
		expect(result).toHaveLength(1);
		expect(result[0].url).toBe("http://www.apple.com/ok");
	});

	it("filters out 5xx status codes", () => {
		const rows = parseCdxPage([
			HEADER,
			makeRow("com,apple)/err", "19980101000000", "http://www.apple.com/err", "503"),
		]);
		const result = pickClosestPerUrl(rows, "19980101000000");
		expect(result).toHaveLength(0);
	});

	it("returns empty array for empty row input", () => {
		expect(pickClosestPerUrl([], "19980101000000")).toEqual([]);
	});
});
