import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { lookup as mimeLookup } from "mime-types";
import type pino from "pino";
import type { Config } from "../models/config";

const ROOT_VERSION = "v2";
// Suffix appended to the final path to produce the tmp write target. Kept in
// the same directory as the destination so the rename is atomic on POSIX
// (same filesystem, same mount point).
const TMP_SUFFIX = ".tmp";

export interface CacheHit {
	absPath: string;
	contentType: string;
	// Resolved snapshot timestamp from the worker's CDX search, if a sidecar
	// was written. Falls back to undefined for legacy cache files (pre-sidecar).
	archiveTime?: string;
}

export class CacheService {
	constructor(
		private readonly config: Pick<Config, "cacheDir" | "cacheEnabled" | "notFoundTtlDays">,
		private readonly logger: pino.Logger,
	) {}

	cacheDirForJob(time: string, host: string): string {
		return join(this.config.cacheDir, ROOT_VERSION, time, host);
	}

	/**
	 * Computes the absolute cache path for a given URL and timestamp.
	 *
	 * This is the single source of truth for cache path resolution — both the
	 * read path (lookup) and the write path (writeFile) call this so they can
	 * never diverge. Percent-encoded traversal sequences (e.g. %2e%2e%2f) are
	 * decoded before path.resolve so the startsWith guard catches them.
	 *
	 * Directory-style URLs (/ or trailing /) resolve to `<dir>/index.html`.
	 * Throws HTTP 400 if the resolved path escapes the cache root.
	 */
	computeAbsPath(url: string, time: string): string {
		const u = new URL(url);
		const root = this.cacheDirForJob(time, u.hostname);
		let decoded: string;
		try {
			decoded = decodeURIComponent(u.pathname);
		} catch {
			throw Object.assign(new Error("Malformed URL pathname"), { status: 400 });
		}
		const isDirStyle = decoded === "/" || decoded.endsWith("/");
		const rel = isDirStyle ? `${decoded}index.html` : decoded;
		const abs = resolve(root, `.${rel}`);
		if (abs !== root && !abs.startsWith(root + sep)) {
			throw Object.assign(new Error("Path traversal rejected"), { status: 400 });
		}
		return abs;
	}

	async lookup(url: string, time: string): Promise<CacheHit | null> {
		if (!this.config.cacheEnabled) return null;
		const u = new URL(url);
		// Cache key uses the hostname verbatim. www.example.com and example.com
		// are deliberately stored as separate entries because they may serve
		// different content; collapsing them would poison the cache.
		const primaryAbs = this.computeAbsPath(url, time);
		const root = this.cacheDirForJob(time, u.hostname);
		// Decode pathname for the directory-index fallback probe. computeAbsPath
		// already validated against traversal; we only need the decoded form here.
		let decoded: string;
		try {
			decoded = decodeURIComponent(u.pathname);
		} catch {
			throw Object.assign(new Error("Malformed URL pathname"), { status: 400 });
		}
		const isDirStyle = decoded === "/" || decoded.endsWith("/");
		try {
			await fs.access(primaryAbs);
			const contentType = mimeLookup(extname(primaryAbs)) || "application/octet-stream";
			const archiveTime = await this.readResolvedTime(time, u.hostname);
			return { absPath: primaryAbs, contentType, archiveTime };
		} catch {
			/* fall through to directory-index fallback */
		}
		// Directory-index fallback: the Wayback downloader saves `http://host/mac`
		// as `<root>/mac/index.html`. Without this probe, a request for `/mac`
		// (no trailing slash) would miss even when the page is cached.
		if (!isDirStyle) {
			const fallbackAbs = resolve(root, `.${decoded}/index.html`);
			if (fallbackAbs !== root && !fallbackAbs.startsWith(root + sep)) {
				throw Object.assign(new Error("Path traversal rejected"), { status: 400 });
			}
			try {
				await fs.access(fallbackAbs);
				const archiveTime = await this.readResolvedTime(time, u.hostname);
				return { absPath: fallbackAbs, contentType: "text/html", archiveTime };
			} catch {
				/* fall through to sentinel check */
			}
		}
		// Negative-cache sentinel: worker writes one when CDX confirms 404.
		// Lookup throws 404 instead of returning null so the proxy stops re-queuing.
		// Sentinels older than notFoundTtlDays are deleted so Wayback backfills
		// become visible on the next request.
		const sentinel = this.sentinelPath(time, url);
		try {
			const stat = await fs.stat(sentinel);
			const ageMs = Date.now() - stat.mtimeMs;
			const ttlMs = this.config.notFoundTtlDays * 24 * 60 * 60 * 1000;
			if (ageMs > ttlMs) {
				await fs.unlink(sentinel);
				this.logger.info({ sentinel, ageMs, ttlMs }, "[cache] sentinel-expired");
				return null;
			}
		} catch {
			return null;
		}
		throw Object.assign(new Error("Not in archive"), { status: 404 });
	}

	/**
	 * Atomically writes `data` into the cache for the given URL + timestamp.
	 *
	 * The write goes to a sibling `.tmp` file first; a rename makes it visible
	 * as an atomic unit. A partial write (crash / concurrent write) therefore
	 * never satisfies a subsequent lookup — only the rename crosses the
	 * visibility boundary.
	 *
	 * Uses the same computeAbsPath as lookup so read-path and write-path are
	 * always in sync.
	 */
	async writeFile(url: string, time: string, data: Buffer): Promise<void> {
		const dest = this.computeAbsPath(url, time);
		await fs.mkdir(dirname(dest), { recursive: true });
		const tmp = `${dest}${TMP_SUFFIX}`;
		await fs.writeFile(tmp, data);
		await fs.rename(tmp, dest);
	}

	async writeResolvedTimeSidecar(time: string, url: string, resolvedTime: string): Promise<void> {
		const u = new URL(url);
		const root = this.cacheDirForJob(time, u.hostname);
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(join(root, ".resolved-time"), resolvedTime);
	}

	private async readResolvedTime(time: string, hostname: string): Promise<string | undefined> {
		const root = this.cacheDirForJob(time, hostname);
		try {
			const raw = await fs.readFile(join(root, ".resolved-time"), "utf-8");
			const trimmed = raw.trim();
			return /^\d{14}$/.test(trimmed) ? trimmed : undefined;
		} catch {
			return undefined;
		}
	}

	async writeNotFoundSentinel(time: string, url: string): Promise<void> {
		const abs = this.sentinelPath(time, url);
		await fs.mkdir(dirname(abs), { recursive: true });
		await fs.writeFile(abs, "");
	}

	private sentinelPath(time: string, url: string): string {
		const u = new URL(url);
		const root = this.cacheDirForJob(time, u.hostname);
		const key = createHash("sha256")
			.update(`${u.protocol}//${u.host}${u.pathname}${u.search}`)
			.digest("hex")
			.slice(0, 16);
		const abs = resolve(root, ".notfound", key);
		if (!abs.startsWith(root + sep)) {
			throw Object.assign(new Error("Sentinel path traversal rejected"), { status: 400 });
		}
		return abs;
	}

	/**
	 * v2-only cache clear: operates on `<cacheDir>/v2/<time>/<host>/` directories.
	 *
	 * - `?domain=<host>` filters by the <host> directory level. `*.example.com`
	 *   matches any subdomain plus the apex `example.com`.
	 * - No filter parameters: recursively clears the entire `<cacheDir>/v2/` root.
	 * - `?type=` is rejected with 410 Gone — v2 entries have no per-entry
	 *   metadata to filter content type on (no JSON sidecar).
	 *
	 * Response shape: `{ deleted, total }` (no `errors` counter — directory
	 * removes either succeed or surface their error as a 500).
	 */
	async handleCacheClear(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const u = new URL(req.url ?? "/", "http://localhost");
			if (u.searchParams.has("type")) {
				res.setHeader("Content-Type", "application/json");
				res.writeHead(410).end(
					JSON.stringify({
						error: "type filter not supported in v2 layout; use domain filter",
					}),
				);
				return;
			}

			const v2Root = join(this.config.cacheDir, ROOT_VERSION);
			const domainFilter = u.searchParams.get("domain");

			// No filter: nuke the entire v2 root.
			if (!domainFilter) {
				let total = 0;
				let deleted = 0;
				try {
					const times = await fs.readdir(v2Root).catch(() => [] as string[]);
					for (const t of times) {
						const hosts = await fs.readdir(join(v2Root, t)).catch(() => [] as string[]);
						total += hosts.length;
					}
					await fs.rm(v2Root, { recursive: true, force: true });
					deleted = total;
				} catch (e) {
					this.logger.error({ error: e }, "[cache:clear] full clear failed");
					res.setHeader("Content-Type", "application/json");
					res.writeHead(500).end(JSON.stringify({ error: "cache clear failed" }));
					return;
				}
				res.setHeader("Content-Type", "application/json");
				res.writeHead(200).end(JSON.stringify({ deleted, total }));
				return;
			}

			// Domain filter: walk <v2Root>/<time>/<host> and rm matching hosts.
			let deleted = 0;
			let total = 0;
			try {
				const times = await fs.readdir(v2Root).catch(() => [] as string[]);
				for (const t of times) {
					const timeDir = join(v2Root, t);
					const hosts = await fs.readdir(timeDir).catch(() => [] as string[]);
					for (const host of hosts) {
						total += 1;
						if (!this.matchesDomain(host, domainFilter)) continue;
						await fs.rm(join(timeDir, host), { recursive: true, force: true });
						deleted += 1;
					}
				}
			} catch (e) {
				this.logger.error({ error: e }, "[cache:clear] walk failed");
				res.setHeader("Content-Type", "application/json");
				res.writeHead(500).end(JSON.stringify({ error: "cache clear failed" }));
				return;
			}

			res.setHeader("Content-Type", "application/json");
			res.writeHead(200).end(JSON.stringify({ deleted, total }));
		} catch (e) {
			this.logger.error({ error: e }, "[cache:clear] failed");
			res.writeHead(500).end("Internal error");
		}
	}

	private matchesDomain(host: string, filter: string): boolean {
		if (filter.startsWith("*.")) {
			const suffix = filter.slice(1); // ".example.com"
			const apex = filter.slice(2); // "example.com"
			return host === apex || host.endsWith(suffix);
		}
		return host === filter;
	}
}
