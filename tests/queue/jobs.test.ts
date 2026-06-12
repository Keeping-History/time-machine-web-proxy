import {
	assertDomainCrawlJob,
	assertExactUrlJob,
	QUEUE_CRAWL,
	QUEUE_EXACT,
} from "../../src/queue/jobs";

describe("queue constants", () => {
	// BullMQ rejects ":" in queue names at construction time, so we use "-".
	// The colon-namespacing happens at the Redis-key level via bullmqPrefix.
	it("QUEUE_EXACT is 'archive-exact'", () => {
		expect(QUEUE_EXACT).toBe("archive-exact");
	});

	it("QUEUE_CRAWL is 'archive-crawl'", () => {
		expect(QUEUE_CRAWL).toBe("archive-crawl");
	});

	it("queue names do not contain ':' (BullMQ constraint)", () => {
		expect(QUEUE_EXACT).not.toContain(":");
		expect(QUEUE_CRAWL).not.toContain(":");
	});
});

describe("assertExactUrlJob", () => {
	it("accepts a valid https URL + 14-digit timestamp", () => {
		expect(() =>
			assertExactUrlJob({
				url: "https://example.com/",
				time: "20200101000000",
			}),
		).not.toThrow();
	});

	it("accepts http:// as well as https://", () => {
		expect(() =>
			assertExactUrlJob({
				url: "http://example.com/",
				time: "20200101000000",
			}),
		).not.toThrow();
	});

	it.each([
		["null", null],
		["undefined", undefined],
		["string", "not-an-object"],
		["number", 42],
		["array", []],
	])("throws 'Invalid job: not object' for %s", (_label, value) => {
		expect(() => assertExactUrlJob(value)).toThrow("Invalid job: not object");
	});

	it("throws 'Invalid job.url' when url is missing", () => {
		expect(() => assertExactUrlJob({ time: "20200101000000" })).toThrow("Invalid job.url");
	});

	it("throws 'Invalid job.url' when url is not a string", () => {
		expect(() => assertExactUrlJob({ url: 123, time: "20200101000000" })).toThrow(
			"Invalid job.url",
		);
	});

	it("throws 'Invalid job.url' when url lacks http(s):// prefix", () => {
		expect(() =>
			assertExactUrlJob({
				url: "ftp://example.com/",
				time: "20200101000000",
			}),
		).toThrow("Invalid job.url");
	});

	it("throws 'Invalid job.url' when url is a scheme-relative path", () => {
		expect(() =>
			assertExactUrlJob({
				url: "//example.com/path",
				time: "20200101000000",
			}),
		).toThrow("Invalid job.url");
	});

	it("throws 'Invalid job.time' when time is missing", () => {
		expect(() => assertExactUrlJob({ url: "https://example.com/" })).toThrow("Invalid job.time");
	});

	it("throws 'Invalid job.time' when time is not a string", () => {
		expect(() =>
			assertExactUrlJob({
				url: "https://example.com/",
				time: 20200101000000,
			}),
		).toThrow("Invalid job.time");
	});

	it("throws 'Invalid job.time' when time has 13 digits", () => {
		expect(() =>
			assertExactUrlJob({
				url: "https://example.com/",
				time: "2020010100000",
			}),
		).toThrow("Invalid job.time");
	});

	it("throws 'Invalid job.time' when time has 14 non-numeric characters", () => {
		expect(() =>
			assertExactUrlJob({
				url: "https://example.com/",
				time: "abcdefghijklmn",
			}),
		).toThrow("Invalid job.time");
	});

	it("accepts an optional valid crawl meta", () => {
		expect(() =>
			assertExactUrlJob({
				url: "https://example.com/",
				time: "20200101000000",
				crawl: { rootHost: "example.com", rootTime: "20200101000000", depth: 0 },
			}),
		).not.toThrow();
	});

	it.each([
		["non-object crawl", "nope"],
		["missing rootHost", { rootTime: "20200101000000", depth: 0 }],
		["bad rootTime", { rootHost: "example.com", rootTime: "2020", depth: 0 }],
		["negative depth", { rootHost: "example.com", rootTime: "20200101000000", depth: -1 }],
		["float depth", { rootHost: "example.com", rootTime: "20200101000000", depth: 1.5 }],
	])("throws 'Invalid job.crawl…' for %s", (_label, crawl) => {
		expect(() =>
			assertExactUrlJob({ url: "https://example.com/", time: "20200101000000", crawl }),
		).toThrow(/Invalid job\.crawl/);
	});
});

describe("assertDomainCrawlJob", () => {
	it("accepts a valid host + 14-digit timestamp", () => {
		expect(() =>
			assertDomainCrawlJob({
				host: "example.com",
				time: "20200101000000",
			}),
		).not.toThrow();
	});

	it.each([
		["null", null],
		["undefined", undefined],
		["string", "not-an-object"],
		["number", 42],
		["array", []],
	])("throws 'Invalid job: not object' for %s", (_label, value) => {
		expect(() => assertDomainCrawlJob(value)).toThrow("Invalid job: not object");
	});

	it("throws 'Invalid job.host' when host is empty", () => {
		expect(() => assertDomainCrawlJob({ host: "", time: "20200101000000" })).toThrow(
			"Invalid job.host",
		);
	});

	it("throws 'Invalid job.host' when host is missing", () => {
		expect(() => assertDomainCrawlJob({ time: "20200101000000" })).toThrow("Invalid job.host");
	});

	it("throws 'Invalid job.host' when host is not a string", () => {
		expect(() => assertDomainCrawlJob({ host: 42, time: "20200101000000" })).toThrow(
			"Invalid job.host",
		);
	});

	it("throws 'Invalid job.time' when time is missing", () => {
		expect(() => assertDomainCrawlJob({ host: "example.com" })).toThrow("Invalid job.time");
	});

	it("throws 'Invalid job.time' when time is malformed", () => {
		expect(() => assertDomainCrawlJob({ host: "example.com", time: "2020-01-01" })).toThrow(
			"Invalid job.time",
		);
	});
});

