// Tests for src/lib/blocklist.ts — operator blocklist loaded from
// `<cacheDir>/config.json` ({ "blocked_domains": [...] }).
//
// Uses a real temp directory per test: the service's contract is mostly
// filesystem semantics (missing file, malformed content, reload-on-change),
// so mocking fs would test the mock.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { BlocklistService } from "../../src/lib/blocklist";

const logger = pino({ level: "silent" });

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "blocklist-test-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const writeConfig = (content: string): Promise<void> =>
	fs.writeFile(join(dir, "config.json"), content);

// reloadIntervalMs=0 forces a fresh read per isBlocked call so tests can
// mutate the file without waiting out the production 60s TTL.
const makeService = (reloadIntervalMs = 0): BlocklistService =>
	new BlocklistService(dir, logger, reloadIntervalMs);

describe("BlocklistService — missing / empty config", () => {
	it("treats a missing config.json as an empty blocklist without erroring", async () => {
		await expect(makeService().isBlocked("example.com")).resolves.toBe(false);
	});

	it("treats a config without blocked_domains as empty", async () => {
		await writeConfig(JSON.stringify({ other_setting: true }));
		await expect(makeService().isBlocked("example.com")).resolves.toBe(false);
	});

	it("treats an empty blocked_domains array as empty", async () => {
		await writeConfig(JSON.stringify({ blocked_domains: [] }));
		await expect(makeService().isBlocked("example.com")).resolves.toBe(false);
	});
});

describe("BlocklistService — matching", () => {
	it("blocks an exactly listed domain", async () => {
		await writeConfig(JSON.stringify({ blocked_domains: ["bad.example.com"] }));
		const svc = makeService();
		await expect(svc.isBlocked("bad.example.com")).resolves.toBe(true);
		await expect(svc.isBlocked("good.example.com")).resolves.toBe(false);
	});

	it("does NOT block subdomains of a bare (non-wildcard) entry", async () => {
		await writeConfig(JSON.stringify({ blocked_domains: ["example.com"] }));
		await expect(makeService().isBlocked("www.example.com")).resolves.toBe(false);
	});

	it("wildcard *.host matches every subdomain plus the apex", async () => {
		await writeConfig(JSON.stringify({ blocked_domains: ["*.ads.example.net"] }));
		const svc = makeService();
		await expect(svc.isBlocked("ads.example.net")).resolves.toBe(true);
		await expect(svc.isBlocked("tracker.ads.example.net")).resolves.toBe(true);
		await expect(svc.isBlocked("a.b.ads.example.net")).resolves.toBe(true);
		await expect(svc.isBlocked("example.net")).resolves.toBe(false);
		// Suffix match must respect the label boundary.
		await expect(svc.isBlocked("badads.example.net")).resolves.toBe(false);
	});

	it("matches case-insensitively and trims whitespace in entries", async () => {
		await writeConfig(JSON.stringify({ blocked_domains: ["  Bad.Example.COM  "] }));
		await expect(makeService().isBlocked("BAD.example.com")).resolves.toBe(true);
	});

	it("ignores non-string and empty entries", async () => {
		await writeConfig(JSON.stringify({ blocked_domains: [42, null, "", "real.example.com"] }));
		const svc = makeService();
		await expect(svc.isBlocked("real.example.com")).resolves.toBe(true);
		await expect(svc.isBlocked("42")).resolves.toBe(false);
	});
});

describe("BlocklistService — malformed config", () => {
	it("treats invalid JSON as empty when nothing was loaded before", async () => {
		await writeConfig("{not json");
		await expect(makeService().isBlocked("example.com")).resolves.toBe(false);
	});

	it("keeps the previously loaded list when the file turns malformed", async () => {
		await writeConfig(JSON.stringify({ blocked_domains: ["bad.example.com"] }));
		const svc = makeService();
		await expect(svc.isBlocked("bad.example.com")).resolves.toBe(true);

		await writeConfig("{not json");
		await expect(svc.isBlocked("bad.example.com")).resolves.toBe(true);
	});

	it("treats a non-array blocked_domains as malformed (keeps previous list)", async () => {
		await writeConfig(JSON.stringify({ blocked_domains: ["bad.example.com"] }));
		const svc = makeService();
		await expect(svc.isBlocked("bad.example.com")).resolves.toBe(true);

		await writeConfig(JSON.stringify({ blocked_domains: "bad.example.com" }));
		await expect(svc.isBlocked("bad.example.com")).resolves.toBe(true);
	});
});

describe("BlocklistService — reload behaviour", () => {
	it("picks up edits after the reload interval (interval=0 → every call)", async () => {
		await writeConfig(JSON.stringify({ blocked_domains: [] }));
		const svc = makeService();
		await expect(svc.isBlocked("late.example.com")).resolves.toBe(false);

		await writeConfig(JSON.stringify({ blocked_domains: ["late.example.com"] }));
		await expect(svc.isBlocked("late.example.com")).resolves.toBe(true);
	});

	it("unblocks everything when the file is deleted", async () => {
		await writeConfig(JSON.stringify({ blocked_domains: ["bad.example.com"] }));
		const svc = makeService();
		await expect(svc.isBlocked("bad.example.com")).resolves.toBe(true);

		await fs.unlink(join(dir, "config.json"));
		await expect(svc.isBlocked("bad.example.com")).resolves.toBe(false);
	});

	it("does not re-read the file inside the reload interval", async () => {
		await writeConfig(JSON.stringify({ blocked_domains: ["bad.example.com"] }));
		const svc = makeService(60_000);
		await expect(svc.isBlocked("bad.example.com")).resolves.toBe(true);

		// Edit is invisible until the interval elapses.
		await writeConfig(JSON.stringify({ blocked_domains: [] }));
		await expect(svc.isBlocked("bad.example.com")).resolves.toBe(true);
	});
});
