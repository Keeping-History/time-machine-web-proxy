import type pino from "pino";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import type { Config } from "../models/config";

/**
 * Install a process-wide undici dispatcher that routes all outbound `fetch()`
 * traffic — including the wayback-machine-downloader's internal CDX queries —
 * through the configured HTTP/HTTPS proxy (e.g. ProxyMesh, Squid).
 *
 * Must be called BEFORE any `fetch()` (and before `new Dependencies(config)`
 * so BullMQ's Lua-loader probes at Queue construction also flow through it).
 *
 * No-op when `outboundProxyUrl` is empty. Fails fast on misconfiguration:
 *  - half-set credentials (USERNAME without PASSWORD or vice versa)
 *  - unparseable URL
 *  - non-http(s) protocol
 *
 * The password is URL-encoded into the dispatcher uri but never logged.
 */
export function installOutboundProxy(
	cfg: Pick<Config, "outboundProxyUrl" | "outboundProxyUsername" | "outboundProxyPassword">,
	logger: pino.Logger,
): void {
	if (!cfg.outboundProxyUrl) return;

	const hasUser = !!cfg.outboundProxyUsername;
	const hasPass = !!cfg.outboundProxyPassword;
	if (hasUser !== hasPass) {
		throw new Error("OUTBOUND_PROXY_USERNAME and OUTBOUND_PROXY_PASSWORD must be set together");
	}

	let url: URL;
	try {
		url = new URL(cfg.outboundProxyUrl);
	} catch {
		throw new Error(`OUTBOUND_PROXY_URL is not a valid URL: ${cfg.outboundProxyUrl}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`OUTBOUND_PROXY_URL must be http:// or https:// (got ${url.protocol})`);
	}

	if (hasUser) {
		// Assign userinfo BEFORE toString() so credentials are embedded in the uri.
		url.username = encodeURIComponent(cfg.outboundProxyUsername);
		url.password = encodeURIComponent(cfg.outboundProxyPassword);
	}

	setGlobalDispatcher(new ProxyAgent({ uri: url.toString() }));
	logger.info({ host: url.host, auth: hasUser ? "basic" : "ip" }, "[outbound-proxy] installed");
}
