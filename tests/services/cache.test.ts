jest.mock("node:fs", () => ({
	promises: {
		readFile: jest.fn(),
		writeFile: jest.fn(),
		readdir: jest.fn(),
		unlink: jest.fn(),
		access: jest.fn(),
		stat: jest.fn(),
		rm: jest.fn(),
		mkdir: jest.fn(),
		rename: jest.fn(),
	},
}));

import { promises as fs } from "node:fs";
import pino from "pino";
import { CacheService } from "../../src/services/cache";

const logger = pino({ level: "silent" });

const makeService = (cacheEnabled = true, notFoundTtlDays = 30) =>
	new CacheService({ cacheDir: "/tmp/cache", cacheEnabled, notFoundTtlDays }, logger);

const mockFs = fs as jest.Mocked<typeof fs>;

beforeEach(() => {
	jest.resetAllMocks();
	// Default: sentinel does not exist. Tests that need a present sentinel override this.
	(mockFs.stat as jest.Mock).mockRejectedValue(
		Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
	);
});

describe("CacheService.cacheDirForJob", () => {
	it("returns <cacheDir>/v2/<time>/<host> exactly", () => {
		const svc = makeService();
		expect(svc.cacheDirForJob("20200101000000", "example.com")).toBe(
			"/tmp/cache/v2/20200101000000/example.com",
		);
	});

	it("composes path correctly with different host and time values", () => {
		const svc = makeService();
		expect(svc.cacheDirForJob("19990921123456", "sub.example.org")).toBe(
			"/tmp/cache/v2/19990921123456/sub.example.org",
		);
	});
});

describe("CacheService.lookup (v2)", () => {
	const TIME = "20200101000000";

	it("returns null without touching fs when cacheEnabled is false", async () => {
		const svc = makeService(false);
		const result = await svc.lookup("https://example.com/about", TIME);
		expect(result).toBeNull();
		expect(mockFs.access).not.toHaveBeenCalled();
	});

	it("HIT: returns { absPath, contentType } when file exists", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/about.html", TIME);
		expect(result).toEqual({
			absPath: "/tmp/cache/v2/20200101000000/example.com/about.html",
			contentType: "text/html",
		});
		expect(mockFs.access).toHaveBeenCalledTimes(1);
	});

	it("MISS: returns null when fs.access rejects", async () => {
		(mockFs.access as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/missing.html", TIME);
		expect(result).toBeNull();
	});

	it("directory URL ending with / resolves to <root>/index.html", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/about/", TIME);
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/about/index.html");
		expect(result?.contentType).toBe("text/html");
	});

	it("root path / resolves to <root>/index.html", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/", TIME);
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/index.html");
	});

	it("path-traversal attempt throws Error with status: 400", async () => {
		const svc = makeService();
		// The URL constructor normalizes literal "/../" segments; the realistic
		// attack vector is percent-encoded traversal which only decodes after
		// the URL parse step. The guard catches the decoded form.
		await expect(
			svc.lookup("https://example.com/%2e%2e%2f%2e%2e%2fetc%2fpasswd", TIME),
		).rejects.toMatchObject({ status: 400 });
		expect(mockFs.access).not.toHaveBeenCalled();
	});

	it("derives content-type from file extension via mime-types", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const cssResult = await svc.lookup("https://example.com/style.css", TIME);
		expect(cssResult?.contentType).toBe("text/css");
		const pngResult = await svc.lookup("https://example.com/img.png", TIME);
		expect(pngResult?.contentType).toBe("image/png");
	});

	it("preserves 'www.' in host so the cache key matches the worker write path", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://www.example.com/about.html", TIME);
		// www.example.com and example.com are stored separately — they can
		// legitimately serve different content; collapsing risks poisoning.
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/www.example.com/about.html");
	});

	it("returns application/octet-stream for unknown extension", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/file.unknownext", TIME);
		expect(result?.contentType).toBe("application/octet-stream");
	});

	it("uses the .content-types sidecar verbatim when present (overrides extension)", async () => {
		// The sidecar stores the upstream Content-Type from the direct fetch
		// path. It takes precedence over mime-types extension lookup so a
		// charset hint or a non-default type (e.g. application/xhtml+xml) is
		// preserved across reads.
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		(mockFs.readFile as jest.Mock).mockImplementation((p: string) => {
			if (p.includes("/.content-types/")) return Promise.resolve("text/html; charset=utf-8");
			if (p.endsWith(".resolved-time"))
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			return Promise.resolve(Buffer.from(""));
		});
		const svc = makeService();
		const result = await svc.lookup("https://www.yahoo.com/r/ci", TIME);
		expect(result?.contentType).toBe("text/html; charset=utf-8");
	});

	it("sniffs HTML for extensionless URLs when no sidecar exists (legacy cache)", async () => {
		// The user-reported bug: http://www.yahoo.com/r/ci has no extension,
		// mime-types returns false, and pre-fix the response went out as
		// application/octet-stream — the browser downloaded it. Sniffing the
		// cached body for an HTML signature serves it correctly without a
		// cache wipe.
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		(mockFs.readFile as jest.Mock).mockImplementation((p: string) => {
			if (p.includes("/.content-types/"))
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			if (p.endsWith(".resolved-time"))
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			return Promise.resolve(
				Buffer.from('<HTML><HEAD><meta http-equiv="refresh" content="0;url=/"></HEAD></HTML>'),
			);
		});
		const svc = makeService();
		const result = await svc.lookup("https://www.yahoo.com/r/ci", TIME);
		expect(result?.contentType).toBe("text/html; charset=utf-8");
	});

	it("sniff recognises an XML prolog", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		(mockFs.readFile as jest.Mock).mockImplementation((p: string) => {
			if (p.includes("/.content-types/") || p.endsWith(".resolved-time"))
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			return Promise.resolve(Buffer.from('<?xml version="1.0"?><rss></rss>'));
		});
		const svc = makeService();
		const result = await svc.lookup("https://example.com/feed", TIME);
		expect(result?.contentType).toBe("application/xml");
	});

	it("sniff does NOT run when the URL has an extension (avoids false positives)", async () => {
		// `.unknownext` is non-empty — mime-types returns false, but we MUST
		// NOT sniff: an extension was specified, so the user/server intended
		// a particular type. Falsely promoting binary blobs to text/html based
		// on a stray "<html" byte sequence would corrupt downloads.
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const readSpy = jest.fn().mockImplementation((p: string) => {
			if (p.includes("/.content-types/") || p.endsWith(".resolved-time"))
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			return Promise.resolve(Buffer.from("<html>this is a trap</html>"));
		});
		(mockFs.readFile as jest.Mock).mockImplementation(readSpy);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/file.unknownext", TIME);
		expect(result?.contentType).toBe("application/octet-stream");
		// The cached body must never be read in the no-sniff path.
		const bodyReads = readSpy.mock.calls.filter(
			(call: [string]) =>
				!call[0].includes("/.content-types/") && !call[0].endsWith(".resolved-time"),
		);
		expect(bodyReads).toHaveLength(0);
	});

	it("sniff returns octet-stream for non-HTML/XML extensionless content", async () => {
		// Random binary bytes should NOT be promoted to text/html. The
		// sniffer's allowlist of signatures is intentionally narrow.
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		(mockFs.readFile as jest.Mock).mockImplementation((p: string) => {
			if (p.includes("/.content-types/") || p.endsWith(".resolved-time"))
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			return Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		});
		const svc = makeService();
		const result = await svc.lookup("https://example.com/blob", TIME);
		expect(result?.contentType).toBe("application/octet-stream");
	});

	// www.example.com and example.com may serve different content and the
	// Wayback Machine archives them as distinct URLs. The cache key preserves
	// that distinction so a hit on one form never returns content from the
	// other.
	it("www. and apex hosts resolve to DISTINCT cache entries", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const a = await svc.lookup("https://www.example.com/about.html", TIME);
		const b = await svc.lookup("https://example.com/about.html", TIME);
		expect(a?.absPath).toBe("/tmp/cache/v2/20200101000000/www.example.com/about.html");
		expect(b?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/about.html");
		expect(a?.absPath).not.toBe(b?.absPath);
	});

	it("lookup for a www. URL uses the www. hostname verbatim in the cache path", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://www.apple.com/", TIME);
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/www.apple.com/index.html");
	});

	// The Wayback downloader saves directory-style URLs as `<dir>/index.html`
	// (e.g., `apple.com/mac/index.html` for `http://apple.com/mac`). A request
	// for `/mac` with no trailing slash must therefore fall back to the
	// directory-index file when no literal file exists at that path. Without
	// this, the user gets a 502 even though the content is cached.
	it("MISS at <root>/<path> falls back to <root>/<path>/index.html (directory-index convention)", async () => {
		(mockFs.access as jest.Mock)
			.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			.mockResolvedValueOnce(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/mac", TIME);
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/mac/index.html");
		expect(result?.contentType).toBe("text/html");
	});

	it("prefers the exact file when it exists; does not probe the index fallback", async () => {
		(mockFs.access as jest.Mock).mockResolvedValueOnce(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/mac.html", TIME);
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/mac.html");
		expect(mockFs.access).toHaveBeenCalledTimes(1);
	});

	it("returns null when neither <root>/<path> nor <root>/<path>/index.html exists", async () => {
		(mockFs.access as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/nope", TIME);
		expect(result).toBeNull();
	});
});

describe("CacheService.writeNotFoundSentinel + sentinel-aware lookup", () => {
	const TIME = "20200101000000";
	const URL = "https://example.com/about";

	it("writes a sentinel file at <root>/.notfound/<sha256-prefix>", async () => {
		(mockFs.mkdir as jest.Mock).mockResolvedValue(undefined);
		(mockFs.writeFile as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		await svc.writeNotFoundSentinel(TIME, URL);

		expect(mockFs.mkdir).toHaveBeenCalledTimes(1);
		expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
		const writtenPath = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		expect(writtenPath).toMatch(
			/^\/tmp\/cache\/v2\/20200101000000\/example\.com\/\.notfound\/[0-9a-f]{16}$/,
		);
		const mkdirPath = (mockFs.mkdir as jest.Mock).mock.calls[0][0] as string;
		expect(mkdirPath).toBe("/tmp/cache/v2/20200101000000/example.com/.notfound");
	});

	it("derives different sentinel keys for different URLs at the same host+time", async () => {
		(mockFs.mkdir as jest.Mock).mockResolvedValue(undefined);
		(mockFs.writeFile as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		await svc.writeNotFoundSentinel(TIME, "https://example.com/a");
		await svc.writeNotFoundSentinel(TIME, "https://example.com/b");
		const a = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		const b = (mockFs.writeFile as jest.Mock).mock.calls[1][0] as string;
		expect(a).not.toBe(b);
	});

	it("lookup throws {status: 404} when sentinel exists for the URL", async () => {
		// file access fails for the content file; sentinel stat succeeds with a recent mtime.
		(mockFs.access as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		(mockFs.stat as jest.Mock).mockResolvedValue({ mtimeMs: Date.now() });
		const svc = makeService();
		await expect(svc.lookup(URL, TIME)).rejects.toMatchObject({
			status: 404,
		});
	});

	it("lookup returns null when neither file nor sentinel exists (unchanged miss path)", async () => {
		(mockFs.access as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		(mockFs.stat as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const svc = makeService();
		const result = await svc.lookup(URL, TIME);
		expect(result).toBeNull();
	});

	it("lookup returns HIT when file exists, even if sentinel could exist (file wins)", async () => {
		// File access succeeds — sentinel check should not be reached.
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/about.html", TIME);
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/about.html");
		// Exactly one fs.access call (for the file) — sentinel not consulted.
		expect(mockFs.access).toHaveBeenCalledTimes(1);
	});

	it("sentinel root dir preserves 'www.' to match the worker write path", async () => {
		(mockFs.mkdir as jest.Mock).mockResolvedValue(undefined);
		(mockFs.writeFile as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		await svc.writeNotFoundSentinel(TIME, "https://www.example.com/about");
		const writtenPath = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		expect(writtenPath).toMatch(
			/^\/tmp\/cache\/v2\/20200101000000\/www\.example\.com\/\.notfound\//,
		);
	});

	it("writeResolvedTimeSidecar writes <root>/.resolved-time with the timestamp", async () => {
		(mockFs.mkdir as jest.Mock).mockResolvedValue(undefined);
		(mockFs.writeFile as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		await svc.writeResolvedTimeSidecar(TIME, "https://www.example.com/", "20010822231227");
		const path = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		const content = (mockFs.writeFile as jest.Mock).mock.calls[0][1] as string;
		expect(path).toBe("/tmp/cache/v2/20200101000000/www.example.com/.resolved-time");
		expect(content).toBe("20010822231227");
	});

	it("lookup populates CacheHit.archiveTime from the sidecar when present", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		(mockFs.readFile as jest.Mock).mockImplementation((p: string) => {
			if (p.endsWith(".resolved-time")) return Promise.resolve("20010822231227");
			return Promise.resolve(Buffer.from(""));
		});
		const svc = makeService();
		const result = await svc.lookup("https://www.example.com/about.html", TIME);
		expect(result?.archiveTime).toBe("20010822231227");
	});

	it("lookup omits archiveTime when no sidecar exists (legacy cache HIT)", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		(mockFs.readFile as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const svc = makeService();
		const result = await svc.lookup("https://www.example.com/about.html", TIME);
		expect(result?.archiveTime).toBeUndefined();
	});

	it("ignores malformed .resolved-time sidecar contents and leaves archiveTime undefined", async () => {
		// Guards the 14-digit validation in readResolvedTime against accidentally
		// propagating bad sidecar data (e.g. a partial write or hand-edited file).
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		(mockFs.readFile as jest.Mock).mockImplementation((p: string) => {
			if (p.endsWith(".resolved-time")) return Promise.resolve("not-a-timestamp");
			return Promise.resolve(Buffer.from(""));
		});
		const svc = makeService();
		const result = await svc.lookup("https://www.example.com/about.html", TIME);
		expect(result?.archiveTime).toBeUndefined();
	});

	it("sentinel keyed by full URL: same path, different query string → different sentinels", async () => {
		(mockFs.mkdir as jest.Mock).mockResolvedValue(undefined);
		(mockFs.writeFile as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		await svc.writeNotFoundSentinel(TIME, "https://example.com/x?a=1");
		await svc.writeNotFoundSentinel(TIME, "https://example.com/x?a=2");
		const a = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		const b = (mockFs.writeFile as jest.Mock).mock.calls[1][0] as string;
		expect(a).not.toBe(b);
	});

	it("lookup deletes an expired sentinel and returns null", async () => {
		// Content file misses; permanent sentinel exists but is older than TTL.
		// Tentative sentinel does NOT exist (path-aware mock).
		(mockFs.access as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const ttlDays = 7;
		const oldMtimeMs = Date.now() - (ttlDays + 1) * 24 * 60 * 60 * 1000;
		(mockFs.stat as jest.Mock).mockImplementation((p: string) => {
			if (p.includes(".notfound-tentative/")) {
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			}
			return Promise.resolve({ mtimeMs: oldMtimeMs });
		});
		(mockFs.unlink as jest.Mock).mockResolvedValue(undefined);

		const svc = makeService(true, ttlDays);
		const result = await svc.lookup(URL, TIME);

		expect(result).toBeNull();
		expect(mockFs.unlink).toHaveBeenCalledTimes(1);
	});

	it("lookup throws 404 for a fresh sentinel within TTL", async () => {
		// Content file misses; permanent sentinel is recent (within TTL).
		// Tentative sentinel does NOT exist (path-aware mock).
		(mockFs.access as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const ttlDays = 7;
		const freshMtimeMs = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day old
		(mockFs.stat as jest.Mock).mockImplementation((p: string) => {
			if (p.includes(".notfound-tentative/")) {
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			}
			return Promise.resolve({ mtimeMs: freshMtimeMs });
		});

		const svc = makeService(true, ttlDays);
		await expect(svc.lookup(URL, TIME)).rejects.toMatchObject({ status: 404 });
		expect(mockFs.unlink).not.toHaveBeenCalled();
	});

	it("expired sentinel unlink is logged with [cache] sentinel-expired", async () => {
		(mockFs.access as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const ttlDays = 30;
		const oldMtimeMs = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days old
		(mockFs.stat as jest.Mock).mockImplementation((p: string) => {
			if (p.includes(".notfound-tentative/")) {
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			}
			return Promise.resolve({ mtimeMs: oldMtimeMs });
		});
		(mockFs.unlink as jest.Mock).mockResolvedValue(undefined);

		const logSpy = jest.spyOn(logger, "info");
		const svc = makeService(true, ttlDays);
		await svc.lookup(URL, TIME);

		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				sentinel: expect.any(String),
				ageMs: expect.any(Number),
				ttlMs: expect.any(Number),
			}),
			"[cache] sentinel-expired",
		);
	});
});

describe("CacheService.writeTentativeNotFoundSentinel + tentative-aware lookup", () => {
	const TIME = "20200101000000";
	const URL = "https://example.com/about";

	it("writes a tentative sentinel at <root>/.notfound-tentative/<sha256-prefix>", async () => {
		(mockFs.mkdir as jest.Mock).mockResolvedValue(undefined);
		(mockFs.writeFile as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		await svc.writeTentativeNotFoundSentinel(TIME, URL);

		expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
		const writtenPath = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		expect(writtenPath).toMatch(
			/^\/tmp\/cache\/v2\/20200101000000\/example\.com\/\.notfound-tentative\/[0-9a-f]{16}$/,
		);
	});

	it("tentative and permanent sentinels share key derivation but live in separate subdirs", async () => {
		(mockFs.mkdir as jest.Mock).mockResolvedValue(undefined);
		(mockFs.writeFile as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		await svc.writeTentativeNotFoundSentinel(TIME, URL);
		await svc.writeNotFoundSentinel(TIME, URL);
		const tentative = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		const permanent = (mockFs.writeFile as jest.Mock).mock.calls[1][0] as string;
		const tentativeKey = tentative.split("/").pop();
		const permanentKey = permanent.split("/").pop();
		expect(tentativeKey).toBe(permanentKey);
		expect(tentative).toContain("/.notfound-tentative/");
		expect(permanent).toContain("/.notfound/");
		expect(permanent).not.toContain("/.notfound-tentative/");
	});

	it("lookup throws 404 when only the tentative sentinel exists and is within 1h TTL", async () => {
		(mockFs.access as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const freshMtimeMs = Date.now() - 30 * 60 * 1000; // 30 minutes old
		(mockFs.stat as jest.Mock).mockImplementation((p: string) => {
			if (p.includes(".notfound-tentative/")) {
				return Promise.resolve({ mtimeMs: freshMtimeMs });
			}
			return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
		});
		const svc = makeService();
		await expect(svc.lookup(URL, TIME)).rejects.toMatchObject({ status: 404 });
		expect(mockFs.unlink).not.toHaveBeenCalled();
	});

	it("lookup unlinks an expired tentative sentinel and falls through to permanent check", async () => {
		(mockFs.access as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const expiredMtimeMs = Date.now() - 2 * 60 * 60 * 1000; // 2 hours old (TTL is 1h)
		(mockFs.stat as jest.Mock).mockImplementation((p: string) => {
			if (p.includes(".notfound-tentative/")) {
				return Promise.resolve({ mtimeMs: expiredMtimeMs });
			}
			return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
		});
		(mockFs.unlink as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup(URL, TIME);
		expect(result).toBeNull();
		expect(mockFs.unlink).toHaveBeenCalledTimes(1);
		const unlinkedPath = (mockFs.unlink as jest.Mock).mock.calls[0][0] as string;
		expect(unlinkedPath).toContain("/.notfound-tentative/");
	});

	it("tentative sentinel takes precedence over a stale fresh-looking permanent sentinel", async () => {
		// Both sentinels exist; tentative is fresh (within 1h), permanent would
		// also count as fresh. Lookup must short-circuit on the tentative without
		// touching the permanent (one stat call, not two).
		(mockFs.access as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const freshMtimeMs = Date.now() - 10 * 60 * 1000; // 10 minutes old
		(mockFs.stat as jest.Mock).mockResolvedValue({ mtimeMs: freshMtimeMs });
		const svc = makeService();
		await expect(svc.lookup(URL, TIME)).rejects.toMatchObject({ status: 404 });
		expect(mockFs.stat).toHaveBeenCalledTimes(1);
	});
});

describe("CacheService.computeAbsPath", () => {
	const TIME = "20200101000000";

	// Criterion 1: computeAbsPath returns same path as lookup probes for given (url, time)
	it("returns the same primary path that lookup probes for a plain file URL", () => {
		const svc = makeService();
		const abs = svc.computeAbsPath("https://example.com/about.html", TIME);
		expect(abs).toBe("/tmp/cache/v2/20200101000000/example.com/about.html");
	});

	it("resolves directory-style URL (trailing /) to index.html — matching lookup primary probe", () => {
		const svc = makeService();
		const abs = svc.computeAbsPath("https://example.com/about/", TIME);
		expect(abs).toBe("/tmp/cache/v2/20200101000000/example.com/about/index.html");
	});

	it("resolves root / to index.html — matching lookup primary probe", () => {
		const svc = makeService();
		const abs = svc.computeAbsPath("https://example.com/", TIME);
		expect(abs).toBe("/tmp/cache/v2/20200101000000/example.com/index.html");
	});

	it("preserves www. in hostname verbatim — same as lookup", () => {
		const svc = makeService();
		const abs = svc.computeAbsPath("https://www.example.com/page.html", TIME);
		expect(abs).toBe("/tmp/cache/v2/20200101000000/www.example.com/page.html");
	});

	// Criterion 2: path-traversal payloads reject with HTTP 400
	it("rejects percent-encoded traversal (%2e%2e/etc/passwd) with status 400", () => {
		const svc = makeService();
		expect(() => svc.computeAbsPath("https://example.com/%2e%2e%2fetc%2fpasswd", TIME)).toThrow(
			expect.objectContaining({ status: 400 }),
		);
	});

	it("rejects deeply nested percent-encoded traversal with status 400", () => {
		const svc = makeService();
		expect(() =>
			svc.computeAbsPath("https://example.com/%2e%2e%2f%2e%2e%2fetc%2fpasswd", TIME),
		).toThrow(expect.objectContaining({ status: 400 }));
	});
});

describe("CacheService.writeFile", () => {
	const TIME = "20200101000000";

	beforeEach(() => {
		(mockFs.mkdir as jest.Mock).mockResolvedValue(undefined);
		(mockFs.writeFile as jest.Mock).mockResolvedValue(undefined);
		(mockFs.rename as jest.Mock).mockResolvedValue(undefined);
	});

	// Criterion 3: writeFile round-trips — subsequent lookup returns the bytes
	// (In the mock environment we verify the write path matches computeAbsPath
	// and that lookup probes the same path, ensuring they are consistent.)
	it("writes to the path that computeAbsPath returns — lookup will find it there", async () => {
		const svc = makeService();
		const url = "https://example.com/page.html";
		const expectedDest = svc.computeAbsPath(url, TIME);

		await svc.writeFile(url, TIME, Buffer.from("hello"));

		// rename target must equal computeAbsPath output
		const renameDest = (mockFs.rename as jest.Mock).mock.calls[0][1] as string;
		expect(renameDest).toBe(expectedDest);
	});

	it("creates the parent directory before writing", async () => {
		const svc = makeService();
		await svc.writeFile("https://example.com/deep/path/file.html", TIME, Buffer.from("x"));

		expect(mockFs.mkdir).toHaveBeenCalledWith(
			"/tmp/cache/v2/20200101000000/example.com/deep/path",
			{ recursive: true },
		);
	});

	// Criterion 4: partial tmp file does not satisfy lookup (rename is the visibility boundary)
	it("writeContentTypeSidecar persists upstream type at <root>/.content-types/<sha-16>", async () => {
		const svc = makeService();
		await svc.writeContentTypeSidecar(
			"https://www.yahoo.com/r/ci",
			TIME,
			"text/html; charset=utf-8",
		);

		expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
		const [path, contents] = (mockFs.writeFile as jest.Mock).mock.calls[0] as [string, string];
		expect(path).toMatch(
			/^\/tmp\/cache\/v2\/20200101000000\/www\.yahoo\.com\/\.content-types\/[0-9a-f]{16}$/,
		);
		expect(contents).toBe("text/html; charset=utf-8");
		// Parent dir is created before the write to match the existing sentinel
		// pattern — required when this is the first sidecar for a fresh host.
		expect(mockFs.mkdir).toHaveBeenCalledWith(
			expect.stringMatching(/\/www\.yahoo\.com\/\.content-types$/),
			{ recursive: true },
		);
	});

	it("writeContentTypeSidecar derives the same key for the same URL across calls", async () => {
		// Lookup reads via buildPerUrlSubpath; this write MUST land on the
		// exact path lookup will probe, or the sidecar is unreachable.
		const svc = makeService();
		await svc.writeContentTypeSidecar("https://example.com/r/ci", TIME, "text/html");
		await svc.writeContentTypeSidecar("https://example.com/r/ci", TIME, "text/html");
		const first = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		const second = (mockFs.writeFile as jest.Mock).mock.calls[1][0] as string;
		expect(first).toBe(second);
	});

	it("writes to a .tmp sibling before renaming — tmp path differs from final path", async () => {
		const svc = makeService();
		const url = "https://example.com/asset.js";
		const dest = svc.computeAbsPath(url, TIME);

		await svc.writeFile(url, TIME, Buffer.from("var x=1;"));

		const writtenPath = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		const [renameSrc, renameDest] = (mockFs.rename as jest.Mock).mock.calls[0] as [string, string];

		// tmp file path must differ from destination
		expect(writtenPath).not.toBe(dest);
		expect(writtenPath).toBe(`${dest}.tmp`);
		// rename moves tmp → dest
		expect(renameSrc).toBe(`${dest}.tmp`);
		expect(renameDest).toBe(dest);
	});

	it("rename happens after writeFile — order of operations is tmp-write then rename", async () => {
		const order: string[] = [];
		(mockFs.writeFile as jest.Mock).mockImplementation(async () => {
			order.push("writeFile");
		});
		(mockFs.rename as jest.Mock).mockImplementation(async () => {
			order.push("rename");
		});

		const svc = makeService();
		await svc.writeFile("https://example.com/x.html", TIME, Buffer.from(""));

		expect(order).toEqual(["writeFile", "rename"]);
	});

	// Criterion 2 also applies to writeFile: traversal rejected before any fs call
	it("rejects path-traversal URL with status 400 without touching fs", async () => {
		const svc = makeService();
		await expect(
			svc.writeFile("https://example.com/%2e%2e%2fetc%2fpasswd", TIME, Buffer.from("evil")),
		).rejects.toMatchObject({ status: 400 });
		expect(mockFs.writeFile).not.toHaveBeenCalled();
		expect(mockFs.rename).not.toHaveBeenCalled();
	});

	it("concurrent writes to the same dest deduplicate — exactly one tmp write and one rename", async () => {
		// Reproduces the prewarm race: two concurrent prewarm tasks download the
		// same asset and both call writeFile. Only one rename must reach the fs;
		// the second caller piggybacks on the first's in-flight promise.
		const svc = makeService();
		const url = "https://example.com/page.html";
		const data = Buffer.from("content");

		await Promise.all([
			svc.writeFile(url, TIME, data),
			svc.writeFile(url, TIME, data),
		]);

		expect(mockFs.rename).toHaveBeenCalledTimes(1);
		expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
	});
});

describe("CacheService.handleCacheClear (v2)", () => {
	type Captured = { statusCode: number; body: string; headers: Record<string, string> };

	const makeReq = (query = "") =>
		({ url: `/cache${query}` }) as import("node:http").IncomingMessage;

	const makeRes = (): {
		res: import("node:http").ServerResponse;
		captured: Captured;
	} => {
		const captured: Captured = { statusCode: 0, body: "", headers: {} };
		const fakeRes = {
			setHeader: jest.fn((k: string, v: string) => {
				captured.headers[k] = v;
			}),
			writeHead: jest.fn((code: number) => {
				captured.statusCode = code;
				return {
					end: jest.fn((b?: string) => {
						captured.body = b ?? "";
					}),
				};
			}),
		} as unknown as import("node:http").ServerResponse;
		return { res: fakeRes, captured };
	};

	it("returns 410 Gone with migration note when ?type= is supplied", async () => {
		const svc = makeService();
		const { res, captured } = makeRes();
		await svc.handleCacheClear(makeReq("?type=html"), res);

		expect(captured.statusCode).toBe(410);
		expect(captured.headers["Content-Type"]).toBe("application/json");
		const body = JSON.parse(captured.body);
		expect(body.error).toBe("type filter not supported in v2 layout; use domain filter");
		// Must not touch fs when rejecting the request.
		expect(mockFs.rm).not.toHaveBeenCalled();
		expect(mockFs.readdir).not.toHaveBeenCalled();
	});

	it("no filter: recursively rm's the entire v2 root and returns deleted/total counts", async () => {
		// /tmp/cache/v2/{T1,T2}/{example.com,other.com}
		(mockFs.readdir as jest.Mock)
			.mockResolvedValueOnce(["20200101000000", "20210101000000"]) // times under v2
			.mockResolvedValueOnce(["example.com", "other.com"]) // hosts under T1
			.mockResolvedValueOnce(["example.com"]); // hosts under T2
		(mockFs.rm as jest.Mock).mockResolvedValue(undefined);

		const svc = makeService();
		const { res, captured } = makeRes();
		await svc.handleCacheClear(makeReq(""), res);

		expect(mockFs.rm).toHaveBeenCalledWith("/tmp/cache/v2", {
			recursive: true,
			force: true,
		});
		expect(captured.statusCode).toBe(200);
		const body = JSON.parse(captured.body);
		expect(body).toEqual({ deleted: 3, total: 3 });
	});

	it("domain filter (exact match): only removes matching host directories", async () => {
		(mockFs.readdir as jest.Mock)
			.mockResolvedValueOnce(["20200101000000"]) // times under v2
			.mockResolvedValueOnce(["example.com", "other.com"]); // hosts under T1
		(mockFs.rm as jest.Mock).mockResolvedValue(undefined);

		const svc = makeService();
		const { res, captured } = makeRes();
		await svc.handleCacheClear(makeReq("?domain=example.com"), res);

		expect(mockFs.rm).toHaveBeenCalledTimes(1);
		expect(mockFs.rm).toHaveBeenCalledWith("/tmp/cache/v2/20200101000000/example.com", {
			recursive: true,
			force: true,
		});
		const body = JSON.parse(captured.body);
		expect(body).toEqual({ deleted: 1, total: 2 });
	});

	it("domain filter with *.example.com matches subdomains AND the apex", async () => {
		(mockFs.readdir as jest.Mock)
			.mockResolvedValueOnce(["20200101000000"])
			.mockResolvedValueOnce(["example.com", "sub.example.com", "other.com"]);
		(mockFs.rm as jest.Mock).mockResolvedValue(undefined);

		const svc = makeService();
		const { res, captured } = makeRes();
		await svc.handleCacheClear(makeReq("?domain=*.example.com"), res);

		// Removes example.com and sub.example.com; skips other.com
		expect(mockFs.rm).toHaveBeenCalledTimes(2);
		expect(mockFs.rm).toHaveBeenCalledWith("/tmp/cache/v2/20200101000000/example.com", {
			recursive: true,
			force: true,
		});
		expect(mockFs.rm).toHaveBeenCalledWith("/tmp/cache/v2/20200101000000/sub.example.com", {
			recursive: true,
			force: true,
		});
		const body = JSON.parse(captured.body);
		expect(body).toEqual({ deleted: 2, total: 3 });
	});

	it("returns 200 with deleted=0,total=0 when v2 root does not exist", async () => {
		(mockFs.readdir as jest.Mock).mockRejectedValueOnce(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		(mockFs.rm as jest.Mock).mockResolvedValue(undefined);

		const svc = makeService();
		const { res, captured } = makeRes();
		await svc.handleCacheClear(makeReq(""), res);

		expect(captured.statusCode).toBe(200);
		const body = JSON.parse(captured.body);
		expect(body).toEqual({ deleted: 0, total: 0 });
	});

	it("returns 500 when fs.rm throws during the full clear", async () => {
		(mockFs.readdir as jest.Mock).mockResolvedValue([]);
		(mockFs.rm as jest.Mock).mockRejectedValue(new Error("EPERM"));

		const svc = makeService();
		const { res, captured } = makeRes();
		await svc.handleCacheClear(makeReq(""), res);

		expect(captured.statusCode).toBe(500);
		const body = JSON.parse(captured.body);
		expect(body.error).toBe("cache clear failed");
	});
});
