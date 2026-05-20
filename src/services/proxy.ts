import type pino from "pino";
import type { Config } from "../models/config";
import type { ProxyResult } from "../models/proxy";
import type { CacheService } from "./cache";
import type { WaybackClient } from "../clients/wayback";
import {
	arcUrl,
	collectWaybackResourceUrls,
	rewriteArchiveLinks,
	rewriteCssUrls,
	rewriteCssUrlsFiltered,
	rewriteImageUrlsFiltered,
	stripWaybackToolbar,
} from "../lib/url-rewriter";

const RE_ARCHIVE_TIME = /\/web\/(\d{14})\//;

export class ProxyService {
	constructor(
		private readonly cache: CacheService,
		private readonly wayback: WaybackClient,
		private readonly logger: pino.Logger,
		private readonly config: Pick<Config, "proxyBase" | "archivePrefix" | "proxyPrefix">,
	) {}

	async fetch(targetUrl: string, time: string): Promise<ProxyResult> {
		const cached = await this.cache.get(targetUrl, time);
		if (cached) {
			this.logger.info({ targetUrl }, "[CACHE HIT]");
			let body: string | Buffer;
			if (cached.isHtml) {
				const cachedUrls = await this.getCachedResourceUrls(cached.body, time);
				this.prefetchResources(cached.body, time, cachedUrls);
				body = rewriteArchiveLinks(
					rewriteImageUrlsFiltered(
						rewriteCssUrlsFiltered(cached.body, this.config.proxyBase, time, cachedUrls),
						this.config.proxyBase,
						time,
						cachedUrls,
					),
					this.config.proxyBase,
				);
			} else if (cached.isCss) {
				body = rewriteCssUrls(cached.body, this.config.proxyBase, time);
			} else {
				body = Buffer.from(cached.body, "base64");
			}
			return {
				contentType: cached.contentType,
				archiveUrl: cached.archiveUrl,
				originalUrl: targetUrl,
				archiveTime: cached.archiveTime,
				body,
				cache: "HIT",
			};
		}

		const archiveUrl = arcUrl(targetUrl, time, this.config.archivePrefix, this.config.proxyPrefix);
		this.logger.info({ targetUrl, archiveUrl });
		const fetchRes = await this.wayback.fetch(archiveUrl);

		if (fetchRes.headers.get("x-ts") === "404") {
			throw Object.assign(new Error("Not found in archive"), { status: 404 });
		}
		if (!fetchRes.ok) {
			throw Object.assign(new Error(`Archive returned ${fetchRes.status}`), { status: fetchRes.status });
		}

		const contentType = fetchRes.headers.get("content-type") || "";
		const archiveTimeMatch = fetchRes.url.match(RE_ARCHIVE_TIME);
		const archiveTime = archiveTimeMatch ? archiveTimeMatch[1] : "";
		const isHtml = contentType.startsWith("text/html");
		const isCss = contentType.startsWith("text/css");

		let body: string | Buffer;
		if (isHtml) {
			const html = await fetchRes.text();
			const filtered = stripWaybackToolbar(html, fetchRes.url);
			await this.cache.put(targetUrl, time, { contentType, archiveUrl: fetchRes.url, archiveTime, body: filtered, isHtml: true, isCss: false });
			const uncachedUrls = collectWaybackResourceUrls(filtered);
			this.prefetchResourceUrls(uncachedUrls, time);
			const empty = new Set<string>();
			body = rewriteArchiveLinks(
				rewriteImageUrlsFiltered(
					rewriteCssUrlsFiltered(filtered, this.config.proxyBase, time, empty),
					this.config.proxyBase,
					time,
					empty,
				),
				this.config.proxyBase,
			);
		} else if (isCss) {
			const css = await fetchRes.text();
			await this.cache.put(targetUrl, time, { contentType, archiveUrl: fetchRes.url, archiveTime, body: css, isHtml: false, isCss: true });
			body = rewriteCssUrls(css, this.config.proxyBase, time);
		} else {
			const buffer = Buffer.from(await fetchRes.arrayBuffer());
			await this.cache.put(targetUrl, time, { contentType, archiveUrl: fetchRes.url, archiveTime, body: buffer.toString("base64"), isHtml: false, isCss: false });
			body = buffer;
		}

		return { contentType, archiveUrl: fetchRes.url, originalUrl: targetUrl, archiveTime, body, cache: "MISS" };
	}

	async fetchAndCacheImage(url: string, time: string): Promise<boolean> {
		if (await this.cache.get(url, time)) return true;
		try {
			const archiveUrl = arcUrl(url, time, this.config.archivePrefix, this.config.proxyPrefix);
			const fetchRes = await this.wayback.fetch(archiveUrl, "image");
			if (!fetchRes.ok) return false;
			const contentType = fetchRes.headers.get("content-type") || "";
			const archiveTimeMatch = fetchRes.url.match(RE_ARCHIVE_TIME);
			const archiveTime = archiveTimeMatch ? archiveTimeMatch[1] : "";
			await this.cache.put(url, time, {
				contentType,
				archiveUrl: fetchRes.url,
				archiveTime,
				body: Buffer.from(await fetchRes.arrayBuffer()).toString("base64"),
				isHtml: false,
				isCss: false,
			});
			return true;
		} catch (e) {
			this.logger.warn({ url, time, error: e }, "[TimeMachine] Failed to prefetch image");
			return false;
		}
	}

	prefetchResourceUrls(urls: string[], time: string, skip: Set<string> = new Set()): void {
		for (const url of urls) {
			if (skip.has(url)) continue;
			this.fetchAndCacheImage(url, time).catch((e) => {
				this.logger.warn({ url, time, error: e }, "[TimeMachine] Failed to prefetch resource");
			});
		}
	}

	prefetchResources(html: string, time: string, skip: Set<string> = new Set()): void {
		this.prefetchResourceUrls(collectWaybackResourceUrls(html), time, skip);
	}

	async getCachedResourceUrls(html: string, time: string): Promise<Set<string>> {
		const urls = collectWaybackResourceUrls(html);
		const results = await Promise.all(
			urls.map(async (url) => ({ url, cached: !!(await this.cache.get(url, time)) })),
		);
		return new Set(results.filter((r) => r.cached).map((r) => r.url));
	}
}
