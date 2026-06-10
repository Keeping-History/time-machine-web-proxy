import crypto from "node:crypto";
import { createReadStream, promises as fsPromises } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type pino from "pino";
import { type WebSocket, WebSocketServer } from "ws";
import { errorHasStatus } from "../lib/errors";
import type { ShutdownController } from "../lib/shutdown";
import { normalizeHostname } from "../lib/hostname-normalizer";
import { unwrapRedirectUrl } from "../lib/redirect-unwrapper";
import { parseWaybackPath, sanitizeTimeParam, unwrapNestedProxyUrl } from "../lib/url-rewriter";
import type { Config } from "../models/config";
import type { JobProgress } from "../models/job-progress";
import type { SystemStatus } from "../models/status";
import { isWsRequest, type WsRequest, type WsResponse } from "../models/websocket";
import type { UrlValidatorModule } from "../models/url-validator";
import type { CacheService } from "./cache";
import type { ProxyService } from "./proxy";

export type { UrlValidatorModule };

// Blocks JS-driven top-level navigation (location.href = externalUrl, meta-refresh
// without user action) while keeping the archived page functional. User-initiated
// clicks/submits still navigate because of allow-top-navigation-by-user-activation;
// allow-same-origin preserves cookies/storage; allow-scripts/forms/modals/popups
// cover the APIs archived pages typically rely on. Only applied to text/html
// responses — irrelevant for assets, and unreachable when HTML is delivered via
// SSE/WS to be innerHTML'd into a host page.
const SANDBOX_CSP =
	"sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-top-navigation-by-user-activation";

/**
 * Constant-time Bearer token comparison. Returns false immediately if lengths
 * differ (no timing oracle via early return on length mismatch is acceptable
 * because length is not secret — a wrong-length token is structurally invalid).
 */
function bearerTokenValid(authHeader: string, expected: string): boolean {
	const actual = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
	if (actual.length !== expected.length) return false;
	return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

/** Dependencies required by the standalone HTTP and WS handler functions. */
export interface HandlerDeps {
	readonly config: Config;
	readonly proxy: ProxyService;
	readonly cache: CacheService;
	readonly validator: UrlValidatorModule;
	readonly logger: pino.Logger;
	readonly getStatus?: () => Promise<SystemStatus>;
}

// ---------------------------------------------------------------------------
// Module-level helper functions
// ---------------------------------------------------------------------------

function logRequest(
	deps: HandlerDeps,
	req: IncomingMessage,
	status: number,
	startMs: number,
	extra?: Record<string, unknown>,
): void {
	deps.logger.info({
		method: req.method,
		path: req.url,
		status,
		durationMs: Date.now() - startMs,
		...extra,
	});
}

function setSecurityHeaders(res: ServerResponse): void {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
}

function setCorsHeaders(deps: HandlerDeps, req: IncomingMessage, res: ServerResponse): void {
	const origin = req.headers.origin;
	const allowed = deps.config.allowedOrigins;
	if (origin && (allowed.includes("*") || allowed.includes(origin))) {
		res.setHeader("Access-Control-Allow-Origin", allowed.includes("*") ? "*" : origin);
	}
	res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
	res.setHeader(
		"Access-Control-Expose-Headers",
		"X-Archive-Url, X-Original-Url, X-Archive-Time, X-Cache",
	);
}

function wantsEventStream(req: IncomingMessage): boolean {
	const accept = req.headers.accept;
	if (typeof accept !== "string") return false;
	return accept.split(",").some((part) => part.trim().startsWith("text/event-stream"));
}

async function handleCrawlEnqueue(
	deps: HandlerDeps,
	req: IncomingMessage,
	res: ServerResponse,
	start: number,
): Promise<void> {
	const u = new URL(req.url ?? "/", "http://localhost");
	const host = u.searchParams.get("host");
	let time: string;
	try {
		time = sanitizeTimeParam(u.searchParams.get("time"), deps.config.defaultTime);
	} catch (e) {
		const msg = e instanceof Error ? e.message : "Invalid time parameter";
		res.writeHead(400).end(msg);
		logRequest(deps, req, 400, start);
		return;
	}
	// Hostname charset: letters, digits, dots, hyphens. Reject everything else
	// up-front so we don't smuggle path/query/auth segments into the host slot
	// (which would later land in the cache directory layout and CDX URL).
	if (!host || !/^[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?$/i.test(host)) {
		res.writeHead(400).end("Invalid or missing host");
		logRequest(deps, req, 400, start);
		return;
	}
	// Opt-in: skip the CDX size preflight. Only "true" (case-insensitive)
	// counts as opt-in — typos like "yes"/"1" must NOT silently disable the
	// safety net.
	const skipPreflight = (u.searchParams.get("skip_preflight") ?? "").toLowerCase() === "true";
	try {
		await deps.proxy.triggerDomainCrawl(host, time, { skipPreflight });
		res.setHeader("Content-Type", "application/json");
		res.writeHead(202).end(JSON.stringify({ host, time, preflightSkipped: skipPreflight }));
		logRequest(deps, req, 202, start, { host, time, crawl: true });
	} catch (e) {
		const status = errorHasStatus(e) ? e.status : 500;
		const message = e instanceof Error ? e.message : "crawl enqueue failed";
		if (status >= 500)
			deps.logger.error(
				{ err: e, host, time, path: req.url, method: req.method },
				"[TimeMachine] crawl enqueue failed",
			);
		res.setHeader("Content-Type", "application/json");
		res.writeHead(status).end(JSON.stringify({ error: message }));
		logRequest(deps, req, status, start, { host, time, crawl: true });
	}
}

async function sseHandler(
	deps: HandlerDeps,
	req: IncomingMessage,
	res: ServerResponse,
	targetUrl: string,
	time: string,
	start: number,
): Promise<void> {
	// Headers must flush before any data so EventSource consumers see the
	// stream begin immediately. Once flushed we can't change status, so
	// errors are reported as `event: error` frames rather than HTTP codes.
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
		"Content-Security-Policy": SANDBOX_CSP,
	});

	const writeEvent = (event: string, data: unknown): void => {
		if (res.writableEnded) return;
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	// Forward progress events from the proxy/worker to the client. Body is
	// excluded — final result frame carries the body.
	const onProgress = (p: JobProgress): void => writeEvent("progress", p);

	try {
		const result = await deps.proxy.fetch(targetUrl, time, onProgress);
		const bodyBytes = result.bodyPath
			? await fsPromises.readFile(result.bodyPath)
			: result.body;
		const bodyStr =
			typeof bodyBytes === "string" ? bodyBytes : (bodyBytes ?? Buffer.alloc(0)).toString("base64");
		writeEvent("result", {
			body: bodyStr,
			bodyEncoding: typeof bodyBytes === "string" ? "utf8" : "base64",
			contentType: result.contentType,
			archiveUrl: result.archiveUrl,
			originalUrl: result.originalUrl,
			archiveTime: result.archiveTime,
			cache: result.cache,
		});
		res.end();
		logRequest(deps, req, 200, start, {
			targetUrl,
			time,
			archiveUrl: `https://web.archive.org/web/${time}id_/${targetUrl}`,
			cache: result.cache,
			sse: true,
		});
	} catch (e) {
		const status = errorHasStatus(e) ? e.status : 500;
		const archiveUrl = `https://web.archive.org/web/${time}id_/${targetUrl}`;
		if (status >= 500) {
			deps.logger.error(
				{ err: e, targetUrl, time, archiveUrl, path: req.url, method: req.method },
				"[TimeMachine SSE] Upstream request failed",
			);
		}
		writeEvent("error", {
			status,
			message: e instanceof Error ? e.message : "Upstream request failed",
		});
		res.end();
		logRequest(deps, req, status, start, { targetUrl, time, archiveUrl, sse: true });
	}
}

// ---------------------------------------------------------------------------
// Standalone exported handler functions
// ---------------------------------------------------------------------------

export async function httpHandler(
	req: IncomingMessage,
	res: ServerResponse,
	deps: HandlerDeps,
	start: number,
): Promise<void> {
	setCorsHeaders(deps, req, res);
	setSecurityHeaders(res);

	if (req.method === "OPTIONS") {
		res.writeHead(204).end();
		deps.logger.debug({
			method: "OPTIONS",
			path: req.url,
			status: 204,
			durationMs: Date.now() - start,
		});
		return;
	}

	if (req.method === "GET") {
		const { pathname } = new URL(req.url ?? "/", "http://localhost");
		if (pathname === "/status") {
			if (!deps.getStatus) {
				res.writeHead(404).end("Status endpoint not available");
				logRequest(deps, req, 404, start);
				return;
			}
			try {
				const status = await deps.getStatus();
				res.setHeader("Content-Type", "application/json");
				res.writeHead(200).end(JSON.stringify(status));
				logRequest(deps, req, 200, start);
			} catch (e) {
				deps.logger.error(
					{ err: e, path: req.url, method: req.method },
					"[TimeMachine] status probe failed",
				);
				res.setHeader("Content-Type", "application/json");
				res
					.writeHead(500)
					.end(JSON.stringify({ error: e instanceof Error ? e.message : "status probe failed" }));
				logRequest(deps, req, 500, start);
			}
			return;
		}
		// Other GETs fall through to the existing /web/{ts}/{url} + ?url= flow.
	}

	if (req.method === "DELETE") {
		const { pathname } = new URL(req.url ?? "/", `http://localhost`);
		if (pathname === "/cache") {
			if (!deps.config.cacheClearToken) {
				res.writeHead(403).end("Cache management not enabled");
				logRequest(deps, req, 403, start);
				return;
			}
			const auth = req.headers.authorization ?? "";
			if (!bearerTokenValid(auth, deps.config.cacheClearToken!)) {
				res.writeHead(401).end("Unauthorized");
				logRequest(deps, req, 401, start);
				return;
			}
			await deps.cache.handleCacheClear(req, res);
			logRequest(deps, req, res.statusCode, start);
			return;
		}
		res.writeHead(404).end("Not found");
		logRequest(deps, req, 404, start);
		return;
	}

	if (req.method === "POST") {
		// Admin-triggered domain crawl. Shares the cache-clear token because
		// both are operator endpoints with the same threat model; if you need
		// finer-grained auth, split CACHE_CLEAR_TOKEN into two env vars.
		const { pathname } = new URL(req.url ?? "/", `http://localhost`);
		if (pathname === "/crawl") {
			if (!deps.config.cacheClearToken) {
				res.writeHead(403).end("Crawl management not enabled");
				logRequest(deps, req, 403, start);
				return;
			}
			const auth = req.headers.authorization ?? "";
			if (!bearerTokenValid(auth, deps.config.cacheClearToken!)) {
				res.writeHead(401).end("Unauthorized");
				logRequest(deps, req, 401, start);
				return;
			}
			await handleCrawlEnqueue(deps, req, res, start);
			return;
		}
		res.writeHead(404).end("Not found");
		logRequest(deps, req, 404, start);
		return;
	}

	let targetUrl: string | null;
	let time: string;

	// Path-based input: /web/{14-digit-ts}{mod?}_/{url}, or the no-time
	// variant /web/{url} which falls back to the configured default time
	// (ARCHIVE_TIME). Parse against the raw req.url so the target URL's
	// own query string is preserved (a `new URL()` parse would split on
	// the first `?` and steal it).
	const pathParsed = parseWaybackPath(req.url ?? "/");
	if (pathParsed) {
		targetUrl = pathParsed.url;
		time = pathParsed.time ?? deps.config.defaultTime;
	} else {
		const reqUrl = new URL(req.url ?? "/", "http://localhost");
		targetUrl = reqUrl.searchParams.get("url");
		try {
			time = sanitizeTimeParam(reqUrl.searchParams.get("time"), deps.config.defaultTime);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Invalid time parameter";
			res.writeHead(400).end(msg);
			logRequest(deps, req, 400, start);
			return;
		}
	}

	if (targetUrl) {
		({ url: targetUrl, time } = unwrapNestedProxyUrl(
			targetUrl,
			time,
			deps.config.proxyBaseHostname,
		));
		targetUrl = unwrapRedirectUrl(normalizeHostname(targetUrl, deps.config.domainRemap));
	}

	if (!targetUrl) {
		res.writeHead(400).end("Missing url parameter");
		logRequest(deps, req, 400, start);
		return;
	}

	try {
		targetUrl = deps.validator.validateTargetUrl(targetUrl);
	} catch (e) {
		const msg = e instanceof Error ? e.message : "Invalid URL";
		res.writeHead(403).end(msg);
		logRequest(deps, req, 403, start);
		return;
	}

	if (!deps.validator.isHostWhitelisted(targetUrl, deps.config.whitelistHosts)) {
		res.writeHead(403).end("Host not whitelisted");
		logRequest(deps, req, 403, start);
		return;
	}

	// Reconstruct the upstream wayback URL the client will hit. Matches
	// the format in wayback-direct-client.ts so log search lines up with
	// outbound requests. Logged as `archiveUrl` on both success and 5xx.
	const archiveUrl = `https://web.archive.org/web/${time}id_/${targetUrl}`;

	// Negotiate SSE on Accept: text/event-stream. When the client opts in,
	// progress events are streamed before a final `result`/`error` event
	// and the connection closes. Otherwise a single buffered response is
	// returned as before.
	if (wantsEventStream(req)) {
		await sseHandler(deps, req, res, targetUrl, time, start);
		return;
	}

	try {
		const result = await deps.proxy.fetch(targetUrl, time);
		res.setHeader("Content-Type", result.contentType);
		res.setHeader("X-Archive-Url", result.archiveUrl);
		res.setHeader("X-Original-Url", result.originalUrl);
		// Map both MISS variants to "MISS" for client backward-compatibility.
		res.setHeader("X-Cache", result.cache === "HIT" ? "HIT" : "MISS");
		if (result.archiveTime) res.setHeader("X-Archive-Time", result.archiveTime);
		if (result.contentType.startsWith("text/html")) {
			res.setHeader("Content-Security-Policy", SANDBOX_CSP);
		}
		if (result.bodyPath) {
			const stream = createReadStream(result.bodyPath);
			stream.once("error", (err) => {
				deps.logger.error({ err, targetUrl, bodyPath: result.bodyPath }, "[TimeMachine] binary stream error");
				res.destroy(err as Error);
			});
			stream.pipe(res);
		} else {
			res.end(result.body);
		}
		logRequest(deps, req, 200, start, { targetUrl, time, archiveUrl, cache: result.cache });
	} catch (e) {
		const status = errorHasStatus(e) ? e.status : 500;
		if (status === 404) {
			res.writeHead(404).end("Not found in archive");
		} else if (status >= 400 && status < 500) {
			res.writeHead(status).end(`Archive returned ${status}`);
		} else {
			// `err:` (not `error:`) so pino's default Error serializer unwraps
			// message/stack/cause — otherwise the line ships as `error: {}` and
			// hides the failure (e.g. an undici `TypeError: fetch failed`).
			deps.logger.error(
				{ err: e, targetUrl, time, archiveUrl, path: req.url, method: req.method },
				"[TimeMachine] Upstream request failed",
			);
			res.writeHead(500).end("TimeMachine error: upstream request failed");
		}
		logRequest(deps, req, status, start, { targetUrl, time, archiveUrl });
	}
}

export async function wsHandler(
	ws: WebSocket,
	_req: IncomingMessage,
	deps: HandlerDeps,
): Promise<void> {
	deps.logger.info("[TimeMachine WS] Client connected");
	ws.on("error", (err) => deps.logger.error({ err }, "[TimeMachine WS] socket error"));
	let isAlive = true;
	ws.on("pong", () => {
		isAlive = true;
	});

	const keepalive = setInterval(() => {
		if (!isAlive) {
			deps.logger.info("[TimeMachine WS] Client unresponsive, terminating");
			ws.terminate();
			return;
		}
		isAlive = false;
		ws.ping();
	}, deps.config.wsKeepaliveMs);

	ws.on("close", () => {
		clearInterval(keepalive);
		deps.logger.info("[TimeMachine WS] Client disconnected");
	});

	ws.on("message", (raw: Buffer | string) => {
		const data = typeof raw === "string" ? raw : raw.toString("utf-8");
		let msg: WsRequest;
		try {
			const parsed = JSON.parse(data);
			if (!isWsRequest(parsed)) throw new SyntaxError("Invalid message shape");
			msg = parsed;
		} catch {
			if (ws.readyState !== ws.OPEN) return;
			ws.send(
				JSON.stringify({ type: "error", status: 400, message: "Invalid JSON" } as WsResponse),
			);
			return;
		}

		let time: string;
		try {
			time = sanitizeTimeParam(msg.time ?? null, deps.config.defaultTime);
		} catch {
			if (ws.readyState !== ws.OPEN) return;
			ws.send(
				JSON.stringify({
					type: "error",
					id: msg.id,
					status: 400,
					message: "Invalid time parameter",
				} as WsResponse),
			);
			return;
		}

		const { url: unwrappedUrl, time: unwrappedTime } = unwrapNestedProxyUrl(
			msg.url,
			time,
			deps.config.proxyBaseHostname,
		);
		if (unwrappedTime !== time) time = unwrappedTime;

		let targetUrl: string;
		try {
			targetUrl = deps.validator.validateTargetUrl(
				unwrapRedirectUrl(normalizeHostname(unwrappedUrl, deps.config.domainRemap)),
			);
		} catch (e) {
			if (ws.readyState !== ws.OPEN) return;
			ws.send(
				JSON.stringify({
					type: "error",
					id: msg.id,
					status: 403,
					message: e instanceof Error ? e.message : "Invalid URL",
				} as WsResponse),
			);
			return;
		}

		if (!deps.validator.isHostWhitelisted(targetUrl, deps.config.whitelistHosts)) {
			if (ws.readyState !== ws.OPEN) return;
			ws.send(
				JSON.stringify({
					type: "error",
					id: msg.id,
					status: 403,
					message: "Host not whitelisted",
				} as WsResponse),
			);
			return;
		}

		const onProgress = (p: JobProgress): void => {
			if (ws.readyState !== ws.OPEN) return;
			ws.send(
				JSON.stringify({
					type: "progress",
					id: msg.id,
					progress: p,
				} as WsResponse),
			);
		};

		deps.proxy
			.fetch(targetUrl, time, onProgress)
			.then(async (result) => {
				if (ws.readyState !== ws.OPEN) return;
				const bodyBytes = result.bodyPath
					? await fsPromises.readFile(result.bodyPath)
					: result.body;
				const bodyStr =
					typeof bodyBytes === "string" ? bodyBytes : (bodyBytes ?? Buffer.alloc(0)).toString("base64");
				ws.send(
					JSON.stringify({
						type: "result",
						id: msg.id,
						html: bodyStr,
						contentType: result.contentType,
						archiveUrl: result.archiveUrl,
						originalUrl: result.originalUrl,
						archiveTime: result.archiveTime,
						cache: result.cache === "HIT" ? "HIT" : "MISS",
					} as WsResponse),
				);
			})
			.catch((e: unknown) => {
				const status = errorHasStatus(e) ? e.status : 500;
				if (status >= 500)
					deps.logger.error(
						{
							err: e,
							targetUrl,
							time,
							archiveUrl: `https://web.archive.org/web/${time}id_/${targetUrl}`,
							wsMessageId: msg.id,
						},
						"[TimeMachine WS] Upstream request failed",
					);
				if (ws.readyState !== ws.OPEN) return;
				ws.send(
					JSON.stringify({
						type: "error",
						id: msg.id,
						status,
						message: e instanceof Error ? e.message : "Upstream request failed",
					} as WsResponse),
				);
			});
	});
}

// ---------------------------------------------------------------------------
// TimeMachineService — thin orchestrator
// ---------------------------------------------------------------------------

export class TimeMachineService implements HandlerDeps {
	private server!: http.Server;
	private wss!: WebSocketServer;
	private signalHandler?: () => void;

	constructor(
		readonly config: Config,
		readonly proxy: ProxyService,
		readonly cache: CacheService,
		readonly validator: UrlValidatorModule,
		private readonly shutdown: ShutdownController,
		readonly logger: pino.Logger,
		private readonly onStop?: () => Promise<void>,
		/** Optional status provider for GET /status. When omitted the endpoint
		 * is unavailable (404). Wired by Dependencies.getStatus in production. */
		readonly getStatus?: () => Promise<SystemStatus>,
	) {}

	start(): Promise<void> {
		this.server = http.createServer((req, res) => {
			void httpHandler(req, res, this, Date.now());
		});
		this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
		this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) =>
			void wsHandler(ws, req, this),
		);

		if (!this.signalHandler) {
			this.signalHandler = () => {
				this.stop().catch((err) => {
					this.logger.error({ err }, "shutdown failed");
					process.exit(1);
				});
			};
			process.on("SIGTERM", this.signalHandler);
			process.on("SIGINT", this.signalHandler);
		}

		// Resolve only once the underlying socket is actually bound, so callers
		// that immediately stop() (notably tests) don't race the listen callback
		// and leak a TCPSERVERWRAP handle.
		return new Promise<void>((resolve) => {
			this.server.listen(this.config.port, this.config.hostname, () => {
				this.logger.info(
					`TimeMachine server listening on http://${this.config.hostname}:${this.config.port}`,
				);
				this.logger.info(
					`TimeMachine WebSocket listening at ${this.config.hostname}:${this.config.port}/ws`,
				);
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		this.logger.info("TimeMachine shutting down...");
		if (this.signalHandler) {
			process.off("SIGTERM", this.signalHandler);
			process.off("SIGINT", this.signalHandler);
			this.signalHandler = undefined;
		}
		this.shutdown.abort();
		for (const client of this.wss.clients) client.terminate();
		await new Promise<void>((resolve) => {
			this.wss.close((err) => {
				if (err) this.logger.warn({ err }, "[TimeMachine] wss.close error");
			});
			this.server.close(() => resolve());
		});
		// Hand off to the Dependencies graph (workers → queues → redis).
		// Errors here are caught by the caller in `index.ts`; we surface them
		// rather than swallow so SIGTERM can fail loudly when shutdown breaks.
		await this.onStop?.();
	}
}
