import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type pino from "pino";
import { type WebSocket, WebSocketServer } from "ws";
import { errorHasStatus } from "../lib/errors";
import type { ShutdownController } from "../lib/shutdown";
import { parseWaybackPath, sanitizeTimeParam, unwrapNestedProxyUrl } from "../lib/url-rewriter";
import type { Config } from "../models/config";
import type { JobProgress } from "../models/job-progress";
import { isWsRequest, type WsRequest, type WsResponse } from "../models/websocket";
import type { CacheService } from "./cache";
import type { ProxyService } from "./proxy";

export interface UrlValidatorModule {
	validateTargetUrl: (url: string) => string;
	isHostWhitelisted: (url: string, whitelistHosts: string) => boolean;
}

export class TimeMachineService {
	private server!: http.Server;
	private wss!: WebSocketServer;
	private signalHandler?: () => void;

	constructor(
		private readonly config: Config,
		private readonly proxy: ProxyService,
		private readonly cache: CacheService,
		private readonly validator: UrlValidatorModule,
		private readonly shutdown: ShutdownController,
		private readonly logger: pino.Logger,
		private readonly onStop?: () => Promise<void>,
		/** Optional status provider for GET /status. When omitted the endpoint
		 * is unavailable (404). Wired by Dependencies.getStatus in production. */
		private readonly getStatus?: () => Promise<unknown>,
	) {}

	start(): Promise<void> {
		this.server = http.createServer((req, res) => {
			void this.httpHandler(req, res);
		});
		this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
		this.wss.on("connection", (ws: WebSocket) => this.wsHandler(ws));

		if (!this.signalHandler) {
			this.signalHandler = () => void this.stop();
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
			this.wss.close();
			this.server.close(() => resolve());
		});
		// Hand off to the Dependencies graph (workers → queues → redis).
		// Errors here are caught by the caller in `index.ts`; we surface them
		// rather than swallow so SIGTERM can fail loudly when shutdown breaks.
		await this.onStop?.();
	}

	private async handleCrawlEnqueue(
		req: IncomingMessage,
		res: ServerResponse,
		start: number,
	): Promise<void> {
		const u = new URL(req.url ?? "/", "http://localhost");
		const host = u.searchParams.get("host");
		let time: string;
		try {
			time = sanitizeTimeParam(u.searchParams.get("time"), this.config.defaultTime);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Invalid time parameter";
			res.writeHead(400).end(msg);
			this.logRequest(req, 400, start);
			return;
		}
		// Hostname charset: letters, digits, dots, hyphens. Reject everything else
		// up-front so we don't smuggle path/query/auth segments into the host slot
		// (which would later land in the cache directory layout and CDX URL).
		if (!host || !/^[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?$/i.test(host)) {
			res.writeHead(400).end("Invalid or missing host");
			this.logRequest(req, 400, start);
			return;
		}
		// Opt-in: skip the CDX size preflight. Only "true" (case-insensitive)
		// counts as opt-in — typos like "yes"/"1" must NOT silently disable the
		// safety net.
		const skipPreflight = (u.searchParams.get("skip_preflight") ?? "").toLowerCase() === "true";
		try {
			await this.proxy.triggerDomainCrawl(host, time, { skipPreflight });
			res.setHeader("Content-Type", "application/json");
			res.writeHead(202).end(JSON.stringify({ host, time, preflightSkipped: skipPreflight }));
			this.logRequest(req, 202, start);
		} catch (e) {
			const status = errorHasStatus(e) ? e.status : 500;
			const message = e instanceof Error ? e.message : "crawl enqueue failed";
			if (status >= 500) this.logger.error({ error: e }, "[TimeMachine] crawl enqueue failed");
			res.setHeader("Content-Type", "application/json");
			res.writeHead(status).end(JSON.stringify({ error: message }));
			this.logRequest(req, status, start);
		}
	}

	private setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
		const origin = req.headers.origin;
		const allowed = this.config.allowedOrigins;
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

	private async httpHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const start = Date.now();
		this.setCorsHeaders(req, res);

		if (req.method === "OPTIONS") {
			res.writeHead(204).end();
			this.logger.debug({
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
				if (!this.getStatus) {
					res.writeHead(404).end("Status endpoint not available");
					this.logRequest(req, 404, start);
					return;
				}
				try {
					const status = await this.getStatus();
					res.setHeader("Content-Type", "application/json");
					res.writeHead(200).end(JSON.stringify(status));
					this.logRequest(req, 200, start);
				} catch (e) {
					this.logger.error({ error: e }, "[TimeMachine] status probe failed");
					res.setHeader("Content-Type", "application/json");
					res
						.writeHead(500)
						.end(
							JSON.stringify({ error: e instanceof Error ? e.message : "status probe failed" }),
						);
					this.logRequest(req, 500, start);
				}
				return;
			}
			// Other GETs fall through to the existing /web/{ts}/{url} + ?url= flow.
		}

		if (req.method === "DELETE") {
			const { pathname } = new URL(req.url ?? "/", `http://localhost`);
			if (pathname === "/cache") {
				if (!this.config.cacheClearToken) {
					res.writeHead(403).end("Cache management not enabled");
					this.logRequest(req, 403, start);
					return;
				}
				const auth = req.headers.authorization ?? "";
				if (auth !== `Bearer ${this.config.cacheClearToken}`) {
					res.writeHead(401).end("Unauthorized");
					this.logRequest(req, 401, start);
					return;
				}
				await this.cache.handleCacheClear(req, res);
				this.logRequest(req, 200, start);
				return;
			}
			res.writeHead(404).end("Not found");
			this.logRequest(req, 404, start);
			return;
		}

		if (req.method === "POST") {
			// Admin-triggered domain crawl. Shares the cache-clear token because
			// both are operator endpoints with the same threat model; if you need
			// finer-grained auth, split CACHE_CLEAR_TOKEN into two env vars.
			const { pathname } = new URL(req.url ?? "/", `http://localhost`);
			if (pathname === "/crawl") {
				if (!this.config.cacheClearToken) {
					res.writeHead(403).end("Crawl management not enabled");
					this.logRequest(req, 403, start);
					return;
				}
				const auth = req.headers.authorization ?? "";
				if (auth !== `Bearer ${this.config.cacheClearToken}`) {
					res.writeHead(401).end("Unauthorized");
					this.logRequest(req, 401, start);
					return;
				}
				await this.handleCrawlEnqueue(req, res, start);
				return;
			}
			res.writeHead(404).end("Not found");
			this.logRequest(req, 404, start);
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
			time = pathParsed.time ?? this.config.defaultTime;
		} else {
			const reqUrl = new URL(req.url ?? "/", "http://localhost");
			targetUrl = reqUrl.searchParams.get("url");
			try {
				time = sanitizeTimeParam(reqUrl.searchParams.get("time"), this.config.defaultTime);
			} catch (e) {
				const msg = e instanceof Error ? e.message : "Invalid time parameter";
				res.writeHead(400).end(msg);
				this.logRequest(req, 400, start);
				return;
			}
		}

		if (targetUrl) {
			({ url: targetUrl, time } = unwrapNestedProxyUrl(
				targetUrl,
				time,
				this.config.proxyBaseHostname,
			));
		}

		if (!targetUrl) {
			res.writeHead(400).end("Missing url parameter");
			this.logRequest(req, 400, start);
			return;
		}

		try {
			targetUrl = this.validator.validateTargetUrl(targetUrl);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Invalid URL";
			res.writeHead(403).end(msg);
			this.logRequest(req, 403, start);
			return;
		}

		if (!this.validator.isHostWhitelisted(targetUrl, this.config.whitelistHosts)) {
			res.writeHead(403).end("Host not whitelisted");
			this.logRequest(req, 403, start);
			return;
		}

		// Negotiate SSE on Accept: text/event-stream. When the client opts in,
		// progress events are streamed before a final `result`/`error` event
		// and the connection closes. Otherwise a single buffered response is
		// returned as before.
		if (this.wantsEventStream(req)) {
			await this.sseHandler(req, res, targetUrl, time, start);
			return;
		}

		try {
			const result = await this.proxy.fetch(targetUrl, time);
			res.setHeader("Content-Type", result.contentType);
			res.setHeader("X-Archive-Url", result.archiveUrl);
			res.setHeader("X-Original-Url", result.originalUrl);
			res.setHeader("X-Cache", result.cache);
			if (result.archiveTime) res.setHeader("X-Archive-Time", result.archiveTime);
			res.end(result.body);
			this.logRequest(req, 200, start);
		} catch (e) {
			const status = errorHasStatus(e) ? e.status : 500;
			if (status === 404) {
				res.writeHead(404).end("Not found in archive");
			} else if (status >= 400 && status < 500) {
				res.writeHead(status).end(`Archive returned ${status}`);
			} else {
				this.logger.error({ error: e }, "[TimeMachine] Upstream request failed");
				res.writeHead(500).end("TimeMachine error: upstream request failed");
			}
			this.logRequest(req, status, start);
		}
	}

	private wantsEventStream(req: IncomingMessage): boolean {
		const accept = req.headers.accept;
		if (typeof accept !== "string") return false;
		return accept.split(",").some((part) => part.trim().startsWith("text/event-stream"));
	}

	private async sseHandler(
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
		});

		const writeEvent = (event: string, data: unknown): void => {
			if (res.writableEnded) return;
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};

		// Forward progress events from the proxy/worker to the client. Body is
		// excluded — final result frame carries the body.
		const onProgress = (p: JobProgress): void => writeEvent("progress", p);

		try {
			const result = await this.proxy.fetch(targetUrl, time, onProgress);
			const bodyStr =
				typeof result.body === "string" ? result.body : result.body.toString("base64");
			writeEvent("result", {
				body: bodyStr,
				bodyEncoding: typeof result.body === "string" ? "utf8" : "base64",
				contentType: result.contentType,
				archiveUrl: result.archiveUrl,
				originalUrl: result.originalUrl,
				archiveTime: result.archiveTime,
				cache: result.cache,
			});
			res.end();
			this.logRequest(req, 200, start);
		} catch (e) {
			const status = errorHasStatus(e) ? e.status : 500;
			if (status >= 500) {
				this.logger.error({ error: e }, "[TimeMachine SSE] Upstream request failed");
			}
			writeEvent("error", {
				status,
				message: e instanceof Error ? e.message : "Upstream request failed",
			});
			res.end();
			this.logRequest(req, status, start);
		}
	}

	private wsHandler(ws: WebSocket): void {
		this.logger.info("[TimeMachine WS] Client connected");
		let isAlive = true;
		ws.on("pong", () => {
			isAlive = true;
		});

		const keepalive = setInterval(() => {
			if (!isAlive) {
				this.logger.info("[TimeMachine WS] Client unresponsive, terminating");
				ws.terminate();
				return;
			}
			isAlive = false;
			ws.ping();
		}, this.config.wsKeepaliveMs);

		ws.on("close", () => {
			clearInterval(keepalive);
			this.logger.info("[TimeMachine WS] Client disconnected");
		});

		ws.on("message", (raw: Buffer | string) => {
			const data = typeof raw === "string" ? raw : raw.toString("utf-8");
			let msg: WsRequest;
			try {
				const parsed = JSON.parse(data);
				if (!isWsRequest(parsed)) throw new SyntaxError("Invalid message shape");
				msg = parsed;
			} catch {
				ws.send(
					JSON.stringify({ type: "error", status: 400, message: "Invalid JSON" } as WsResponse),
				);
				return;
			}

			let time: string;
			try {
				time = sanitizeTimeParam(msg.time ?? null, this.config.defaultTime);
			} catch {
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
				this.config.proxyBaseHostname,
			);
			if (unwrappedTime !== time) time = unwrappedTime;

			let targetUrl: string;
			try {
				targetUrl = this.validator.validateTargetUrl(unwrappedUrl);
			} catch (e) {
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

			if (!this.validator.isHostWhitelisted(targetUrl, this.config.whitelistHosts)) {
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

			this.proxy
				.fetch(targetUrl, time, onProgress)
				.then((result) => {
					if (ws.readyState !== ws.OPEN) return;
					const bodyStr =
						typeof result.body === "string" ? result.body : result.body.toString("base64");
					ws.send(
						JSON.stringify({
							type: "result",
							id: msg.id,
							html: bodyStr,
							contentType: result.contentType,
							archiveUrl: result.archiveUrl,
							originalUrl: result.originalUrl,
							archiveTime: result.archiveTime,
							cache: result.cache,
						} as WsResponse),
					);
				})
				.catch((e: unknown) => {
					const status = errorHasStatus(e) ? e.status : 500;
					if (status >= 500)
						this.logger.error({ error: e }, "[TimeMachine WS] Upstream request failed");
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

	private logRequest(req: IncomingMessage, status: number, startMs: number): void {
		this.logger.info({
			method: req.method,
			path: req.url,
			status,
			durationMs: Date.now() - startMs,
		});
	}
}
