import pino from "pino";
import { cachedCdxFetch } from "../../src/lib/cdx-cache";

const logger = pino({ level: "silent" });

const mkRedis = (
	getCb?: (key: string) => Promise<string | null>,
	setCb?: () => Promise<string>,
) => ({
	get: jest.fn(getCb ?? (() => Promise.resolve(null))),
	set: jest.fn(setCb ?? (() => Promise.resolve("OK"))),
});

const validateJson = (body: string): boolean => {
	try {
		return Array.isArray(JSON.parse(body));
	} catch {
		return false;
	}
};

const cdxUrl = (to?: string): string => {
	const p = new URLSearchParams({ url: "https://example.com/", output: "json", fl: "timestamp" });
	if (to) p.set("to", to);
	return `https://web.archive.org/cdx/search/cdx?${p}`;
};

const NOW_MS = Date.UTC(2026, 4, 29, 12, 0, 0);

describe("cachedCdxFetch", () => {
	it("cache miss — fetches upstream and writes to Redis", async () => {
		const redis = mkRedis();
		const body = JSON.stringify([["timestamp"], ["20010101000000"]]);
		const fetchImpl = jest.fn().mockResolvedValue(new Response(body));

		await cachedCdxFetch(cdxUrl("20010101000000"), {}, {
			redis, logger, enabled: true, bullmqPrefix: "tm",
			validate: validateJson,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => NOW_MS,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(redis.set).toHaveBeenCalledTimes(1);
	});

	it("cache hit — skips upstream fetch entirely", async () => {
		const body = JSON.stringify([["timestamp"], ["20010101000000"]]);
		const redis = mkRedis(() => Promise.resolve(body));
		const fetchImpl = jest.fn();

		const res = await cachedCdxFetch(cdxUrl("20010101000000"), {}, {
			redis, logger, enabled: true, bullmqPrefix: "tm",
			validate: validateJson,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await res.text()).toBe(body);
	});

	it("TTL is 7 days when to= is older than now-24h (historical window)", async () => {
		const redis = mkRedis();
		const fetchImpl = jest.fn().mockResolvedValue(new Response("[]"));

		await cachedCdxFetch(cdxUrl("20260527000000"), {}, {
			redis, logger, enabled: true, bullmqPrefix: "tm",
			validate: validateJson,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => NOW_MS,
		});

		expect(redis.set).toHaveBeenCalledWith(
			expect.any(String), "[]", "EX", 7 * 24 * 60 * 60,
		);
	});

	it("TTL is 5 minutes when to= is within the last 24h (open-edge window)", async () => {
		const redis = mkRedis();
		const fetchImpl = jest.fn().mockResolvedValue(new Response("[]"));

		await cachedCdxFetch(cdxUrl("20260529000000"), {}, {
			redis, logger, enabled: true, bullmqPrefix: "tm",
			validate: validateJson,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => NOW_MS,
		});

		expect(redis.set).toHaveBeenCalledWith(
			expect.any(String), "[]", "EX", 5 * 60,
		);
	});

	it("TTL is 5 minutes when to= is absent", async () => {
		const redis = mkRedis();
		const fetchImpl = jest.fn().mockResolvedValue(new Response("[]"));

		await cachedCdxFetch(cdxUrl(), {}, {
			redis, logger, enabled: true, bullmqPrefix: "tm",
			validate: validateJson,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(redis.set).toHaveBeenCalledWith(
			expect.any(String), "[]", "EX", 5 * 60,
		);
	});

	it("non-200 response is NOT cached", async () => {
		const redis = mkRedis();
		const fetchImpl = jest.fn().mockResolvedValue(new Response("error", { status: 500 }));

		await cachedCdxFetch(cdxUrl("20010101000000"), {}, {
			redis, logger, enabled: true, bullmqPrefix: "tm",
			validate: validateJson,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => NOW_MS,
		});

		expect(redis.set).not.toHaveBeenCalled();
	});

	it("HTTP 200 + body failing validate is returned to caller but NOT cached", async () => {
		const redis = mkRedis();
		const badBody = "<html>503 Service Unavailable</html>";
		const fetchImpl = jest.fn().mockResolvedValue(new Response(badBody));

		const res = await cachedCdxFetch(cdxUrl("20010101000000"), {}, {
			redis, logger, enabled: true, bullmqPrefix: "tm",
			validate: validateJson,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => NOW_MS,
		});

		expect(redis.set).not.toHaveBeenCalled();
		expect(res.ok).toBe(true);
		expect(await res.text()).toBe(badBody);
	});

	it("HTTP 200 + empty array [] IS cached (authoritative no-captures)", async () => {
		const redis = mkRedis();
		const fetchImpl = jest.fn().mockResolvedValue(new Response("[]"));

		await cachedCdxFetch(cdxUrl("20010101000000"), {}, {
			redis, logger, enabled: true, bullmqPrefix: "tm",
			validate: validateJson,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => NOW_MS,
		});

		expect(redis.set).toHaveBeenCalledTimes(1);
		expect((redis.set.mock.calls[0] as unknown[])[1]).toBe("[]");
	});

	it("redis: null — bypasses cache and delegates directly to fetchImpl", async () => {
		const fetchImpl = jest.fn().mockResolvedValue(new Response("[]"));

		const res = await cachedCdxFetch(cdxUrl("20010101000000"), {}, {
			redis: null, logger, enabled: true, bullmqPrefix: "tm",
			validate: validateJson,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(res.ok).toBe(true);
	});

	it("enabled: false — bypasses cache and delegates directly to fetchImpl", async () => {
		const redis = mkRedis();
		const fetchImpl = jest.fn().mockResolvedValue(new Response("[]"));

		await cachedCdxFetch(cdxUrl("20010101000000"), {}, {
			redis, logger, enabled: false, bullmqPrefix: "tm",
			validate: validateJson,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(redis.get).not.toHaveBeenCalled();
		expect(redis.set).not.toHaveBeenCalled();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("Redis GET error — logs warn and falls through to upstream fetch", async () => {
		const redis = mkRedis(() => Promise.reject(new Error("ECONNRESET")));
		const fetchImpl = jest.fn().mockResolvedValue(new Response("[]"));

		await expect(
			cachedCdxFetch(cdxUrl("20010101000000"), {}, {
				redis, logger, enabled: true, bullmqPrefix: "tm",
				validate: validateJson,
				fetchImpl: fetchImpl as unknown as typeof fetch,
				now: () => NOW_MS,
			}),
		).resolves.toBeDefined();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("Redis SET error — logs warn and does not block returning the response", async () => {
		const redis = {
			get: jest.fn().mockResolvedValue(null),
			set: jest.fn().mockRejectedValue(new Error("ECONNRESET")),
		};
		const fetchImpl = jest.fn().mockResolvedValue(new Response("[]"));

		const res = await cachedCdxFetch(cdxUrl("20010101000000"), {}, {
			redis, logger, enabled: true, bullmqPrefix: "tm",
			validate: validateJson,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => NOW_MS,
		});

		expect(res.ok).toBe(true);
	});

	it("single-flight — 10 concurrent identical calls invoke fetchImpl exactly once", async () => {
		const redis = mkRedis();
		let resolveBody!: (r: Response) => void;
		const pending = new Promise<Response>((res) => { resolveBody = res; });
		const fetchImpl = jest.fn().mockReturnValue(pending);

		const calls = Array.from({ length: 10 }, () =>
			cachedCdxFetch(cdxUrl("20010101000000"), {}, {
				redis, logger, enabled: true, bullmqPrefix: "tm",
				validate: validateJson,
				fetchImpl: fetchImpl as unknown as typeof fetch,
				now: () => NOW_MS,
			}),
		);

		resolveBody(new Response("[]"));
		const results = await Promise.all(calls);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(results).toHaveLength(10);
		for (const r of results) expect(r.ok).toBe(true);
	});
});
