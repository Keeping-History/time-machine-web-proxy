import {
	assertDomainCrawlChunkJob,
	assertDomainCrawlJob,
	assertExactUrlJob,
	QUEUE_CRAWL,
	QUEUE_CRAWL_CHUNK,
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

	it("QUEUE_CRAWL_CHUNK is 'archive-crawl-chunk'", () => {
		expect(QUEUE_CRAWL_CHUNK).toBe("archive-crawl-chunk");
	});

	it("queue names do not contain ':' (BullMQ constraint)", () => {
		expect(QUEUE_EXACT).not.toContain(":");
		expect(QUEUE_CRAWL).not.toContain(":");
		expect(QUEUE_CRAWL_CHUNK).not.toContain(":");
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

describe("assertDomainCrawlChunkJob", () => {
	it("accepts a valid host + 14-digit timestamp + non-negative page", () => {
		expect(() =>
			assertDomainCrawlChunkJob({ host: "apple.com", time: "19980101000000", page: 0 }),
		).not.toThrow();

		expect(() =>
			assertDomainCrawlChunkJob({ host: "apple.com", time: "19980101000000", page: 42 }),
		).not.toThrow();
	});

	it.each([
		["null", null],
		["undefined", undefined],
		["string", "not-an-object"],
		["array", []],
	])("throws 'Invalid job: not object' for %s", (_label, value) => {
		expect(() => assertDomainCrawlChunkJob(value)).toThrow("Invalid job: not object");
	});

	it("throws 'Invalid job.host' when host is empty", () => {
		expect(() => assertDomainCrawlChunkJob({ host: "", time: "19980101000000", page: 0 })).toThrow(
			"Invalid job.host",
		);
	});

	it("throws 'Invalid job.host' when host is missing", () => {
		expect(() => assertDomainCrawlChunkJob({ time: "19980101000000", page: 0 })).toThrow(
			"Invalid job.host",
		);
	});

	it("throws 'Invalid job.time' when time is malformed", () => {
		expect(() =>
			assertDomainCrawlChunkJob({ host: "apple.com", time: "1998-01-01", page: 0 }),
		).toThrow("Invalid job.time");
	});

	it("throws 'Invalid job.time' when time is missing", () => {
		expect(() => assertDomainCrawlChunkJob({ host: "apple.com", page: 0 })).toThrow(
			"Invalid job.time",
		);
	});

	it("throws 'Invalid job.page' when page is negative", () => {
		expect(() =>
			assertDomainCrawlChunkJob({ host: "apple.com", time: "19980101000000", page: -1 }),
		).toThrow("Invalid job.page");
	});

	it("throws 'Invalid job.page' when page is a float", () => {
		expect(() =>
			assertDomainCrawlChunkJob({ host: "apple.com", time: "19980101000000", page: 1.5 }),
		).toThrow("Invalid job.page");
	});

	it("throws 'Invalid job.page' when page is missing", () => {
		expect(() =>
			assertDomainCrawlChunkJob({ host: "apple.com", time: "19980101000000" }),
		).toThrow("Invalid job.page");
	});
});
