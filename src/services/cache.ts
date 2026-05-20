import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pino from "pino";
import type { Config } from "../models/config";
import { type CacheEntry, isCacheEntry } from "../models/cache";

const RE_WAYBACK_EXTRACT_URL = /\/web\/\d{1,14}[^/]*\/(https?:\/\/.+)/;

const cacheKey = (url: string, time: string): string =>
	createHash("sha256").update(`${time}:${url}`).digest("hex");

export class CacheService {
	constructor(
		private readonly config: Pick<Config, "cacheDir" | "cacheEnabled">,
		private readonly logger: pino.Logger,
	) {}

	async get(url: string, time: string): Promise<CacheEntry | null> {
		if (!this.config.cacheEnabled) return null;
		const file = join(this.config.cacheDir, `${cacheKey(url, time)}.json`);
		try {
			const data = await fs.readFile(file, "utf-8");
			const parsed = JSON.parse(data);
			return isCacheEntry(parsed) ? parsed : null;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				this.logger.warn({ file, url, error: e instanceof Error ? e.message : String(e) }, "[TimeMachine] Failed to read cache entry");
			}
			return null;
		}
	}

	async put(url: string, time: string, entry: CacheEntry): Promise<void> {
		if (!this.config.cacheEnabled) return;
		const file = join(this.config.cacheDir, `${cacheKey(url, time)}.json`);
		try {
			await fs.writeFile(file, JSON.stringify(entry));
		} catch (e) {
			this.logger.error({ file, url, error: e instanceof Error ? e.message : String(e) }, "[TimeMachine] Failed to write cache entry");
		}
	}

	async handleCacheClear(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const reqUrl = new URL(req.url ?? "/", "http://localhost");
		const typeParam = reqUrl.searchParams.get("type");
		const domainParam = reqUrl.searchParams.get("domain");
		const matchDomain = this.domainMatcher(domainParam);

		let files: string[];
		try {
			files = await fs.readdir(this.config.cacheDir);
		} catch (e) {
			this.logger.error({ cacheDir: this.config.cacheDir, error: e }, "[TimeMachine] Failed to read cache directory");
			res.setHeader("Content-Type", "application/json");
			res.writeHead(500).end(JSON.stringify({ error: "Failed to read cache directory" }));
			return;
		}

		let deleted = 0;
		let errors = 0;
		const jsonFiles = files.filter((f) => f.endsWith(".json"));
		const BATCH_SIZE = 20;

		for (let i = 0; i < jsonFiles.length; i += BATCH_SIZE) {
			await Promise.all(
				jsonFiles.slice(i, i + BATCH_SIZE).map(async (file) => {
					const filePath = join(this.config.cacheDir, file);
					try {
						const data = await fs.readFile(filePath, "utf-8");
						const entry = JSON.parse(data);
						if (!isCacheEntry(entry)) return;
						if (!this.matchesTypeFilter(entry, typeParam)) return;
						if (domainParam) {
							const urlMatch = entry.archiveUrl.match(RE_WAYBACK_EXTRACT_URL);
							if (!urlMatch) return;
							try {
								const { hostname } = new URL(urlMatch[1]);
								if (!matchDomain(hostname)) return;
							} catch {
								return;
							}
						}
						await fs.unlink(filePath);
						deleted++;
					} catch (e) {
						errors++;
						this.logger.warn({ file, error: e instanceof Error ? e.message : String(e) }, "[TimeMachine] Cache clear error");
					}
				}),
			);
		}

		res.setHeader("Content-Type", "application/json");
		res.writeHead(200).end(JSON.stringify({ deleted, errors }));
	}

	private domainMatcher(pattern: string | null): (hostname: string) => boolean {
		if (!pattern) return () => true;
		const rePattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		const re = new RegExp(`^${rePattern}$`, "i");
		return (h) => re.test(h);
	}

	private matchesTypeFilter(entry: CacheEntry, type: string | null): boolean {
		if (!type) return true;
		if (type === "html") return entry.isHtml;
		if (type === "css") return entry.isCss;
		if (type === "image") return entry.contentType.startsWith("image/");
		return false;
	}
}
