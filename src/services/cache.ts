import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lookup as mimeLookup } from "mime-types";
import type pino from "pino";
import { errorHasStatus } from "../lib/errors";
import type { Config } from "../models/config";

const ROOT_VERSION = "v2";
// Suffix appended to the final path to produce the tmp write target. Kept in
// the same directory as the destination so the rename is atomic on POSIX
// (same filesystem, same mount point).
const TMP_SUFFIX = ".tmp";
// Tentative sentinel TTL: when the snapshot-resolver returns an indeterminate
// result (CDX unreachable for every variant), the worker writes a short-lived
// sentinel so the next request fails fast without burning another 47s on
// BullMQ retries. After expiry the URL gets retried in case CDX has recovered.
const TENTATIVE_NOT_FOUND_TTL_MS = 60 * 60 * 1000;
// Per-URL subdir holding upstream Content-Type strings written by the direct
// fetch path. Lives under <root>/.content-types/<sha-16> so a request for a
// URL that happens to look like `/r/ci.tmctype` can't read the metadata.
const CONTENT_TYPE_SUBDIR = ".content-types";
// Bytes inspected by sniffContentType when extension lookup yields nothing.
// Generous enough to cover `<!DOCTYPE html ... >` with leading whitespace.
const SNIFF_BYTES = 1024;

export interface CacheHit {
	absPath: string;
	contentType: string;
	// Resolved snapshot timestamp from the worker's CDX search, if a sidecar
	// was written. Falls back to undefined for legacy cache files (pre-sidecar).
	archiveTime?: string;
}

async function atomicWrite(path: string, data: string): Promise<void> {
	// Unique tmp per call. Concurrent atomicWrite() calls to the SAME dest are
	// common — every asset of a host refreshes the per-host `.resolved-time`
	// sidecar — and a shared tmp path makes them race: the first rename consumes
	// the tmp and the rest fail with ENOENT (observed in prod during cold-cache
	// bursts). A random segment kept in the destination's directory keeps the
	// rename atomic on the same mount while giving each writer its own tmp;
	// rename is last-writer-wins, which is fine for these sidecars.
	const tmp = `${path}.${randomBytes(6).toString("hex")}${TMP_SUFFIX}`;
	await fs.writeFile(tmp, data);
	try {
		await fs.rename(tmp, path);
	} catch (e) {
		await fs.unlink(tmp).catch(() => undefined);
		throw e;
	}
}

export class CacheService {
	// Deduplicates concurrent writes to the same destination. When multiple
	// prewarm tasks race the same (url, ts), only the first write reaches the
	// fs; subsequent callers share the first promise and skip the extra rename.
	private readonly writeInflight = new Map<string, Promise<void>>();

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
			const stat = await fs.stat(primaryAbs);
			// Zero-byte body = poison entry (e.g. a writer that piped an empty or
			// already-consumed stream then atomically renamed it into place). It
			// would otherwise serve as 200 + correct content-type + empty body —
			// a permanently broken asset. Treat it as a miss so the worker
			// re-fetches and overwrites it; the atomic rename is the only safe
			// way to replace it, so we deliberately do NOT unlink here (a stale
			// unlink could race ahead of a concurrent good rewrite and delete it).
			if (stat.isDirectory?.()) {
				// The slot is a directory because a child URL was cached first
				// (e.g. `/a/b` arrived before the `/a` page). The page itself, if
				// cached, lives at `<path>/index.html` — fall through to the
				// directory-index probe below rather than returning a directory as
				// if it were a file body (which would EISDIR on read).
				this.logger.debug({ path: primaryAbs }, "[cache] primary path is a directory — trying index.html");
			} else if (stat.size === 0) {
				this.logger.warn({ path: primaryAbs }, "[cache] zero-byte entry — treating as miss");
			} else {
				const contentType = await this.resolveContentType(primaryAbs, url, time);
				const archiveTime = await this.readResolvedTime(time, u.hostname);
				return { absPath: primaryAbs, contentType, archiveTime };
			}
		} catch (e) {
			// ENOENT = absent; ENOTDIR = a parent path segment is a file (so this
			// path can't be cached here) — both are ordinary misses, not errors.
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				this.logger.warn({ err: e, path: primaryAbs }, "[cache] unexpected stat error");
			}
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
				const stat = await fs.stat(fallbackAbs);
				// Same zero-byte poison guard as the primary path above.
				if (stat.size === 0) {
					this.logger.warn({ path: fallbackAbs }, "[cache] zero-byte entry — treating as miss");
				} else {
					const archiveTime = await this.readResolvedTime(time, u.hostname);
					return { absPath: fallbackAbs, contentType: "text/html", archiveTime };
				}
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") {
					this.logger.warn({ err: e, path: fallbackAbs }, "[cache] unexpected stat error");
				}
				/* fall through to sentinel check */
			}
		}
		// Pre-compute both sentinel paths from a single URL parse + hash so the
		// per-URL subpath is computed once regardless of which branch is taken.
		const { tentativeSentinel, sentinel } = this.buildSentinelPaths(time, url);
		// Tentative sentinel: short-lived (1h) marker written when the worker
		// couldn't get a definitive answer from CDX (transport failures across
		// all variants × retries). Avoids re-grinding the BullMQ retry chain
		// for the same URL within the hour, while still letting the URL retry
		// after expiry in case CDX has recovered.
		try {
			const stat = await fs.stat(tentativeSentinel);
			const ageMs = Date.now() - stat.mtimeMs;
			if (ageMs > TENTATIVE_NOT_FOUND_TTL_MS) {
				await fs.unlink(tentativeSentinel);
				this.logger.info(
					{ sentinel: tentativeSentinel, ageMs, ttlMs: TENTATIVE_NOT_FOUND_TTL_MS },
					"[cache] tentative-sentinel-expired",
				);
				// Fall through to permanent sentinel check.
			} else {
				throw Object.assign(new Error("Not in archive (tentative)"), { status: 404 });
			}
		} catch (e) {
			if (errorHasStatus(e) && e.status === 404) throw e;
			/* tentative sentinel absent — fall through to permanent check */
		}
		// Negative-cache sentinel: worker writes one when CDX confirms 404.
		// Lookup throws 404 instead of returning null so the proxy stops re-queuing.
		// Sentinels older than notFoundTtlDays are deleted so Wayback backfills
		// become visible on the next request.
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
		const existing = this.writeInflight.get(dest);
		if (existing) return existing;
		const p = (async () => {
			await fs.mkdir(dirname(dest), { recursive: true });
			const tmp = `${dest}${TMP_SUFFIX}`;
			await fs.writeFile(tmp, data);
			await fs.rename(tmp, dest);
		})();
		this.writeInflight.set(dest, p);
		try {
			return await p;
		} finally {
			this.writeInflight.delete(dest);
		}
	}

	/**
	 * Atomic streaming write. Pipes `readable` into a sibling `.tmp` file
	 * then renames to the final path. Memory footprint is the chunk size
	 * (~64 KB) regardless of payload, so the burst-concurrency × asset-size
	 * heap pressure that buffered writes incur is gone.
	 *
	 * Same atomic-visibility contract as writeFile: partial tmp files are
	 * never visible at the destination because the rename is the only path
	 * exposing the data.
	 *
	 * Same in-flight dedup as writeFile: concurrent calls to the same
	 * destination share a single pipeline+rename so prewarm races don't
	 * double-write.
	 */
	async writeStream(url: string, time: string, readable: Readable): Promise<void> {
		const dest = this.computeAbsPath(url, time);
		const existing = this.writeInflight.get(dest);
		if (existing) {
			readable.resume(); // drain and discard — another write owns the destination
			return existing;
		}
		const p = (async () => {
			await fs.mkdir(dirname(dest), { recursive: true });
			const tmp = `${dest}${TMP_SUFFIX}`;
			await pipeline(readable, createWriteStream(tmp));
			try {
				await fs.rename(tmp, dest);
			} catch (e) {
				// EISDIR: `dest` is already a directory because a child URL was
				// cached first (e.g. `/a/b` before the `/a` page). The filesystem
				// can't hold a file and a directory at the same name, so store the
				// page at `<dest>/index.html` — the directory-index form that
				// lookup() probes (and now prefers when the primary path is a
				// directory). Best-effort: a failure here cleans up the tmp file.
				if ((e as NodeJS.ErrnoException).code === "EISDIR") {
					await fs.rename(tmp, join(dest, "index.html"));
				} else {
					await fs.unlink(tmp).catch(() => undefined);
					throw e;
				}
			}
		})();
		this.writeInflight.set(dest, p);
		try {
			return await p;
		} finally {
			this.writeInflight.delete(dest);
		}
	}

	async writeResolvedTimeSidecar(time: string, url: string, resolvedTime: string): Promise<void> {
		const u = new URL(url);
		const root = this.cacheDirForJob(time, u.hostname);
		await fs.mkdir(root, { recursive: true });
		await atomicWrite(join(root, ".resolved-time"), resolvedTime);
	}

	/**
	 * Persist the upstream Content-Type for a directly-fetched URL. Read back
	 * on lookup so URLs whose path has no useful extension (e.g. /r/ci,
	 * /search) serve with the real type instead of application/octet-stream
	 * (which makes browsers download the file).
	 */
	async writeContentTypeSidecar(url: string, time: string, contentType: string): Promise<void> {
		const abs = this.buildPerUrlSubpath(time, url, CONTENT_TYPE_SUBDIR);
		await fs.mkdir(dirname(abs), { recursive: true });
		await atomicWrite(abs, contentType);
	}

	/**
	 * Resolves the response Content-Type for a cache hit, in priority order:
	 *   1. `.content-types/<key>` sidecar — authoritative; the direct-fetch
	 *      path writes the upstream header here.
	 *   2. `mime-types` lookup against the file extension — covers nearly all
	 *      assets (`.html`, `.css`, `.png`, …) cheaply.
	 *   3. Content sniffing — only invoked when the URL path has no extension
	 *      at all (e.g. `/r/ci`). Such files are overwhelmingly HTML in
	 *      practice; without this they'd serve as octet-stream and download.
	 *   4. `application/octet-stream` fallback.
	 */
	private async resolveContentType(absPath: string, url: string, time: string): Promise<string> {
		const ext = extname(absPath);
		const fromExt = ext ? mimeLookup(ext) : false;

		try {
			const sidecar = this.buildPerUrlSubpath(time, url, CONTENT_TYPE_SUBDIR);
			const raw = await fs.readFile(sidecar, "utf-8");
			const trimmed = raw?.trim();
			if (trimmed) {
				// Old servers (and Wayback error responses) return wrong MIME types
				// for CSS/JS/image URLs (e.g. text/html, text/plain,
				// application/x-pointplus). Browsers in strict mode refuse to apply
				// stylesheets or execute scripts with non-matching types. When the
				// file extension maps to a known MIME type and the sidecar's base
				// type disagrees, the extension wins. When they agree (e.g. sidecar
				// is "text/css; charset=utf-8"), the sidecar is used verbatim to
				// preserve charset and parameter metadata.
				if (fromExt) {
					const sidecarBase = trimmed.split(";")[0].trim().toLowerCase();
					if (sidecarBase !== fromExt) return fromExt;
				}
				return trimmed;
			}
		} catch {
			/* no sidecar — fall through */
		}

		if (fromExt) return fromExt;
		// Only sniff when there's no extension at all. Files with an unknown
		// extension (`.unknownext`) are likely custom binaries; sniffing them
		// would be wasted I/O and risk false-positive HTML detection on
		// pathological inputs.
		if (!ext) {
			const sniffed = await sniffContentType(absPath);
			if (sniffed) return sniffed;
		}
		return "application/octet-stream";
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

	async writeTentativeNotFoundSentinel(time: string, url: string): Promise<void> {
		const abs = this.tentativeSentinelPath(time, url);
		await fs.mkdir(dirname(abs), { recursive: true });
		await fs.writeFile(abs, "");
	}

	private sentinelPath(time: string, url: string): string {
		return this.buildPerUrlSubpath(time, url, ".notfound");
	}

	private tentativeSentinelPath(time: string, url: string): string {
		return this.buildPerUrlSubpath(time, url, ".notfound-tentative");
	}

	/** Computes both sentinel paths in one URL parse + hash. */
	private buildSentinelPaths(time: string, url: string): { sentinel: string; tentativeSentinel: string } {
		const u = new URL(url);
		const root = this.cacheDirForJob(time, u.hostname);
		const key = createHash("sha256")
			.update(`${u.protocol}//${u.host}${u.pathname}${u.search}`)
			.digest("hex")
			.slice(0, 16);
		const make = (subdir: string): string => {
			const abs = resolve(root, subdir, key);
			if (!abs.startsWith(root + sep)) {
				throw Object.assign(new Error("Per-URL subpath traversal rejected"), { status: 400 });
			}
			return abs;
		};
		return { sentinel: make(".notfound"), tentativeSentinel: make(".notfound-tentative") };
	}

	/**
	 * Per-URL path under `<root>/<subdir>/<sha-16>`, keyed by a sha256 prefix
	 * of `protocol+host+path+search`. Shared by sentinels (.notfound,
	 * .notfound-tentative) and the content-type sidecar (.content-types) so
	 * none of them can collide with a user URL even one that ends in a
	 * dot-segment.
	 */
	private buildPerUrlSubpath(time: string, url: string, subdir: string): string {
		const u = new URL(url);
		const root = this.cacheDirForJob(time, u.hostname);
		const key = createHash("sha256")
			.update(`${u.protocol}//${u.host}${u.pathname}${u.search}`)
			.digest("hex")
			.slice(0, 16);
		const abs = resolve(root, subdir, key);
		if (!abs.startsWith(root + sep)) {
			throw Object.assign(new Error("Per-URL subpath traversal rejected"), { status: 400 });
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
			if (domainFilter !== null && !/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(domainFilter)) {
				res.setHeader("Content-Type", "application/json");
				res.writeHead(400).end(JSON.stringify({ error: "invalid domain filter" }));
				return;
			}

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
					this.logger.error({ err: e }, "[cache:clear] full clear failed");
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
				this.logger.error({ err: e }, "[cache:clear] walk failed");
				res.setHeader("Content-Type", "application/json");
				res.writeHead(500).end(JSON.stringify({ error: "cache clear failed" }));
				return;
			}

			res.setHeader("Content-Type", "application/json");
			res.writeHead(200).end(JSON.stringify({ deleted, total }));
		} catch (e) {
			this.logger.error({ err: e }, "[cache:clear] failed");
			if (!res.headersSent) res.writeHead(500).end("Internal error");
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

/**
 * Best-effort Content-Type detection by reading the first SNIFF_BYTES of a
 * file. Returns `null` if no recognised signature is present so the caller
 * falls through to its own default (octet-stream).
 *
 * Intentionally narrow: only matches signatures that the worker path (which
 * persists raw bytes with no upstream header) realistically produces for
 * extensionless URLs — old-web redirect pages and dynamic HTML endpoints.
 * We don't infer application/json from a leading `{` because JS literals
 * embedded in HTML or text files would match.
 */
async function sniffContentType(absPath: string): Promise<string | null> {
	const fh = await fs.open(absPath, "r").catch(() => null);
	if (!fh) return null;
	try {
		const buf = Buffer.alloc(SNIFF_BYTES);
		const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
		if (bytesRead === 0) return null;
		const head = buf.subarray(0, bytesRead).toString("utf-8").trimStart().toLowerCase();
		if (
			head.startsWith("<!doctype") ||
			head.startsWith("<html") ||
			head.startsWith("<head") ||
			head.startsWith("<body") ||
			head.startsWith("<frameset") ||
			head.startsWith("<title") ||
			head.startsWith("<meta")
		) {
			return "text/html; charset=utf-8";
		}
		if (head.startsWith("<?xml")) {
			return "application/xml";
		}
		return null;
	} catch {
		return null;
	} finally {
		await fh.close().catch(() => undefined);
	}
}
