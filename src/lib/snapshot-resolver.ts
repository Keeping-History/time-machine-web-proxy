import type pino from "pino";

const CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";
export const MIN_TIMESTAMP = "19960101000000";
export const MAX_TIMESTAMP = "29991231235959";
const MS_PER_DAY = 86_400_000;
const TIMESTAMP_RE = /^\d{14}$/;
// 30s rather than the undici default (~10s): production logs on main showed
// sporadic connect timeouts to web.archive.org under that ceiling, surfacing
// to the user as a 500 even though the downloader could likely have succeeded.
const CDX_TIMEOUT_MS = 30_000;

export interface ResolveOpts {
	variants: string[];
	requestedTime: string;
	windowsDays: number[];
	allowLaterFallback: boolean;
	fetchImpl?: typeof fetch;
	logger: pino.Logger;
}

export async function resolveSnapshotTimestamp(o: ResolveOpts): Promise<string | null> {
	if (!TIMESTAMP_RE.test(o.requestedTime)) {
		throw new Error(`Invalid 14-digit timestamp: ${o.requestedTime}`);
	}
	const f = o.fetchImpl ?? fetch;

	for (const days of o.windowsDays) {
		const from = days === 0 ? null : shiftTimestamp(o.requestedTime, -days);
		const ts = await pickInWindow(o.variants, from, o.requestedTime, "latest", f, o.logger);
		if (ts !== null) {
			o.logger.debug(
				{ from, to: o.requestedTime, resolved: ts },
				"[snapshot-resolver] backward hit",
			);
			return ts;
		}
	}

	if (!o.allowLaterFallback) return null;

	for (const days of o.windowsDays) {
		const to = days === 0 ? MAX_TIMESTAMP : shiftTimestamp(o.requestedTime, days);
		const ts = await pickInWindow(o.variants, o.requestedTime, to, "earliest", f, o.logger);
		if (ts !== null) {
			o.logger.debug(
				{ from: o.requestedTime, to, resolved: ts },
				"[snapshot-resolver] forward hit",
			);
			return ts;
		}
	}

	return null;
}

async function pickInWindow(
	variants: string[],
	from: string | null,
	to: string,
	pick: "latest" | "earliest",
	fetchImpl: typeof fetch,
	logger: pino.Logger,
): Promise<string | null> {
	const results = await Promise.all(variants.map((v) => cdxQuery(v, from, to, fetchImpl, logger)));
	const all = results.flat();
	if (all.length === 0) return null;
	if (pick === "latest") return all.reduce((a, b) => (a > b ? a : b));
	return all.reduce((a, b) => (a < b ? a : b));
}

async function cdxQuery(
	url: string,
	from: string | null,
	to: string,
	fetchImpl: typeof fetch,
	logger: pino.Logger,
): Promise<string[]> {
	const params = new URLSearchParams();
	params.set("url", url);
	params.set("output", "json");
	params.set("fl", "timestamp");
	params.set("filter", "statuscode:200");
	params.set("collapse", "digest");
	if (from !== null) params.set("from", from);
	params.set("to", to);
	const requestUrl = `${CDX_ENDPOINT}?${params.toString()}`;

	let res: Response;
	try {
		res = await fetchImpl(requestUrl, { signal: AbortSignal.timeout(CDX_TIMEOUT_MS) });
	} catch (e) {
		logger.debug(
			{ url, error: e instanceof Error ? e.message : String(e) },
			"[snapshot-resolver] CDX fetch failed",
		);
		return [];
	}
	if (!res.ok) {
		logger.debug({ url, status: res.status }, "[snapshot-resolver] CDX non-OK");
		return [];
	}
	const text = await res.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		logger.debug({ url }, "[snapshot-resolver] CDX malformed JSON");
		return [];
	}
	if (!Array.isArray(json) || json.length === 0) return [];
	const rows =
		Array.isArray(json[0]) && (json[0] as unknown[])[0] === "timestamp" ? json.slice(1) : json;
	const timestamps: string[] = [];
	for (const row of rows) {
		const ts = Array.isArray(row) ? row[0] : null;
		if (typeof ts === "string" && TIMESTAMP_RE.test(ts)) timestamps.push(ts);
	}
	return timestamps;
}

function shiftTimestamp(ts: string, deltaDays: number): string {
	const year = Number.parseInt(ts.slice(0, 4), 10);
	const month = Number.parseInt(ts.slice(4, 6), 10);
	const day = Number.parseInt(ts.slice(6, 8), 10);
	const hour = Number.parseInt(ts.slice(8, 10), 10);
	const minute = Number.parseInt(ts.slice(10, 12), 10);
	const second = Number.parseInt(ts.slice(12, 14), 10);
	const epoch = Date.UTC(year, month - 1, day, hour, minute, second) + deltaDays * MS_PER_DAY;
	const shifted = formatTimestamp(new Date(epoch));
	if (shifted < MIN_TIMESTAMP) return MIN_TIMESTAMP;
	if (shifted > MAX_TIMESTAMP) return MAX_TIMESTAMP;
	return shifted;
}

function formatTimestamp(d: Date): string {
	const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	const hh = String(d.getUTCHours()).padStart(2, "0");
	const mi = String(d.getUTCMinutes()).padStart(2, "0");
	const ss = String(d.getUTCSeconds()).padStart(2, "0");
	return `${yyyy}${mm}${dd}${hh}${mi}${ss}`;
}
