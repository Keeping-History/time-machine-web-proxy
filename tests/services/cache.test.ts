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
		open: jest.fn(),
	},
	// createWriteStream is a sync constructor (not under promises). Tests that
	// exercise writeStream override the return value to a PassThrough so
	// pipeline can resolve; the default jest.fn() return is enough for tests
	// that never call writeStream.
	createWriteStream: jest.fn(),
}));

import { createWriteStream, promises as fs } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import pino from "pino";
import { CacheService } from "../../src/services/cache";

const logger = pino({ level: "silent" });

const makeService = (cacheEnabled = true, notFoundTtlDays = 30) =>
	new CacheService({ cacheDir: "/tmp/cache", cacheEnabled, notFoundTtlDays }, logger);

const mockFs = fs as jest.Mocked<typeof fs>;

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

// Make the primary/fallback asset file "exist" with `size` bytes while keeping
// sentinel paths (.notfound / .notfound-tentative) absent, so negative-cache
// branches don't fire. Mirrors the size-aware lookup, which treats a zero-byte
// file as a miss. lookup() probes existence via fs.stat (not fs.access), so the
// asset's presence is expressed through the stat mock.
const presentFile = (size = 11) =>
	(mockFs.stat as jest.Mock).mockImplementation((p: string) =>
		p.includes("/.notfound")
			? Promise.reject(enoent())
			: Promise.resolve({ size, mtimeMs: Date.now() }),
	);

function fakeFileHandle(data: Buffer) {
	return {
		read: jest.fn().mockImplementation((buf: Buffer, _off: number, len: number) => {
			const n = Math.min(data.length, len);
			data.copy(buf, 0, 0, n);
			return Promise.resolve({ bytesRead: n });
		}),
		close: jest.fn().mockResolvedValue(undefined),
	};
}

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
		expect(mockFs.stat).not.toHaveBeenCalled();
	});

	it("HIT: returns { absPath, contentType } when file exists", async () => {
		presentFile();
		const svc = makeService();
		const result = await svc.lookup("https://example.com/about.html", TIME);
		expect(result).toEqual({
			absPath: "/tmp/cache/v2/20200101000000/example.com/about.html",
			contentType: "text/html",
		});
		expect(mockFs.stat).toHaveBeenCalledTimes(1);
	});

	it("MISS: returns null when the file does not exist", async () => {
		// Default stat mock rejects ENOENT for every path (see beforeEach).
		const svc = makeService();
		const result = await svc.lookup("https://example.com/missing.html", TIME);
		expect(result).toBeNull();
	});

	it("MISS: treats a zero-byte file as absent so the worker re-fetches it", async () => {
		// Poison entry: file exists but is empty (e.g. a writer that piped an
		// already-consumed stream then renamed it into place). Serving it would
		// return 200 + correct content-type + an empty body — a permanently
		// broken asset. lookup must report a miss so the caller re-fetches.
		(mockFs.stat as jest.Mock).mockImplementation((p: string) =>
			p.includes("/.notfound")
				? Promise.reject(enoent())
				: Promise.resolve({ size: 0, mtimeMs: Date.now() }),
		);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/empty.gif", TIME);
		expect(result).toBeNull();
	});

	it("directory URL ending with / resolves to <root>/index.html", async () => {
		presentFile();
		const svc = makeService();
		const result = await svc.lookup("https://example.com/about/", TIME);
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/about/index.html");
		expect(result?.contentType).toBe("text/html");
	});

	it("root path / resolves to <root>/index.html", async () => {
		presentFile();
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
		expect(mockFs.stat).not.toHaveBeenCalled();
	});

	it("derives content-type from file extension via mime-types", async () => {
		presentFile();
		const svc = makeService();
		const cssResult = await svc.lookup("https://example.com/style.css", TIME);
		expect(cssResult?.contentType).toBe("text/css");
		const pngResult = await svc.lookup("https://example.com/img.png", TIME);
		expect(pngResult?.contentType).toBe("image/png");
	});

	it("preserves 'www.' in host so the cache key matches the worker write path", async () => {
		presentFile();
		const svc = makeService();
		const result = await svc.lookup("https://www.example.com/about.html", TIME);
		// www.example.com and example.com are stored separately — they can
		// legitimately serve different content; collapsing risks poisoning.
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/www.example.com/about.html");
	});

	it("returns application/octet-stream for unknown extension", async () => {
		presentFile();
		const svc = makeService();
		const result = await svc.lookup("https://example.com/file.unknownext", TIME);
		expect(result?.contentType).toBe("application/octet-stream");
	});

	it("uses the .content-types sidecar verbatim when present (overrides extension)", async () => {
		// The sidecar stores the upstream Content-Type from the direct fetch
		// path. It takes precedence over mime-types extension lookup so a
		// charset hint or a non-default type (e.g. application/xhtml+xml) is
		// preserved across reads.
		presentFile();
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

	it.each([
		["text/html", "https://www.sun.com/template/sunstyle.css", "text/css"],
		["text/plain", "https://www.sun.com/template/sunstyle.css", "text/css"],
		["application/x-pointplus", "https://www.sun.com/template/sunstyle.css", "text/css"],
		["text/html", "https://example.com/app.js", "text/javascript"],
		["text/html", "https://example.com/logo.png", "image/png"],
	])("overrides sidecar '%s' with extension MIME type for %s", async (sidecarType, url, expected) => {
		presentFile();
		(mockFs.readFile as jest.Mock).mockImplementation((p: string) => {
			if (p.includes("/.content-types/")) return Promise.resolve(sidecarType);
			if (p.endsWith(".resolved-time"))
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			return Promise.resolve(Buffer.from(""));
		});
		const result = await makeService().lookup(url, TIME);
		expect(result?.contentType).toBe(expected);
	});

	it("preserves sidecar charset for CSS when sidecar type is correct", async () => {
		presentFile();
		(mockFs.readFile as jest.Mock).mockImplementation((p: string) => {
			if (p.includes("/.content-types/")) return Promise.resolve("text/css; charset=utf-8");
			if (p.endsWith(".resolved-time"))
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			return Promise.resolve(Buffer.from(""));
		});
		const result = await makeService().lookup(
			"https://www.sun.com/template/sunstyle.css",
			TIME,
		);
		expect(result?.contentType).toBe("text/css; charset=utf-8");
	});

	it("does not override sidecar when extension is .html and sidecar is text/html", async () => {
		presentFile();
		(mockFs.readFile as jest.Mock).mockImplementation((p: string) => {
			if (p.includes("/.content-types/")) return Promise.resolve("text/html; charset=utf-8");
			if (p.endsWith(".resolved-time"))
				return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			return Promise.resolve(Buffer.from(""));
		});
		const result = await makeService().lookup("https://example.com/page.html", TIME);
		expect(result?.contentType).toBe("text/html; charset=utf-8");
	});

	it("sniffs HTML for extensionless URLs when no sidecar exists (legacy cache)", async () => {
		// The user-reported bug: http://www.yahoo.com/r/ci has no extension,
		// mime-types returns false, and pre-fix the response went out as
		// application/octet-stream — the browser downloaded it. Sniffing the
		// cached body for an HTML signature serves it correctly without a
		// cache wipe.
		presentFile();
		(mockFs.readFile as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		(mockFs.open as jest.Mock).mockResolvedValue(
			fakeFileHandle(
				Buffer.from('<HTML><HEAD><meta http-equiv="refresh" content="0;url=/"></HEAD></HTML>'),
			),
		);
		const svc = makeService();
		const result = await svc.lookup("https://www.yahoo.com/r/ci", TIME);
		expect(result?.contentType).toBe("text/html; charset=utf-8");
	});

	it("sniff recognises an XML prolog", async () => {
		presentFile();
		(mockFs.readFile as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		(mockFs.open as jest.Mock).mockResolvedValue(
			fakeFileHandle(Buffer.from('<?xml version="1.0"?><rss></rss>')),
		);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/feed", TIME);
		expect(result?.contentType).toBe("application/xml");
	});

	it("sniff does NOT run when the URL has an extension (avoids false positives)", async () => {
		// `.unknownext` is non-empty — mime-types returns false, but we MUST
		// NOT sniff: an extension was specified, so the user/server intended
		// a particular type. Falsely promoting binary blobs to text/html based
		// on a stray "<html" byte sequence would corrupt downloads.
		presentFile();
		(mockFs.readFile as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/file.unknownext", TIME);
		expect(result?.contentType).toBe("application/octet-stream");
		// sniffContentType must never be called for URLs with an extension —
		// fs.open is the entry point for the partial-read sniff path.
		expect(mockFs.open).not.toHaveBeenCalled();
	});

	it("sniff returns octet-stream for non-HTML/XML extensionless content", async () => {
		// Random binary bytes should NOT be promoted to text/html. The
		// sniffer's allowlist of signatures is intentionally narrow.
		presentFile();
		(mockFs.readFile as jest.Mock).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
		);
		(mockFs.open as jest.Mock).mockResolvedValue(
			fakeFileHandle(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
		);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/blob", TIME);
		expect(result?.contentType).toBe("application/octet-stream");
	});

	// www.example.com and example.com may serve different content and the
	// Wayback Machine archives them as distinct URLs. The cache key preserves
	// that distinction so a hit on one form never returns content from the
	// other.
	it("www. and apex hosts resolve to DISTINCT cache entries", async () => {
		presentFile();
		const svc = makeService();
		const a = await svc.lookup("https://www.example.com/about.html", TIME);
		const b = await svc.lookup("https://example.com/about.html", TIME);
		expect(a?.absPath).toBe("/tmp/cache/v2/20200101000000/www.example.com/about.html");
		expect(b?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/about.html");
		expect(a?.absPath).not.toBe(b?.absPath);
	});

	it("lookup for a www. URL uses the www. hostname verbatim in the cache path", async () => {
		presentFile();
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
		// Primary path stat misses; the directory-index fallback stat succeeds.
		(mockFs.stat as jest.Mock)
			.mockRejectedValueOnce(enoent())
			.mockResolvedValueOnce({ size: 11, mtimeMs: Date.now() });
		const svc = makeService();
		const result = await svc.lookup("https://example.com/mac", TIME);
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/mac/index.html");
		expect(result?.contentType).toBe("text/html");
	});

	it("prefers the exact file when it exists; does not probe the index fallback", async () => {
		presentFile();
		const svc = makeService();
		const result = await svc.lookup("https://example.com/mac.html", TIME);
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/mac.html");
		expect(mockFs.stat).toHaveBeenCalledTimes(1);
	});

	it("returns null when neither <root>/<path> nor <root>/<path>/index.html exists", async () => {
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
		// Content file misses (stat rejects for non-sentinel paths); a sentinel
		// stat succeeds with a recent mtime.
		(mockFs.stat as jest.Mock).mockImplementation((p: string) =>
			p.includes("/.notfound")
				? Promise.resolve({ mtimeMs: Date.now() })
				: Promise.reject(enoent()),
		);
		const svc = makeService();
		await expect(svc.lookup(URL, TIME)).rejects.toMatchObject({
			status: 404,
		});
	});

	it("lookup returns null when neither file nor sentinel exists (unchanged miss path)", async () => {
		// Default stat mock rejects ENOENT for every path (see beforeEach).
		const svc = makeService();
		const result = await svc.lookup(URL, TIME);
		expect(result).toBeNull();
	});

	it("lookup returns HIT when file exists, even if sentinel could exist (file wins)", async () => {
		// File stat succeeds — sentinel check should not be reached.
		presentFile();
		const svc = makeService();
		const result = await svc.lookup("https://example.com/about.html", TIME);
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/about.html");
		// Exactly one fs.stat call (for the file) — sentinel not consulted.
		expect(mockFs.stat).toHaveBeenCalledTimes(1);
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
		(mockFs.rename as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		await svc.writeResolvedTimeSidecar(TIME, "https://www.example.com/", "20010822231227");
		const finalPath = "/tmp/cache/v2/20200101000000/www.example.com/.resolved-time";
		const tmpPath = `${finalPath}.tmp`;
		const path = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		const content = (mockFs.writeFile as jest.Mock).mock.calls[0][1] as string;
		expect(path).toBe(tmpPath);
		expect(content).toBe("20010822231227");
		expect(mockFs.rename).toHaveBeenCalledWith(tmpPath, finalPath);
	});

	it("lookup populates CacheHit.archiveTime from the sidecar when present", async () => {
		presentFile();
		(mockFs.readFile as jest.Mock).mockImplementation((p: string) => {
			if (p.endsWith(".resolved-time")) return Promise.resolve("20010822231227");
			return Promise.resolve(Buffer.from(""));
		});
		const svc = makeService();
		const result = await svc.lookup("https://www.example.com/about.html", TIME);
		expect(result?.archiveTime).toBe("20010822231227");
	});

	it("lookup omits archiveTime when no sidecar exists (legacy cache HIT)", async () => {
		presentFile();
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
		presentFile();
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
		// Content file misses (non-sentinel stat rejects); permanent sentinel
		// exists but is older than TTL; tentative sentinel does NOT exist.
		const ttlDays = 7;
		const oldMtimeMs = Date.now() - (ttlDays + 1) * 24 * 60 * 60 * 1000;
		(mockFs.stat as jest.Mock).mockImplementation((p: string) => {
			if (p.includes("/.notfound-tentative/")) return Promise.reject(enoent());
			if (p.includes("/.notfound/")) return Promise.resolve({ mtimeMs: oldMtimeMs });
			return Promise.reject(enoent());
		});
		(mockFs.unlink as jest.Mock).mockResolvedValue(undefined);

		const svc = makeService(true, ttlDays);
		const result = await svc.lookup(URL, TIME);

		expect(result).toBeNull();
		expect(mockFs.unlink).toHaveBeenCalledTimes(1);
	});

	it("lookup throws 404 for a fresh sentinel within TTL", async () => {
		// Content file misses; permanent sentinel is recent (within TTL);
		// tentative sentinel does NOT exist.
		const ttlDays = 7;
		const freshMtimeMs = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day old
		(mockFs.stat as jest.Mock).mockImplementation((p: string) => {
			if (p.includes("/.notfound-tentative/")) return Promise.reject(enoent());
			if (p.includes("/.notfound/")) return Promise.resolve({ mtimeMs: freshMtimeMs });
			return Promise.reject(enoent());
		});

		const svc = makeService(true, ttlDays);
		await expect(svc.lookup(URL, TIME)).rejects.toMatchObject({ status: 404 });
		expect(mockFs.unlink).not.toHaveBeenCalled();
	});

	it("expired sentinel unlink is logged with [cache] sentinel-expired", async () => {
		const ttlDays = 30;
		const oldMtimeMs = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days old
		(mockFs.stat as jest.Mock).mockImplementation((p: string) => {
			if (p.includes("/.notfound-tentative/")) return Promise.reject(enoent());
			if (p.includes("/.notfound/")) return Promise.resolve({ mtimeMs: oldMtimeMs });
			return Promise.reject(enoent());
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
		// Both sentinels exist and would count as fresh. Lookup must short-circuit
		// on the tentative without ever consulting the permanent sentinel. The
		// content-file probes (now fs.stat) miss for non-sentinel paths.
		const freshMtimeMs = Date.now() - 10 * 60 * 1000; // 10 minutes old
		(mockFs.stat as jest.Mock).mockImplementation((p: string) =>
			p.includes("/.notfound")
				? Promise.resolve({ mtimeMs: freshMtimeMs })
				: Promise.reject(enoent()),
		);
		const svc = makeService();
		await expect(svc.lookup(URL, TIME)).rejects.toMatchObject({ status: 404 });
		// The permanent sentinel (.notfound/<key>, not -tentative) is never statted.
		const statPaths = (mockFs.stat as jest.Mock).mock.calls.map((c) => c[0] as string);
		expect(statPaths.some((p) => p.includes("/.notfound-tentative/"))).toBe(true);
		expect(statPaths.some((p) => /\/\.notfound\/[0-9a-f]{16}$/.test(p))).toBe(false);
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
		// atomicWrite writes to a .tmp sibling first…
		expect(path).toMatch(
			/^\/tmp\/cache\/v2\/20200101000000\/www\.yahoo\.com\/\.content-types\/[0-9a-f]{16}\.tmp$/,
		);
		expect(contents).toBe("text/html; charset=utf-8");
		// …then renames to the final path so readers never see a partial file.
		expect(mockFs.rename).toHaveBeenCalledWith(
			expect.stringMatching(/\/\.content-types\/[0-9a-f]{16}\.tmp$/),
			expect.stringMatching(/\/\.content-types\/[0-9a-f]{16}$/),
		);
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

describe("CacheService.writeStream", () => {
	const TIME = "20200101000000";
	const mockCreateWriteStream = createWriteStream as jest.Mock;

	beforeEach(() => {
		(mockFs.mkdir as jest.Mock).mockResolvedValue(undefined);
		(mockFs.rename as jest.Mock).mockResolvedValue(undefined);
		// Default: return a fresh PassThrough each call so pipeline can resolve.
		mockCreateWriteStream.mockImplementation(() => new PassThrough());
	});

	it("opens createWriteStream on the .tmp path then renames to the final destination", async () => {
		const svc = makeService();
		const url = "https://example.com/asset.bin";
		const dest = svc.computeAbsPath(url, TIME);

		await svc.writeStream(url, TIME, Readable.from([Buffer.from("hello")]));

		const openedPath = mockCreateWriteStream.mock.calls[0][0] as string;
		expect(openedPath).toBe(`${dest}.tmp`);

		const [renameSrc, renameDest] = (mockFs.rename as jest.Mock).mock.calls[0] as [string, string];
		expect(renameSrc).toBe(`${dest}.tmp`);
		expect(renameDest).toBe(dest);
	});

	it("creates the parent directory before opening the write stream", async () => {
		const order: string[] = [];
		(mockFs.mkdir as jest.Mock).mockImplementation(async () => {
			order.push("mkdir");
		});
		mockCreateWriteStream.mockImplementation(() => {
			order.push("createWriteStream");
			return new PassThrough();
		});

		const svc = makeService();
		await svc.writeStream(
			"https://example.com/deep/path/file.bin",
			TIME,
			Readable.from([Buffer.from("x")]),
		);

		expect(order[0]).toBe("mkdir");
		expect(order).toContain("createWriteStream");
		expect(mockFs.mkdir).toHaveBeenCalledWith(
			"/tmp/cache/v2/20200101000000/example.com/deep/path",
			{ recursive: true },
		);
	});

	it("rejects path-traversal URL with status 400 without touching fs", async () => {
		const svc = makeService();
		await expect(
			svc.writeStream(
				"https://example.com/%2e%2e%2fetc%2fpasswd",
				TIME,
				Readable.from([Buffer.from("evil")]),
			),
		).rejects.toMatchObject({ status: 400 });
		expect(mockCreateWriteStream).not.toHaveBeenCalled();
		expect(mockFs.rename).not.toHaveBeenCalled();
	});

	it("rename happens AFTER the pipeline resolves — partial tmp files are never visible", async () => {
		const order: string[] = [];
		const pipelineGate: { release: (() => void) | null } = { release: null };
		mockCreateWriteStream.mockImplementation(() => {
			const pass = new PassThrough();
			const origEnd = pass.end.bind(pass);
			pass.end = ((...args: unknown[]) => {
				// Defer the actual end (which signals pipeline completion) until
				// the test releases it — this lets us assert rename is NOT called
				// during the window where the tmp file is still being written.
				pipelineGate.release = () => {
					order.push("pipeline-end");
					(origEnd as (...a: unknown[]) => unknown)(...args);
				};
				return pass;
			}) as typeof pass.end;
			return pass;
		});
		(mockFs.rename as jest.Mock).mockImplementation(async () => {
			order.push("rename");
		});

		const svc = makeService();
		const writePromise = svc.writeStream(
			"https://example.com/asset.bin",
			TIME,
			Readable.from([Buffer.from("data")]),
		);

		// Give the pipeline a tick to start
		await new Promise((r) => setImmediate(r));
		expect(order).not.toContain("rename");

		// Release the pipeline; rename should follow
		pipelineGate.release?.();
		await writePromise;

		expect(order.indexOf("pipeline-end")).toBeLessThan(order.indexOf("rename"));
	});

	it("concurrent stream writes to the same dest deduplicate via writeInflight", async () => {
		const svc = makeService();
		const url = "https://example.com/asset.bin";

		await Promise.all([
			svc.writeStream(url, TIME, Readable.from([Buffer.from("a")])),
			svc.writeStream(url, TIME, Readable.from([Buffer.from("b")])),
		]);

		// Only one tmp open + one rename — the second caller piggybacks
		expect(mockCreateWriteStream).toHaveBeenCalledTimes(1);
		expect(mockFs.rename).toHaveBeenCalledTimes(1);
	});

	it("drains the losing Readable via resume() when writeInflight short-circuits", async () => {
		const svc = makeService();
		const url = "https://example.com/asset.bin";

		// Hold the first write open until we can confirm the second stream is drained
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((r) => { releaseFirst = r; });
		mockCreateWriteStream.mockImplementationOnce(() => {
			const pass = new PassThrough();
			// Defer end until gate releases so writeInflight stays active
			const origEnd = pass.end.bind(pass);
			pass.end = ((...args: unknown[]) => {
				void firstGate.then(() => (origEnd as (...a: unknown[]) => unknown)(...args));
				return pass;
			}) as typeof pass.end;
			return pass;
		});

		const second = Readable.from([Buffer.from("b")]);
		const endedSpy = jest.fn();
		second.on("end", endedSpy);

		const firstPromise = svc.writeStream(url, TIME, Readable.from([Buffer.from("a")]));
		// Give the first write a tick to register in writeInflight
		await new Promise((r) => setImmediate(r));

		const secondPromise = svc.writeStream(url, TIME, second);

		// Release the first write and let both settle
		releaseFirst();
		await Promise.all([firstPromise, secondPromise]);

		// second Readable must have been fully consumed (resume'd)
		expect(endedSpy).toHaveBeenCalled();
		// Still only one write path executed
		expect(mockCreateWriteStream).toHaveBeenCalledTimes(1);
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
