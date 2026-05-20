import type pino from "pino";
import type { Config } from "../models/config";
import { ArchiveRequestQueue } from "../lib/queue";
import { ShutdownController, abortableSleep } from "../lib/shutdown";

export type ResourceType = "document" | "image" | "style";

const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BROWSER_HEADERS: Record<ResourceType, Record<string, string>> = {
	document: {
		"User-Agent": BROWSER_UA,
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
		"Accept-Encoding": "gzip, deflate, br",
		"Upgrade-Insecure-Requests": "1",
		"Sec-Fetch-Dest": "document",
		"Sec-Fetch-Mode": "navigate",
		"Sec-Fetch-Site": "none",
		"Sec-Fetch-User": "?1",
	},
	image: {
		"User-Agent": BROWSER_UA,
		Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
		"Accept-Encoding": "gzip, deflate, br",
		"Sec-Fetch-Dest": "image",
		"Sec-Fetch-Mode": "no-cors",
		"Sec-Fetch-Site": "cross-site",
	},
	style: {
		"User-Agent": BROWSER_UA,
		Accept: "text/css,*/*;q=0.1",
		"Accept-Language": "en-US,en;q=0.9",
		"Accept-Encoding": "gzip, deflate, br",
		"Sec-Fetch-Dest": "style",
		"Sec-Fetch-Mode": "no-cors",
		"Sec-Fetch-Site": "cross-site",
	},
};

const RETRYABLE_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]);

const isRetryable = (err: unknown): boolean => {
	if (!(err instanceof Error)) return false;
	const cause = (err as { cause?: unknown }).cause;
	const code = (cause as NodeJS.ErrnoException | undefined)?.code;
	return code !== undefined && RETRYABLE_ERROR_CODES.has(code);
};

export class WaybackClient {
	private static readonly BACKOFF_STEPS_MS = [1_000, 10_000, 30_000, 60_000, 300_000];
	private readonly archiveUrlPrefix: string;

	constructor(
		private readonly queue: ArchiveRequestQueue,
		private readonly shutdown: ShutdownController,
		private readonly logger: pino.Logger,
		private readonly config: Pick<Config, "archivePrefix" | "archiveMaxRetries">,
	) {
		this.archiveUrlPrefix = `${config.archivePrefix}/`;
	}

	async fetch(
		url: string,
		resourceType: ResourceType = "document",
		retriesLeft = this.config.archiveMaxRetries,
	): Promise<Response> {
		if (!url.startsWith(this.archiveUrlPrefix)) {
			throw new Error(`Refusing to fetch non-archive URL: ${url}`);
		}
		try {
			return await this.queue.enqueue(() =>
				fetch(url, {
					headers: BROWSER_HEADERS[resourceType],
					signal: AbortSignal.timeout(300000),
				}),
			);
		} catch (err) {
			if (isRetryable(err) && retriesLeft > 0) {
				const step = this.config.archiveMaxRetries - retriesLeft;
				const backoffMs =
					WaybackClient.BACKOFF_STEPS_MS[
						Math.min(step, WaybackClient.BACKOFF_STEPS_MS.length - 1)
					];
				this.logger.warn(
					{ url, retriesLeft, backoffMs, error: err instanceof Error ? err.message : String(err) },
					"[TimeMachine] Connection error, retrying after cooloff",
				);
				await abortableSleep(backoffMs, this.shutdown.signal);
				return this.fetch(url, resourceType, retriesLeft - 1);
			}
			throw err;
		}
	}
}
