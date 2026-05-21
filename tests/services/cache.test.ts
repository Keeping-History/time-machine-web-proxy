jest.mock("node:fs", () => ({
	promises: {
		readFile: jest.fn(),
		writeFile: jest.fn(),
		readdir: jest.fn(),
		unlink: jest.fn(),
		access: jest.fn(),
		rm: jest.fn(),
		mkdir: jest.fn(),
	},
}));

import { promises as fs } from "node:fs";
import pino from "pino";
import { CacheService } from "../../src/services/cache";

const logger = pino({ level: "silent" });

const makeService = (cacheEnabled = true) =>
	new CacheService({ cacheDir: "/tmp/cache", cacheEnabled }, logger);

const mockFs = fs as jest.Mocked<typeof fs>;

beforeEach(() => jest.resetAllMocks());

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

	it("strips leading 'www.' from host so lookup matches worker's bareHost write path", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://www.example.com/about.html", TIME);
		// Worker writes to <root>/example.com/, NOT <root>/www.example.com/.
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/example.com/about.html");
	});

	it("returns application/octet-stream for unknown extension", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/file.unknownext", TIME);
		expect(result?.contentType).toBe("application/octet-stream");
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
		// file access fails; sentinel access succeeds.
		(mockFs.access as jest.Mock).mockImplementation((p: string) => {
			if (p.includes("/.notfound/")) return Promise.resolve(undefined);
			return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
		});
		const svc = makeService();
		await expect(svc.lookup(URL, TIME)).rejects.toMatchObject({
			status: 404,
		});
	});

	it("lookup returns null when neither file nor sentinel exists (unchanged miss path)", async () => {
		(mockFs.access as jest.Mock).mockRejectedValue(
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

	it("sentinel root dir strips 'www.' to match worker write path", async () => {
		(mockFs.mkdir as jest.Mock).mockResolvedValue(undefined);
		(mockFs.writeFile as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		await svc.writeNotFoundSentinel(TIME, "https://www.example.com/about");
		const writtenPath = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		expect(writtenPath).toMatch(/^\/tmp\/cache\/v2\/20200101000000\/example\.com\/\.notfound\//);
	});

	it("writeResolvedTimeSidecar writes <root>/.resolved-time with the timestamp", async () => {
		(mockFs.mkdir as jest.Mock).mockResolvedValue(undefined);
		(mockFs.writeFile as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		await svc.writeResolvedTimeSidecar(TIME, "https://www.example.com/", "20010822231227");
		const path = (mockFs.writeFile as jest.Mock).mock.calls[0][0] as string;
		const content = (mockFs.writeFile as jest.Mock).mock.calls[0][1] as string;
		expect(path).toBe("/tmp/cache/v2/20200101000000/example.com/.resolved-time");
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
