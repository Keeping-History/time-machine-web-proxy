export const QUEUE_EXACT = "archive:exact";
export const QUEUE_CRAWL = "archive:crawl";

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
