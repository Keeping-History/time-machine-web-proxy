import type { IncomingHttpHeaders } from "node:http";
import type pino from "pino";
import { Agent, Dispatcher, Pool, ProxyAgent, request, setGlobalDispatcher } from "undici";
import type { Config, OutboundProxyChooser } from "../models/config";

type ProxyConfig = Pick<
	Config,
	| "outboundProxyUrls"
	| "outboundProxyChooser"
	| "outboundProxyUsername"
	| "outboundProxyPassword"
	| "outboundProxyCooldownMs"
	| "directFetchPoolConnections"
	| "directFetchPoolKeepaliveMs"
	| "directFetchPoolMaxConcurrentStreams"
	| "directFetchHttp2Enabled"
>;

const WAYBACK_ORIGIN = "https://web.archive.org";

function buildPoolOpts(cfg: ProxyConfig): Pool.Options {
	return {
		connections: cfg.directFetchPoolConnections,
		keepAliveTimeout: cfg.directFetchPoolKeepaliveMs,
		allowH2: cfg.directFetchHttp2Enabled,
		maxConcurrentStreams: cfg.directFetchPoolMaxConcurrentStreams,
	};
}

/** URL hit by both the startup probe and the runtime re-probe. Chosen as the
 * real workload target so a successful probe implies the proxy can reach
 * Wayback. Not configurable on purpose — keep one knob, the cooldown. */
export const PROBE_URL = "https://web.archive.org/";

/** Hard per-probe timeout — applied separately to headers and body. */
export const PROBE_TIMEOUT_MS = 30_000;

/** HTTP status codes from the proxy that indicate the proxy itself (or its
 * auth path / upstream gateway) is unhealthy. 407 = bad credentials.
 * 502/503/504 may also reflect upstream outages forwarded by the proxy; we
 * accept that false-positive in exchange for surfacing real proxy outages
 * quickly. */
export const PROXY_ERROR_STATUS = new Set([407, 502, 503, 504]);

/**
 * Install a process-wide undici dispatcher that routes all outbound `fetch()`
 * traffic — including the wayback-machine-downloader's internal CDX queries —
 * through one or more configured HTTP/HTTPS proxies (e.g. ProxyMesh, Squid).
 *
 * Must be awaited BEFORE any `fetch()` (and before `new Dependencies(config)`
 * so BullMQ's Lua-loader probes at Queue construction also flow through it).
 *
 * Behavior:
 *   - 0 URLs: no-op.
 *   - 1+ URLs: build a ProxyAgent for each, probe each in parallel against
 *     `PROBE_URL` with `PROBE_TIMEOUT_MS`, then install a RotatingProxyDispatcher.
 *     If EVERY probe fails, throw. If some fail, install with the failed agents
 *     starting in cooldown (they will be re-probed automatically).
 *
 * Fails fast on misconfiguration:
 *   - half-set credentials (USERNAME without PASSWORD or vice versa)
 *   - any URL is unparseable or non-http(s)
 *   - all proxies fail the startup connectivity probe
 *
 * Credentials (if any) are applied to every URL in the list and URL-encoded
 * into each agent's uri. The password is never logged.
 */
export async function installOutboundProxy(
	cfg: ProxyConfig,
	logger: pino.Logger,
): Promise<RotatingProxyDispatcher | null> {
	if (cfg.outboundProxyUrls.length === 0) {
		// Agent (not Pool) so that fetch()'s redirect: "follow" works correctly.
		// Pool as global dispatcher returns raw 3xx responses without re-dispatching
		// the follow-up request; Agent creates per-origin pools and handles redirect
		// routing at the fetch layer.
		const agent = new Agent(buildPoolOpts(cfg));
		setGlobalDispatcher(agent);
		logger.info(
			{ origin: WAYBACK_ORIGIN, ...buildPoolOpts(cfg) },
			"[outbound-proxy] no proxy configured; installed direct Agent for web.archive.org",
		);
		return null;
	}

	const hasUser = !!cfg.outboundProxyUsername;
	const hasPass = !!cfg.outboundProxyPassword;
	if (hasUser !== hasPass) {
		throw new Error("OUTBOUND_PROXY_USERNAME and OUTBOUND_PROXY_PASSWORD must be set together");
	}

	const uris = cfg.outboundProxyUrls.map((raw) =>
		buildProxyUri(raw, cfg.outboundProxyUsername, cfg.outboundProxyPassword, hasUser),
	);

	// allowH2 affects the proxy→origin TLS inside the CONNECT tunnel,
	// NOT the client→proxy hop (always HTTP/1.1 CONNECT). Per undici v8 docs.
	const poolOpts = buildPoolOpts(cfg);
	const built = uris.map((u) => ({
		host: u.host,
		agent: new ProxyAgent({ uri: u.value, ...poolOpts }),
	}));

	const probeResults = await Promise.all(built.map((b) => probeAgent(b.host, b.agent)));

	for (const r of probeResults) {
		if (r.ok) {
			logger.info(
				{ host: r.host, status: r.status, target: PROBE_URL },
				"[outbound-proxy] startup probe ok",
			);
		} else {
			logger.error(
				{ host: r.host, reason: r.reason, target: PROBE_URL },
				"[outbound-proxy] startup probe failed",
			);
		}
	}

	const anyOk = probeResults.some((r) => r.ok);
	if (!anyOk) {
		// A transient startup failure (e.g. DNS hiccup) shouldn't crash the worker
		// and take the BullMQ producer with it. Install all agents in cooldown and
		// let the rotator's re-probe loop restore them. Until at least one becomes
		// healthy, outbound dispatch will throw "no healthy proxy available" per
		// request — a runtime degradation, not a boot crash.
		const summary = probeResults
			.map((r) => (r.ok ? `${r.host} (ok)` : `${r.host} (${r.reason})`))
			.join(", ");
		logger.error(
			{ count: probeResults.length, summary },
			"[outbound-proxy] all startup probes failed; installing rotator with every agent in cooldown — re-probe will restore",
		);
	}

	const rotator = new RotatingProxyDispatcher(built, cfg.outboundProxyChooser, {
		baseCooldownMs: cfg.outboundProxyCooldownMs,
		logger,
	});

	for (const r of probeResults) {
		if (!r.ok) {
			rotator.markFailedExternally(r.host, r.reason);
		}
	}

	setGlobalDispatcher(rotator);
	logger.info(
		{
			hosts: built.map((b) => b.host),
			auth: hasUser ? "basic" : "ip",
			chooser: cfg.outboundProxyChooser,
			count: built.length,
			cooldownMs: cfg.outboundProxyCooldownMs,
		},
		"[outbound-proxy] installed",
	);
	return rotator;
}

interface BuiltUri {
	/** Final URI string passed to ProxyAgent, with credentials embedded if any. */
	value: string;
	/** Host:port for logging — never includes credentials. */
	host: string;
}

function buildProxyUri(
	raw: string,
	username: string,
	password: string,
	hasUser: boolean,
): BuiltUri {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`OUTBOUND_PROXY_URLS contains an invalid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(
			`OUTBOUND_PROXY_URLS entries must be http:// or https:// (got ${url.protocol} for ${raw})`,
		);
	}
	const host = url.host;
	if (hasUser) {
		// Assign userinfo BEFORE toString() so credentials are embedded in the uri.
		url.username = encodeURIComponent(username);
		url.password = encodeURIComponent(password);
	}
	return { value: url.toString(), host };
}

type ProbeResult =
	| { ok: true; host: string; status: number }
	| { ok: false; host: string; reason: string };

/**
 * One-shot connectivity probe through a single ProxyAgent. Returns a result
 * object — does not throw. A 407 response is classified as failure (auth
 * mismatch). Any other status (including 5xx) returned via the proxy counts
 * as success because we know the proxy responded.
 */
async function probeAgent(host: string, agent: Dispatcher): Promise<ProbeResult> {
	try {
		const res = await request(PROBE_URL, {
			dispatcher: agent,
			method: "GET",
			headersTimeout: PROBE_TIMEOUT_MS,
			bodyTimeout: PROBE_TIMEOUT_MS,
		});
		// Drain body to release the connection; ignore drain failures because
		// headers already came back — proxy is functioning at the transport layer.
		void res.body.dump?.().catch(() => undefined);
		if (res.statusCode === 407) {
			return { ok: false, host, reason: "proxy returned 407 (auth failed)" };
		}
		return { ok: true, host, status: res.statusCode };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { ok: false, host, reason };
	}
}

interface ProxyEntry {
	host: string;
	agent: Dispatcher;
	/** When non-null, the agent is in cooldown and won't be picked by #pick.
	 * Set to a future timestamp when failure is recorded; cleared to null on
	 * successful re-probe. */
	cooldownExpiresAt: number | null;
	/** Current cooldown window in milliseconds. Grows linearly by baseCooldownMs
	 * on each consecutive re-probe failure. Reset to 0 after a successful
	 * re-probe. */
	currentCooldownMs: number;
	/** setTimeout handle for the scheduled re-probe. Cleared on shutdown. */
	reprobeTimer: ReturnType<typeof setTimeout> | null;
}

interface RotatorOptions {
	baseCooldownMs: number;
	logger: pino.Logger;
}

/**
 * Delegating Dispatcher that forwards each `dispatch()` call to one of N
 * underlying ProxyAgents, skipping any agent currently in cooldown.
 *
 * Failure detection (per dispatch, observed via the wrapped handler):
 *   - undici `onResponseError` (transport: connect/DNS/timeout/TLS) marks the
 *     agent as failed.
 *   - Response statuses in {407, 502, 503, 504} also mark the agent as failed.
 *     5xx may originate upstream and be forwarded by the proxy — accepted
 *     trade-off for fast outage detection of bad proxies.
 *
 * On failure: linear backoff. Cooldown extends by `baseCooldownMs` per
 * consecutive failure (X, 2X, 3X, ...). A re-probe is scheduled at the
 * cooldown's expiry; success restores the agent, failure extends the cooldown
 * by another `baseCooldownMs` and schedules another re-probe.
 *
 * If every agent is currently in cooldown when `dispatch` is called, the
 * dispatcher throws synchronously — `undici.request()` and the global
 * `fetch()` both catch sync throws from `dispatch` and deliver them as
 * request errors.
 *
 * `close()` and `destroy()` cancel scheduled re-probes and forward to every
 * underlying agent.
 */
export class RotatingProxyDispatcher extends Dispatcher {
	#agents: ProxyEntry[];
	#mode: OutboundProxyChooser;
	#idx = 0;
	#baseCooldownMs: number;
	#logger: pino.Logger;
	#closed = false;

	constructor(
		built: { host: string; agent: Dispatcher }[],
		mode: OutboundProxyChooser,
		opts: RotatorOptions,
	) {
		super();
		if (built.length === 0) {
			throw new Error("RotatingProxyDispatcher requires at least one agent");
		}
		this.#agents = built.map((b) => ({
			host: b.host,
			agent: b.agent,
			cooldownExpiresAt: null,
			currentCooldownMs: 0,
			reprobeTimer: null,
		}));
		this.#mode = mode;
		this.#baseCooldownMs = opts.baseCooldownMs;
		this.#logger = opts.logger;
	}

	dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
		const entry = this.#pick();
		if (!entry) {
			throw new Error("OUTBOUND_PROXY: no healthy proxy available");
		}
		return entry.agent.dispatch(opts, this.#wrapHandler(entry, handler));
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const e of this.#agents) {
			if (e.reprobeTimer) {
				clearTimeout(e.reprobeTimer);
				e.reprobeTimer = null;
			}
		}
		await Promise.all(this.#agents.map((a) => a.agent.close()));
	}

	async destroy(): Promise<void> {
		this.#closed = true;
		for (const e of this.#agents) {
			if (e.reprobeTimer) {
				clearTimeout(e.reprobeTimer);
				e.reprobeTimer = null;
			}
		}
		await Promise.all(this.#agents.map((a) => a.agent.destroy()));
	}

	/** Test/init helper: mark an agent failed by host. Used by
	 * `installOutboundProxy` to seed cooldowns from startup-probe failures. */
	markFailedExternally(host: string, reason: string): void {
		const entry = this.#agents.find((a) => a.host === host);
		if (!entry) return;
		this.#markFailed(entry, reason);
	}

	/**
	 * Snapshot of per-agent health for the /status endpoint. `healthy` matches
	 * the same eligibility logic as `#pick`: an agent counts as healthy when
	 * its cooldown has expired, even if the re-probe timer hasn't restored
	 * `cooldownExpiresAt` to null yet.
	 */
	getStatus(): Array<{ host: string; healthy: boolean; cooldownRemainingMs: number }> {
		const now = Date.now();
		return this.#agents.map((e) => {
			const expiresAt = e.cooldownExpiresAt;
			const remaining = expiresAt === null ? 0 : Math.max(0, expiresAt - now);
			return {
				host: e.host,
				healthy: expiresAt === null || expiresAt <= now,
				cooldownRemainingMs: remaining,
			};
		});
	}

	#pick(): ProxyEntry | null {
		const now = Date.now();
		const eligible = this.#agents.filter(
			(e) => e.cooldownExpiresAt === null || e.cooldownExpiresAt <= now,
		);
		// NOTE: cooldownExpiresAt is cleared by the scheduled re-probe (the
		// authoritative restore). We treat expired-but-not-yet-reprobed entries
		// as eligible above to avoid starvation when the timer fires late.
		if (eligible.length === 0) return null;
		if (this.#mode === "random") {
			return eligible[Math.floor(Math.random() * eligible.length)];
		}
		const entry = eligible[this.#idx % eligible.length];
		this.#idx++;
		return entry;
	}

	#wrapHandler(entry: ProxyEntry, handler: Dispatcher.DispatchHandler): Dispatcher.DispatchHandler {
		const self = this;
		// Proxy (not object spread) because undici's fetch builds its handler as
		// a class instance with methods on the prototype. `{ ...handler }` would
		// drop them, and undici would reject the wrapped handler with
		// `UND_ERR_INVALID_ARG (invalid onRequestStart method)`. The Proxy
		// transparently forwards every method to the inner handler and only
		// intercepts the two we observe.
		return new Proxy(handler, {
			get(target, prop, receiver) {
				if (prop === "onResponseStart") {
					return (
						controller: Dispatcher.DispatchController,
						statusCode: number,
						headers: IncomingHttpHeaders,
						statusMessage?: string,
					) => {
						if (PROXY_ERROR_STATUS.has(statusCode)) {
							self.#markFailed(entry, `proxy returned ${statusCode}`);
						}
						const inner = Reflect.get(target, prop, receiver) as
							| ((
									c: Dispatcher.DispatchController,
									s: number,
									h: IncomingHttpHeaders,
									m?: string,
							  ) => void)
							| undefined;
						inner?.call(target, controller, statusCode, headers, statusMessage);
					};
				}
				if (prop === "onResponseError") {
					return (controller: Dispatcher.DispatchController, error: Error) => {
						const reason = error instanceof Error ? error.message : String(error);
						self.#markFailed(entry, `transport: ${reason}`);
						const inner = Reflect.get(target, prop, receiver) as
							| ((c: Dispatcher.DispatchController, e: Error) => void)
							| undefined;
						inner?.call(target, controller, error);
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as Dispatcher.DispatchHandler;
	}

	#markFailed(entry: ProxyEntry, reason: string): void {
		// Concurrent in-flight requests can all fail at once; only the first one
		// transitions state. Re-probe loop handles further failures.
		if (entry.cooldownExpiresAt !== null) return;
		entry.currentCooldownMs += this.#baseCooldownMs;
		entry.cooldownExpiresAt = Date.now() + entry.currentCooldownMs;
		this.#logger.error(
			{
				host: entry.host,
				reason,
				cooldownMs: entry.currentCooldownMs,
			},
			"[outbound-proxy] proxy taken out of rotation",
		);
		this.#scheduleReprobe(entry);
	}

	#scheduleReprobe(entry: ProxyEntry): void {
		if (this.#closed) return;
		if (entry.reprobeTimer) clearTimeout(entry.reprobeTimer);
		const timer = setTimeout(() => {
			entry.reprobeTimer = null;
			void this.#reprobe(entry);
		}, entry.currentCooldownMs);
		entry.reprobeTimer = timer;
		// Don't keep the event loop alive solely for the re-probe timer (Node-only
		// API; harmless when absent on other timer implementations e.g. fake timers).
		if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
			(timer as unknown as { unref: () => void }).unref();
		}
	}

	async #reprobe(entry: ProxyEntry): Promise<void> {
		if (this.#closed) return;
		this.#logger.info(
			{ host: entry.host, target: PROBE_URL },
			"[outbound-proxy] attempting to restore proxy to rotation",
		);
		const result = await probeAgent(entry.host, entry.agent);
		if (this.#closed) return;
		if (result.ok) {
			entry.cooldownExpiresAt = null;
			entry.currentCooldownMs = 0;
			this.#logger.info(
				{ host: entry.host, status: result.status },
				"[outbound-proxy] proxy restored to rotation",
			);
			return;
		}
		// Linear backoff: add one base cooldown per failed re-probe.
		entry.currentCooldownMs += this.#baseCooldownMs;
		entry.cooldownExpiresAt = Date.now() + entry.currentCooldownMs;
		this.#logger.error(
			{
				host: entry.host,
				reason: result.reason,
				cooldownMs: entry.currentCooldownMs,
			},
			"[outbound-proxy] re-probe failed, extending cooldown",
		);
		this.#scheduleReprobe(entry);
	}
}
