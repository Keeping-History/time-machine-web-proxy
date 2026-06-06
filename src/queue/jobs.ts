// BullMQ rejects queue names containing ":" at construction time
// (see node_modules/bullmq/dist/cjs/classes/queue-base.js:34) — the colon
// is reserved for Redis key separators. Use "-" instead. Resulting Redis
// keys look like `tm:archive-exact:wait`, still namespaced by `tm:`.
export const QUEUE_EXACT = "archive-exact";
export const QUEUE_CRAWL = "archive-crawl";
export const QUEUE_CRAWL_CHUNK = "archive-crawl-chunk";

export interface ExactUrlJob {
	url: string;
	time: string;
}

export interface DomainCrawlJob {
	host: string;
	time: string;
}

const TIME_RE = /^\d{14}$/;
const URL_RE = /^https?:\/\//;

export function assertExactUrlJob(v: unknown): asserts v is ExactUrlJob {
	if (!v || typeof v !== "object" || Array.isArray(v)) {
		throw new Error("Invalid job: not object");
	}
	const o = v as Record<string, unknown>;
	if (typeof o.url !== "string" || !URL_RE.test(o.url)) {
		throw new Error("Invalid job.url");
	}
	if (typeof o.time !== "string" || !TIME_RE.test(o.time)) {
		throw new Error("Invalid job.time");
	}
}

export function assertDomainCrawlJob(v: unknown): asserts v is DomainCrawlJob {
	if (!v || typeof v !== "object" || Array.isArray(v)) {
		throw new Error("Invalid job: not object");
	}
	const o = v as Record<string, unknown>;
	if (typeof o.host !== "string" || o.host.length === 0) {
		throw new Error("Invalid job.host");
	}
	if (typeof o.time !== "string" || !TIME_RE.test(o.time)) {
		throw new Error("Invalid job.time");
	}
}

export interface DomainCrawlChunkJob {
	host: string;
	time: string;
	page: number;
}

export function assertDomainCrawlChunkJob(v: unknown): asserts v is DomainCrawlChunkJob {
	if (!v || typeof v !== "object" || Array.isArray(v)) {
		throw new Error("Invalid job: not object");
	}
	const o = v as Record<string, unknown>;
	if (typeof o.host !== "string" || o.host.length === 0) {
		throw new Error("Invalid job.host");
	}
	if (typeof o.time !== "string" || !TIME_RE.test(o.time)) {
		throw new Error("Invalid job.time");
	}
	if (typeof o.page !== "number" || !Number.isInteger(o.page) || o.page < 0) {
		throw new Error("Invalid job.page");
	}
}
