// Make abortableSleep a no-op so retry tests don't actually wait
jest.mock("../../src/lib/shutdown", () => ({
	ShutdownController: jest.requireActual("../../src/lib/shutdown").ShutdownController,
	abortableSleep: jest.fn().mockResolvedValue(undefined),
}));

import pino from "pino";
import { WaybackClient } from "../../src/clients/wayback";
import { ArchiveRequestQueue } from "../../src/lib/queue";
import { ShutdownController } from "../../src/lib/shutdown";

const ARCHIVE_PREFIX = "https://web.archive.org/web";
const VALID_URL = `${ARCHIVE_PREFIX}/20200101000000/http://example.com/`;

const makeClient = (overrides: { archiveMaxRetries?: number } = {}) => {
	const queue = new ArchiveRequestQueue(5, 100, 100);
	const shutdown = new ShutdownController();
	const logger = pino({ level: "silent" });
	return new WaybackClient(queue, shutdown, logger, {
		archivePrefix: ARCHIVE_PREFIX,
		archiveMaxRetries: overrides.archiveMaxRetries ?? 3,
	});
};

const makeRetryableError = (code: string) =>
	Object.assign(new Error(`connect ${code}`), { cause: { code } });

beforeEach(() => {
	jest.restoreAllMocks();
});

describe("WaybackClient.fetch", () => {
	it("resolves with the fetch response for a valid archive URL", async () => {
		jest.spyOn(global, "fetch").mockResolvedValueOnce(new Response(null, { status: 200 }));
		const result = await makeClient().fetch(VALID_URL);
		expect(result.status).toBe(200);
	});

	it("rejects non-archive URLs (SSRF guard)", async () => {
		await expect(makeClient().fetch("http://internal.corp/secret")).rejects.toThrow(
			"Refusing to fetch non-archive URL",
		);
	});

	it("passes document headers by default", async () => {
		const spy = jest
			.spyOn(global, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		await makeClient().fetch(VALID_URL);
		const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers["Sec-Fetch-Dest"]).toBe("document");
	});

	it("passes image headers for image resource type", async () => {
		const spy = jest
			.spyOn(global, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		await makeClient().fetch(VALID_URL, "image");
		const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers["Sec-Fetch-Dest"]).toBe("image");
	});

	it("passes style headers for style resource type", async () => {
		const spy = jest
			.spyOn(global, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		await makeClient().fetch(VALID_URL, "style");
		const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers["Sec-Fetch-Dest"]).toBe("style");
	});

	it("retries on retryable error code and eventually resolves", async () => {
		let calls = 0;
		jest.spyOn(global, "fetch").mockImplementation(async () => {
			calls++;
			if (calls === 1) throw makeRetryableError("ECONNRESET");
			return new Response(null, { status: 200 });
		});

		const result = await makeClient({ archiveMaxRetries: 1 }).fetch(VALID_URL);
		expect(result.status).toBe(200);
		expect(calls).toBe(2);
	});

	it("throws after exhausting all retries", async () => {
		jest.spyOn(global, "fetch").mockRejectedValue(makeRetryableError("ECONNREFUSED"));
		await expect(makeClient({ archiveMaxRetries: 2 }).fetch(VALID_URL)).rejects.toThrow(
			"connect ECONNREFUSED",
		);
	});

	it("does not retry non-retryable errors", async () => {
		let calls = 0;
		jest.spyOn(global, "fetch").mockImplementation(async () => {
			calls++;
			throw new Error("404 Not Found");
		});

		await expect(makeClient().fetch(VALID_URL)).rejects.toThrow("404 Not Found");
		expect(calls).toBe(1);
	});
});
