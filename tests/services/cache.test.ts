jest.mock("node:fs", () => ({
	promises: {
		readFile: jest.fn(),
		writeFile: jest.fn(),
		readdir: jest.fn(),
		unlink: jest.fn(),
		access: jest.fn(),
	},
	createHash: jest.requireActual("node:crypto").createHash,
}));

import { promises as fs } from "node:fs";
import pino from "pino";
import type { CacheEntry } from "../../src/models/cache";
import { CacheService } from "../../src/services/cache";

const logger = pino({ level: "silent" });

const makeService = (cacheEnabled = true) =>
	new CacheService({ cacheDir: "/tmp/cache", cacheEnabled }, logger);

const validEntry: CacheEntry = {
	contentType: "text/html",
	archiveUrl: "https://web.archive.org/web/20200101000000/http://example.com/",
	archiveTime: "20200101000000",
	body: "<html></html>",
	isHtml: true,
	isCss: false,
};

const mockFs = fs as jest.Mocked<typeof fs>;

beforeEach(() => jest.resetAllMocks());

describe("CacheService.get", () => {
	it("returns null when cacheEnabled is false", async () => {
		const svc = makeService(false);
		expect(await svc.get("http://example.com/", "20200101000000")).toBeNull();
		expect(mockFs.readFile).not.toHaveBeenCalled();
	});

	it("returns null on ENOENT", async () => {
		const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		mockFs.readFile.mockRejectedValue(err);
		expect(await makeService().get("http://example.com/", "20200101000000")).toBeNull();
	});

	it("returns null when file content is not a valid CacheEntry", async () => {
		mockFs.readFile.mockResolvedValue('{"invalid":true}');
		expect(await makeService().get("http://example.com/", "20200101000000")).toBeNull();
	});

	it("returns the parsed entry when valid", async () => {
		mockFs.readFile.mockResolvedValue(JSON.stringify(validEntry));
		const result = await makeService().get("http://example.com/", "20200101000000");
		expect(result).toEqual(validEntry);
	});
});

describe("CacheService.put", () => {
	it("is a no-op when cacheEnabled is false", async () => {
		await makeService(false).put("http://example.com/", "20200101000000", validEntry);
		expect(mockFs.writeFile).not.toHaveBeenCalled();
	});

	it("writes the entry as JSON to the correct path", async () => {
		mockFs.writeFile.mockResolvedValue(undefined);
		await makeService().put("http://example.com/", "20200101000000", validEntry);
		expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
		const [filePath, content] = mockFs.writeFile.mock.calls[0];
		expect(filePath).toMatch(/^\/tmp\/cache\/.+\.json$/);
		expect(JSON.parse(content as string)).toEqual(validEntry);
	});

	it("uses a deterministic cache key (same url+time → same file)", async () => {
		mockFs.writeFile.mockResolvedValue(undefined);
		await makeService().put("http://example.com/", "20200101000000", validEntry);
		await makeService().put("http://example.com/", "20200101000000", validEntry);
		const path1 = mockFs.writeFile.mock.calls[0][0] as string;
		const path2 = mockFs.writeFile.mock.calls[1][0] as string;
		expect(path1).toBe(path2);
	});
});

describe("CacheService.handleCacheClear", () => {
	const makeReq = (query = "") =>
		({ url: `/_cache/clear${query}` }) as import("node:http").IncomingMessage;
	const makeRes = () => {
		const res = { headers: {} as Record<string, string>, statusCode: 0, body: "" };
		return {
			setHeader: jest.fn((k: string, v: string) => {
				res.headers[k] = v;
			}),
			writeHead: jest.fn((code: number) => {
				res.statusCode = code;
				return {
					end: jest.fn((b: string) => {
						res.body = b;
					}),
				};
			}),
			res,
		} as unknown as import("node:http").ServerResponse & { res: typeof res };
	};

	it("returns 200 with deleted count when no filters applied", async () => {
		(mockFs.readdir as jest.Mock).mockResolvedValue(["abc.json"]);
		mockFs.readFile.mockResolvedValue(JSON.stringify(validEntry));
		mockFs.unlink.mockResolvedValue(undefined);

		const res = makeRes();
		await makeService().handleCacheClear(makeReq(), res);

		expect(mockFs.unlink).toHaveBeenCalledTimes(1);
		const body = JSON.parse((res as unknown as { res: { body: string } }).res.body);
		expect(body.deleted).toBe(1);
		expect(body.errors).toBe(0);
	});

	it("skips files that do not match the type filter", async () => {
		const cssEntry: CacheEntry = {
			...validEntry,
			isHtml: false,
			isCss: true,
			contentType: "text/css",
		};
		(mockFs.readdir as jest.Mock).mockResolvedValue(["abc.json"]);
		mockFs.readFile.mockResolvedValue(JSON.stringify(cssEntry));
		mockFs.unlink.mockResolvedValue(undefined);

		const res = makeRes();
		await makeService().handleCacheClear(makeReq("?type=html"), res);

		expect(mockFs.unlink).not.toHaveBeenCalled();
	});

	it("skips files whose domain does not match", async () => {
		(mockFs.readdir as jest.Mock).mockResolvedValue(["abc.json"]);
		mockFs.readFile.mockResolvedValue(JSON.stringify(validEntry));
		mockFs.unlink.mockResolvedValue(undefined);

		const res = makeRes();
		await makeService().handleCacheClear(makeReq("?domain=other.com"), res);

		expect(mockFs.unlink).not.toHaveBeenCalled();
	});
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

	it("returns application/octet-stream for unknown extension", async () => {
		(mockFs.access as jest.Mock).mockResolvedValue(undefined);
		const svc = makeService();
		const result = await svc.lookup("https://example.com/file.unknownext", TIME);
		expect(result?.contentType).toBe("application/octet-stream");
	});
});
