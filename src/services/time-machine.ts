import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type pino from "pino";
import { type WebSocket, WebSocketServer } from "ws";
import { errorHasStatus } from "../lib/errors";
import type { ShutdownController } from "../lib/shutdown";
import { sanitizeTimeParam, unwrapNestedProxyUrl } from "../lib/url-rewriter";
import type { Config } from "../models/config";
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
	) {}

	start(): void {
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

		this.server.listen(this.config.port, this.config.hostname, () => {
			this.logger.info(
				`TimeMachine server listening on http://${this.config.hostname}:${this.config.port}`,
			);
			this.logger.info(
				`TimeMachine WebSocket listening at ${this.config.hostname}:${this.config.port}/ws`,
			);
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
	}

	private setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
		const origin = req.headers.origin;
		const allowed = this.config.allowedOrigins;
		if (origin && (allowed.includes("*") || allowed.includes(origin))) {
			res.setHeader("Access-Control-Allow-Origin", allowed.includes("*") ? "*" : origin);
		}
		res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

		const reqUrl = new URL(req.url ?? "/", "http://localhost");
		let targetUrl = reqUrl.searchParams.get("url");
		let time: string;
		try {
			time = sanitizeTimeParam(reqUrl.searchParams.get("time"), this.config.defaultTime);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Invalid time parameter";
			res.writeHead(400).end(msg);
			this.logRequest(req, 400, start);
			return;
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

			this.proxy
				.fetch(targetUrl, time)
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
