// BullMQ rejects queue names containing ":" at construction time
// (see node_modules/bullmq/dist/cjs/classes/queue-base.js:34) — the colon
// is reserved for Redis key separators. Use "-" instead. Resulting Redis
// keys look like `tm:archive-exact:wait`, still namespaced by `tm:`.
export const QUEUE_EXACT = "archive-exact";
export const QUEUE_CRAWL = "archive-crawl";

/**
 * Crawl provenance carried by exact jobs that are part of a recursive (BFS)
 * domain crawl. Absent on ordinary foreground fetches. `rootHost` + `rootTime`
 * identify the crawl run (used to key the Redis seen-set and page-budget
 * counter); `depth` bounds recursion. Same-host links discovered in a fetched
 * HTML page are re-enqueued at `depth + 1`.
 */
export interface CrawlMeta {
	rootHost: string;
	rootTime: string;
	depth: number;
}

export interface ExactUrlJob {
	url: string;
	time: string;
	crawl?: CrawlMeta;
}

export interface DomainCrawlJob {
	host: string;
	time: string;
}

const TIME_RE = /^\d{14}$/;
const URL_RE = /^https?:\/\//;

function assertCrawlMeta(v: unknown): asserts v is CrawlMeta {
	if (!v || typeof v !== "object" || Array.isArray(v)) {
		throw new Error("Invalid job.crawl");
	}
	const c = v as Record<string, unknown>;
	if (typeof c.rootHost !== "string" || c.rootHost.length === 0) {
		throw new Error("Invalid job.crawl.rootHost");
	}
	if (typeof c.rootTime !== "string" || !TIME_RE.test(c.rootTime)) {
		throw new Error("Invalid job.crawl.rootTime");
	}
	if (typeof c.depth !== "number" || !Number.isInteger(c.depth) || c.depth < 0) {
		throw new Error("Invalid job.crawl.depth");
	}
}

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
	if (o.crawl !== undefined) assertCrawlMeta(o.crawl);
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
