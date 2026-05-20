const setGlobalDispatcherMock = jest.fn();
const proxyAgentInstanceMarker = Symbol("ProxyAgent");
const ProxyAgentMock = jest.fn().mockImplementation((opts: { uri: string }) => ({
	__isProxyAgent: proxyAgentInstanceMarker,
	uri: opts.uri,
}));

jest.mock("undici", () => ({
	__esModule: true,
	setGlobalDispatcher: setGlobalDispatcherMock,
	ProxyAgent: ProxyAgentMock,
}));

import pino from "pino";
import { installOutboundProxy } from "../../src/lib/outbound-proxy";

type ProxyConfig = Parameters<typeof installOutboundProxy>[0];

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
	return {
		outboundProxyUrl: "",
		outboundProxyUsername: "",
		outboundProxyPassword: "",
		...overrides,
	};
}

function makeLogger(): { logger: pino.Logger; infoSpy: jest.Mock } {
	const infoSpy = jest.fn();
	const logger = pino({ level: "silent" });
	// Replace info with a jest mock so we can assert call args.
	(logger as unknown as { info: jest.Mock }).info = infoSpy;
	return { logger, infoSpy };
}

describe("installOutboundProxy", () => {
	beforeEach(() => {
		setGlobalDispatcherMock.mockClear();
		ProxyAgentMock.mockClear();
	});

	it("does not install when outboundProxyUrl is empty (no-op)", () => {
		const { logger, infoSpy } = makeLogger();
		installOutboundProxy(makeConfig({ outboundProxyUrl: "" }), logger);
		expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
		expect(ProxyAgentMock).not.toHaveBeenCalled();
		expect(infoSpy).not.toHaveBeenCalled();
	});

	it("installs with IP auth (URL only) and logs auth: 'ip'", () => {
		const { logger, infoSpy } = makeLogger();
		installOutboundProxy(
			makeConfig({ outboundProxyUrl: "http://us-wa-load-balancer.proxymesh.com:31280" }),
			logger,
		);
		expect(ProxyAgentMock).toHaveBeenCalledTimes(1);
		expect(ProxyAgentMock).toHaveBeenCalledWith({
			uri: "http://us-wa-load-balancer.proxymesh.com:31280/",
		});
		expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
		expect(setGlobalDispatcherMock).toHaveBeenCalledWith(
			expect.objectContaining({ __isProxyAgent: proxyAgentInstanceMarker }),
		);
		expect(infoSpy).toHaveBeenCalledTimes(1);
		expect(infoSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				host: "us-wa-load-balancer.proxymesh.com:31280",
				auth: "ip",
			}),
			"[outbound-proxy] installed",
		);
	});

	it("installs with basic auth (URL + creds), URL-encoded into the uri, logs auth: 'basic'", () => {
		const { logger, infoSpy } = makeLogger();
		installOutboundProxy(
			makeConfig({
				outboundProxyUrl: "http://proxy.example.com:31280",
				outboundProxyUsername: "alice",
				outboundProxyPassword: "secret123",
			}),
			logger,
		);
		expect(ProxyAgentMock).toHaveBeenCalledTimes(1);
		const callArg = ProxyAgentMock.mock.calls[0][0] as { uri: string };
		expect(callArg.uri).toMatch(/^http:\/\/alice:secret123@proxy\.example\.com:31280\/?$/);
		expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
		expect(infoSpy).toHaveBeenCalledWith(
			expect.objectContaining({ host: "proxy.example.com:31280", auth: "basic" }),
			"[outbound-proxy] installed",
		);
	});

	it("URL-encodes special characters in username and password", () => {
		const { logger } = makeLogger();
		installOutboundProxy(
			makeConfig({
				outboundProxyUrl: "http://proxy.example.com:31280",
				outboundProxyUsername: "user@name",
				outboundProxyPassword: "p@ss/w:rd",
			}),
			logger,
		);
		const callArg = ProxyAgentMock.mock.calls[0][0] as { uri: string };
		// Username "user@name" → "user%40name"; password "p@ss/w:rd" → "p%40ss%2Fw%3Ard"
		expect(callArg.uri).toContain("user%40name");
		expect(callArg.uri).toContain("p%40ss%2Fw%3Ard");
		// Userinfo is between "//" and the last "@" before host — must be exactly
		// the URL-encoded form, with no raw special characters left in place.
		const userinfo = callArg.uri.replace(/^http:\/\//, "").split("@")[0];
		expect(userinfo).toBe("user%40name:p%40ss%2Fw%3Ard");
	});

	it("throws when USERNAME is set but PASSWORD is empty", () => {
		const { logger } = makeLogger();
		expect(() =>
			installOutboundProxy(
				makeConfig({
					outboundProxyUrl: "http://proxy.example.com:31280",
					outboundProxyUsername: "alice",
					outboundProxyPassword: "",
				}),
				logger,
			),
		).toThrow(/USERNAME.*PASSWORD.*must be set together/i);
		expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
	});

	it("throws when PASSWORD is set but USERNAME is empty", () => {
		const { logger } = makeLogger();
		expect(() =>
			installOutboundProxy(
				makeConfig({
					outboundProxyUrl: "http://proxy.example.com:31280",
					outboundProxyUsername: "",
					outboundProxyPassword: "secret",
				}),
				logger,
			),
		).toThrow(/USERNAME.*PASSWORD.*must be set together/i);
		expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
	});

	it("throws when URL parses but protocol is not http/https", () => {
		const { logger } = makeLogger();
		expect(() =>
			installOutboundProxy(
				makeConfig({ outboundProxyUrl: "ftp://proxy.example.com:31280" }),
				logger,
			),
		).toThrow(/must be http:\/\/ or https:\/\//i);
		expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
	});

	it("throws when URL is completely unparseable", () => {
		const { logger } = makeLogger();
		expect(() =>
			installOutboundProxy(makeConfig({ outboundProxyUrl: "not a url at all" }), logger),
		).toThrow(/not a valid URL/i);
		expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
	});

	it("never includes the password in log call arguments", () => {
		const { logger, infoSpy } = makeLogger();
		const password = "super-secret-do-not-log-me-12345";
		installOutboundProxy(
			makeConfig({
				outboundProxyUrl: "http://proxy.example.com:31280",
				outboundProxyUsername: "alice",
				outboundProxyPassword: password,
			}),
			logger,
		);
		expect(infoSpy).toHaveBeenCalledTimes(1);
		const logArgs = JSON.stringify(infoSpy.mock.calls);
		expect(logArgs).not.toContain(password);
	});

	it("accepts https:// proxy URLs", () => {
		const { logger, infoSpy } = makeLogger();
		installOutboundProxy(
			makeConfig({ outboundProxyUrl: "https://secure-proxy.example.com:8443" }),
			logger,
		);
		expect(ProxyAgentMock).toHaveBeenCalledTimes(1);
		const callArg = ProxyAgentMock.mock.calls[0][0] as { uri: string };
		expect(callArg.uri).toMatch(/^https:\/\/secure-proxy\.example\.com:8443\/?$/);
		expect(infoSpy).toHaveBeenCalledWith(
			expect.objectContaining({ host: "secure-proxy.example.com:8443", auth: "ip" }),
			"[outbound-proxy] installed",
		);
	});
});
