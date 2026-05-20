jest.mock("node:fs", () => ({
	promises: {
		readFile: jest.fn(),
		writeFile: jest.fn(),
		readdir: jest.fn(),
		unlink: jest.fn(),
		access: jest.fn(),
		rm: jest.fn(),
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

	it("returns application/octet-stream for unknown extension", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/file.unknownext", TIME);
		expect(result?.contentType).toBe("application/octet-stream");
	});

	// The worker writes cache entries under the bare host (www.-stripped) because
	// normalizeBaseUrlInput drops the prefix when computing the canonical form.
	// The reader MUST use the same normalization or every www.* URL would miss
	// after a successful download — observed in production as a 502 on the
	// www.apple.com root request despite "Download completed (1 files)".
	it("normalizes www. host to bare host so reads match what the worker wrote", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://www.apple.com/", TIME);
		expect(result?.absPath).toBe("/tmp/cache/v2/20200101000000/apple.com/index.html");
	});

	it("www. and bare host resolve to the same cache entry", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const a = await svc.lookup("https://www.example.com/about.html", TIME);
		const b = await svc.lookup("https://example.com/about.html", TIME);
		expect(a?.absPath).toBe(b?.absPath);
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
