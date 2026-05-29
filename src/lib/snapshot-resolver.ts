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
// Per-cdxQuery retry budget. Transient transport failures, 429, 5xx, and
// malformed JSON (Wayback's load-balancer occasionally returns an HTML error
// page mid-incident) are retried with exponential backoff before the call
// gives up and returns []. With 1 initial + 2 retries and a 500ms base, the
// added wall-clock per failing call is at most 500 + 1000 = 1500ms — small
// enough to fit comfortably under BullMQ's per-attempt budget.
const CDX_RETRY_MAX_ATTEMPTS = 3;
const CDX_RETRY_BASE_DELAY_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

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
	// Tracks whether ANY CDX call returned a parseable response. A null result
	// is only authoritative ("no snapshot exists") when we got at least one
	// real answer. If every CDX call failed at the transport / non-OK / parse
	// layer, we throw instead of returning null — otherwise the worker would
	// write a sticky 404 sentinel for what was actually a transient outage.
	const tracker: CdxTracker = { anyOk: false };

	if (o.allowLaterFallback) {
		// Bidirectional closest: each window straddles requestedTime, and the
		// closest snapshot (by absolute distance) wins. Matches web.archive.org's
		// /web/<ts>/<url> behavior, which redirects to the nearest capture in
		// either direction.
		for (const days of o.windowsDays) {
			const from = days === 0 ? null : shiftTimestamp(o.requestedTime, -days);
			const to = days === 0 ? MAX_TIMESTAMP : shiftTimestamp(o.requestedTime, days);
			const ts = await pickClosest(o.variants, from, to, o.requestedTime, f, o.logger, tracker);
			if (ts !== null) {
				o.logger.debug({ from, to, resolved: ts }, "[snapshot-resolver] bidirectional hit");
				return ts;
			}
			// If a full window completed without a single parseable CDX response,
			// CDX is unhealthy (timeouts, 5xx storm, HTML error pages). Subsequent
			// windows hit the same endpoint and will fail the same way — bail out
			// rather than burning another ~90s per window before the throw fires.
			if (!tracker.anyOk) break;
		}
	} else {
		// Strict at-or-before: only consider snapshots ≤ requestedTime. Opt-in
		// via ALLOW_LATER_FALLBACK=false for callers that need to avoid
		// "snapshot from the future" semantics.
		for (const days of o.windowsDays) {
			const from = days === 0 ? null : shiftTimestamp(o.requestedTime, -days);
			const ts = await pickInWindow(
				o.variants,
				from,
				o.requestedTime,
				"latest",
				f,
				o.logger,
				tracker,
			);
			if (ts !== null) {
				o.logger.debug(
					{ from, to: o.requestedTime, resolved: ts },
					"[snapshot-resolver] backward hit",
				);
				return ts;
			}
			if (!tracker.anyOk) break;
		}
	}

	if (!tracker.anyOk) {
		throw new Error(
			"[snapshot-resolver] all CDX queries failed (transport/non-OK/parse) — refusing to claim 'no snapshot' on indeterminate state",
		);
	}
	return null;
}

interface CdxTracker {
	anyOk: boolean;
}

async function pickInWindow(
	variants: string[],
	from: string | null,
	to: string,
	pick: "latest" | "earliest",
	fetchImpl: typeof fetch,
	logger: pino.Logger,
	tracker: CdxTracker,
): Promise<string | null> {
	const results = await Promise.all(
		variants.map((v) => cdxQuery(v, from, to, fetchImpl, logger, tracker)),
	);
	const all = results.flat();
	if (all.length === 0) return null;
	if (pick === "latest") return all.reduce((a, b) => (a > b ? a : b));
	return all.reduce((a, b) => (a < b ? a : b));
}

async function pickClosest(
	variants: string[],
	from: string | null,
	to: string,
	requestedTime: string,
	fetchImpl: typeof fetch,
	logger: pino.Logger,
	tracker: CdxTracker,
): Promise<string | null> {
	const results = await Promise.all(
		variants.map((v) => cdxQuery(v, from, to, fetchImpl, logger, tracker)),
	);
	const all = results.flat();
	if (all.length === 0) return null;
	// 14-digit timestamps fit comfortably in JS Number (max ~3e13 << 2^53),
	// so plain subtraction is exact.
	const req = Number(requestedTime);
	return all.reduce((best, ts) =>
		Math.abs(Number(ts) - req) < Math.abs(Number(best) - req) ? ts : best,
	);
}

async function cdxQuery(
	url: string,
	from: string | null,
	to: string,
	fetchImpl: typeof fetch,
	logger: pino.Logger,
	tracker: CdxTracker,
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

	const startedAt = Date.now();
	let lastReason: { kind: "transport" | "non-ok" | "parse"; detail: string } | null = null;

	for (let attempt = 1; attempt <= CDX_RETRY_MAX_ATTEMPTS; attempt += 1) {
		const isLastAttempt = attempt === CDX_RETRY_MAX_ATTEMPTS;

		let res: Response;
		try {
			res = await fetchImpl(requestUrl, { signal: AbortSignal.timeout(CDX_TIMEOUT_MS) });
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			lastReason = { kind: "transport", detail };
			logger.debug({ url, attempt, error: detail }, "[snapshot-resolver] CDX fetch failed");
			if (isLastAttempt) return giveUp(logger, url, lastReason, startedAt, attempt);
			await sleep(CDX_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
			continue;
		}
		if (!res.ok) {
			lastReason = { kind: "non-ok", detail: `HTTP ${res.status}` };
			logger.debug({ url, attempt, status: res.status }, "[snapshot-resolver] CDX non-OK");
			// 4xx (except 429) are not transient — no amount of retry will fix
			// a malformed query. Give up immediately so we don't waste budget.
			if (!isRetryableStatus(res.status) || isLastAttempt) {
				return giveUp(logger, url, lastReason, startedAt, attempt);
			}
			await sleep(CDX_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
			continue;
		}
		const text = await res.text();
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			lastReason = { kind: "parse", detail: `${text.slice(0, 80)}…` };
			logger.debug({ url, attempt }, "[snapshot-resolver] CDX malformed JSON");
			if (isLastAttempt) return giveUp(logger, url, lastReason, startedAt, attempt);
			await sleep(CDX_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
			continue;
		}
		// Successful, parseable response — this CDX endpoint is healthy, so the
		// absence of results is authoritative even if other queries fail.
		tracker.anyOk = true;
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
	// Unreachable: the loop body either returns or continues; the final
	// iteration's `isLastAttempt` branches return [].
	return [];
}

function giveUp(
	logger: pino.Logger,
	url: string,
	reason: { kind: "transport" | "non-ok" | "parse"; detail: string },
	startedAt: number,
	attempts: number,
): string[] {
	logger.warn(
		{ url, kind: reason.kind, detail: reason.detail, attempts, elapsedMs: Date.now() - startedAt },
		"[snapshot-resolver] CDX gave up after exhausting retries",
	);
	return [];
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
