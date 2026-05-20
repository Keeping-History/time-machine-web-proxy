import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { lookup as mimeLookup } from "mime-types";
import type pino from "pino";
import type { Config } from "../models/config";

const ROOT_VERSION = "v2";

export interface CacheHit {
	absPath: string;
	contentType: string;
}

export class CacheService {
	constructor(
		private readonly config: Pick<Config, "cacheDir" | "cacheEnabled">,
		private readonly logger: pino.Logger,
	) {}

	cacheDirForJob(time: string, host: string): string {
		return join(this.config.cacheDir, ROOT_VERSION, time, host);
	}

	async lookup(url: string, time: string): Promise<CacheHit | null> {
		if (!this.config.cacheEnabled) return null;
		const u = new URL(url);
		// Cache key uses the hostname verbatim. www.example.com and example.com
		// are deliberately stored as separate entries because they may serve
		// different content; collapsing them would poison the cache.
		const root = this.cacheDirForJob(time, u.hostname);
		// Decode the pathname so percent-encoded traversal sequences (e.g. %2e%2e%2f)
		// are normalized before path.resolve, allowing the startsWith guard below
		// to catch them. URL's own pathname normalization only handles literal "..".
		let decoded: string;
		try {
			decoded = decodeURIComponent(u.pathname);
		} catch {
			throw Object.assign(new Error("Malformed URL pathname"), { status: 400 });
		}
		const isDirStyle = decoded === "/" || decoded.endsWith("/");
		const primaryRel = isDirStyle ? `${decoded}index.html` : decoded;
		const primaryAbs = resolve(root, `.${primaryRel}`);
		if (primaryAbs !== root && !primaryAbs.startsWith(root + sep)) {
			throw Object.assign(new Error("Path traversal rejected"), { status: 400 });
		}
		try {
			await fs.access(primaryAbs);
			const contentType = mimeLookup(extname(primaryAbs)) || "application/octet-stream";
			return { absPath: primaryAbs, contentType };
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
				return { absPath: fallbackAbs, contentType: "text/html" };
			} catch {
				return null;
			}
		}
		return null;
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
