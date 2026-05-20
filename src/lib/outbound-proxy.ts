import type pino from "pino";
import { Dispatcher, ProxyAgent, setGlobalDispatcher } from "undici";
import type { Config, OutboundProxyChooser } from "../models/config";

type ProxyConfig = Pick<
	Config,
	"outboundProxyUrls" | "outboundProxyChooser" | "outboundProxyUsername" | "outboundProxyPassword"
>;

/**
 * Install a process-wide undici dispatcher that routes all outbound `fetch()`
 * traffic — including the wayback-machine-downloader's internal CDX queries —
 * through one or more configured HTTP/HTTPS proxies (e.g. ProxyMesh, Squid).
 *
 * Must be called BEFORE any `fetch()` (and before `new Dependencies(config)`
 * so BullMQ's Lua-loader probes at Queue construction also flow through it).
 *
 * Behavior by URL count:
 *   - 0 URLs: no-op.
 *   - 1 URL: install a single ProxyAgent. `outboundProxyChooser` is ignored.
 *   - 2+ URLs: install a RotatingProxyDispatcher that picks one of N
 *     ProxyAgents per outbound request, using `outboundProxyChooser` to
 *     select between sequential (round-robin) and random distribution.
 *
 * Fails fast on misconfiguration:
 *   - half-set credentials (USERNAME without PASSWORD or vice versa)
 *   - any URL is unparseable or non-http(s)
 *
 * Credentials (if any) are applied to every URL in the list and URL-encoded
 * into each agent's uri. The password is never logged.
 */
export function installOutboundProxy(cfg: ProxyConfig, logger: pino.Logger): void {
	if (cfg.outboundProxyUrls.length === 0) return;

	const hasUser = !!cfg.outboundProxyUsername;
	const hasPass = !!cfg.outboundProxyPassword;
	if (hasUser !== hasPass) {
		throw new Error(
			"OUTBOUND_PROXY_USERNAME and OUTBOUND_PROXY_PASSWORD must be set together",
		);
	}

	const uris = cfg.outboundProxyUrls.map((raw) =>
		buildProxyUri(raw, cfg.outboundProxyUsername, cfg.outboundProxyPassword, hasUser),
	);

	if (uris.length === 1) {
		const uri = uris[0];
		setGlobalDispatcher(new ProxyAgent({ uri: uri.value }));
		logger.info(
			{ host: uri.host, auth: hasUser ? "basic" : "ip" },
			"[outbound-proxy] installed",
		);
		return;
	}

	const agents = uris.map((u) => new ProxyAgent({ uri: u.value }));
	setGlobalDispatcher(new RotatingProxyDispatcher(agents, cfg.outboundProxyChooser));
	logger.info(
		{
			hosts: uris.map((u) => u.host),
			auth: hasUser ? "basic" : "ip",
			chooser: cfg.outboundProxyChooser,
			count: uris.length,
		},
		"[outbound-proxy] installed (rotating)",
	);
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

/**
 * Delegating Dispatcher that forwards each `dispatch()` call to one of N
 * underlying ProxyAgents. Selection is sequential (monotonic round-robin)
 * or random per the mode passed at construction.
 *
 * `close()` and `destroy()` are forwarded to all underlying agents so the
 * server can shut down cleanly.
 */
export class RotatingProxyDispatcher extends Dispatcher {
	#agents: Dispatcher[];
	#mode: OutboundProxyChooser;
	#idx = 0;

	constructor(agents: Dispatcher[], mode: OutboundProxyChooser) {
		super();
		if (agents.length === 0) {
			throw new Error("RotatingProxyDispatcher requires at least one agent");
		}
		this.#agents = agents;
		this.#mode = mode;
	}

	dispatch(
		opts: Dispatcher.DispatchOptions,
		handler: Dispatcher.DispatchHandler,
	): boolean {
		return this.#pick().dispatch(opts, handler);
	}

	async close(): Promise<void> {
		await Promise.all(this.#agents.map((a) => a.close()));
	}

	async destroy(): Promise<void> {
		await Promise.all(this.#agents.map((a) => a.destroy()));
	}

	#pick(): Dispatcher {
		if (this.#mode === "random") {
			return this.#agents[Math.floor(Math.random() * this.#agents.length)];
		}
		const agent = this.#agents[this.#idx];
		this.#idx = (this.#idx + 1) % this.#agents.length;
		return agent;
	}
}
