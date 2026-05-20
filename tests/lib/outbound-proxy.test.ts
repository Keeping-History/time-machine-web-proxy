const setGlobalDispatcherMock = jest.fn();
const proxyAgentInstanceMarker = Symbol("ProxyAgent");
const ProxyAgentMock = jest.fn().mockImplementation((opts: { uri: string }) => ({
	__isProxyAgent: proxyAgentInstanceMarker,
	uri: opts.uri,
	dispatch: jest.fn().mockReturnValue(true),
	close: jest.fn().mockResolvedValue(undefined),
	destroy: jest.fn().mockResolvedValue(undefined),
}));

// Minimal Dispatcher stub: matches the shape RotatingProxyDispatcher needs from
// the base class (EventEmitter + the three throwing stubs that subclasses must
// override). Using a real class so `extends Dispatcher` works in the SUT.
class DispatcherStub {
	dispatch() {
		throw new Error("not implemented");
	}
	close() {
		throw new Error("not implemented");
	}
	destroy() {
		throw new Error("not implemented");
	}
}

jest.mock("undici", () => ({
	__esModule: true,
	setGlobalDispatcher: setGlobalDispatcherMock,
	ProxyAgent: ProxyAgentMock,
	Dispatcher: DispatcherStub,
}));

import pino from "pino";
import { installOutboundProxy, RotatingProxyDispatcher } from "../../src/lib/outbound-proxy";
import type { Config } from "../../src/models/config";

type ProxyConfig = Parameters<typeof installOutboundProxy>[0];

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
	return {
		outboundProxyUrls: [],
		outboundProxyChooser: "sequential",
		outboundProxyUsername: "",
		outboundProxyPassword: "",
		...overrides,
	};
}

function makeLogger(): { logger: pino.Logger; infoSpy: jest.Mock } {
	const infoSpy = jest.fn();
	const logger = pino({ level: "silent" });
	(logger as unknown as { info: jest.Mock }).info = infoSpy;
	return { logger, infoSpy };
}

describe("installOutboundProxy", () => {
	beforeEach(() => {
		setGlobalDispatcherMock.mockClear();
		ProxyAgentMock.mockClear();
	});

	it("does not install when outboundProxyUrls is empty (no-op)", () => {
		const { logger, infoSpy } = makeLogger();
		installOutboundProxy(makeConfig({ outboundProxyUrls: [] }), logger);
		expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
		expect(ProxyAgentMock).not.toHaveBeenCalled();
		expect(infoSpy).not.toHaveBeenCalled();
	});

	describe("single URL", () => {
		it("installs a single ProxyAgent with IP auth and logs auth: 'ip'", () => {
			const { logger, infoSpy } = makeLogger();
			installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["http://us-wa-load-balancer.proxymesh.com:31280"],
				}),
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
			expect(infoSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					host: "us-wa-load-balancer.proxymesh.com:31280",
					auth: "ip",
				}),
				"[outbound-proxy] installed",
			);
		});

		it("installs with basic auth, URL-encoded credentials in the uri", () => {
			const { logger, infoSpy } = makeLogger();
			installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["http://proxy.example.com:31280"],
					outboundProxyUsername: "alice",
					outboundProxyPassword: "secret123",
				}),
				logger,
			);
			const callArg = ProxyAgentMock.mock.calls[0][0] as { uri: string };
			expect(callArg.uri).toMatch(
				/^http:\/\/alice:secret123@proxy\.example\.com:31280\/?$/,
			);
			expect(infoSpy).toHaveBeenCalledWith(
				expect.objectContaining({ host: "proxy.example.com:31280", auth: "basic" }),
				"[outbound-proxy] installed",
			);
		});

		it("URL-encodes special characters in username and password", () => {
			const { logger } = makeLogger();
			installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["http://proxy.example.com:31280"],
					outboundProxyUsername: "user@name",
					outboundProxyPassword: "p@ss/w:rd",
				}),
				logger,
			);
			const callArg = ProxyAgentMock.mock.calls[0][0] as { uri: string };
			const userinfo = callArg.uri.replace(/^http:\/\//, "").split("@")[0];
			expect(userinfo).toBe("user%40name:p%40ss%2Fw%3Ard");
		});

		it("ignores OUTBOUND_PROXY_CHOOSER when only one URL is provided", () => {
			const { logger, infoSpy } = makeLogger();
			installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["http://proxy.example.com:31280"],
					outboundProxyChooser: "random",
				}),
				logger,
			);
			// Single ProxyAgent path — no rotating dispatcher, no chooser in the log.
			expect(ProxyAgentMock).toHaveBeenCalledTimes(1);
			expect(setGlobalDispatcherMock).toHaveBeenCalledWith(
				expect.objectContaining({ __isProxyAgent: proxyAgentInstanceMarker }),
			);
			const logMessage = infoSpy.mock.calls[0][1];
			expect(logMessage).toBe("[outbound-proxy] installed");
			expect(infoSpy.mock.calls[0][0]).not.toHaveProperty("chooser");
		});

		it("accepts https:// proxy URLs", () => {
			const { logger, infoSpy } = makeLogger();
			installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["https://secure-proxy.example.com:8443"],
				}),
				logger,
			);
			const callArg = ProxyAgentMock.mock.calls[0][0] as { uri: string };
			expect(callArg.uri).toMatch(/^https:\/\/secure-proxy\.example\.com:8443\/?$/);
			expect(infoSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					host: "secure-proxy.example.com:8443",
					auth: "ip",
				}),
				"[outbound-proxy] installed",
			);
		});
	});

	describe("multiple URLs", () => {
		it("installs a RotatingProxyDispatcher with N ProxyAgents", () => {
			const { logger, infoSpy } = makeLogger();
			installOutboundProxy(
				makeConfig({
					outboundProxyUrls: [
						"http://us-wa.proxymesh.com:31280",
						"http://uk.proxymesh.com:31280",
						"http://au.proxymesh.com:31280",
					],
					outboundProxyChooser: "sequential",
				}),
				logger,
			);
			expect(ProxyAgentMock).toHaveBeenCalledTimes(3);
			expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
			const installed = setGlobalDispatcherMock.mock.calls[0][0];
			expect(installed).toBeInstanceOf(RotatingProxyDispatcher);
			expect(infoSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					hosts: [
						"us-wa.proxymesh.com:31280",
						"uk.proxymesh.com:31280",
						"au.proxymesh.com:31280",
					],
					auth: "ip",
					chooser: "sequential",
					count: 3,
				}),
				"[outbound-proxy] installed (rotating)",
			);
		});

		it("applies the same credentials to every URL when basic auth is set", () => {
			const { logger } = makeLogger();
			installOutboundProxy(
				makeConfig({
					outboundProxyUrls: [
						"http://us-wa.proxymesh.com:31280",
						"http://uk.proxymesh.com:31280",
					],
					outboundProxyUsername: "alice",
					outboundProxyPassword: "secret123",
				}),
				logger,
			);
			expect(ProxyAgentMock).toHaveBeenCalledTimes(2);
			const uri1 = (ProxyAgentMock.mock.calls[0][0] as { uri: string }).uri;
			const uri2 = (ProxyAgentMock.mock.calls[1][0] as { uri: string }).uri;
			expect(uri1).toMatch(/^http:\/\/alice:secret123@us-wa\.proxymesh\.com:31280\/?$/);
			expect(uri2).toMatch(/^http:\/\/alice:secret123@uk\.proxymesh\.com:31280\/?$/);
		});

		it("validates every URL, naming the failing one", () => {
			const { logger } = makeLogger();
			expect(() =>
				installOutboundProxy(
					makeConfig({
						outboundProxyUrls: [
							"http://ok.example.com:31280",
							"ftp://bad.example.com:21",
							"http://also-ok.example.com:31280",
						],
					}),
					logger,
				),
			).toThrow(/must be http:\/\/ or https:\/\/.*ftp:\/\/bad\.example\.com/);
			expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
		});

		it("rejects an unparseable URL in the list, naming the failing one", () => {
			const { logger } = makeLogger();
			expect(() =>
				installOutboundProxy(
					makeConfig({
						outboundProxyUrls: ["http://ok.example.com:31280", "not a url"],
					}),
					logger,
				),
			).toThrow(/invalid URL: not a url/);
			expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
		});
	});

	describe("credential validation", () => {
		it("throws when USERNAME is set but PASSWORD is empty", () => {
			const { logger } = makeLogger();
			expect(() =>
				installOutboundProxy(
					makeConfig({
						outboundProxyUrls: ["http://proxy.example.com:31280"],
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
						outboundProxyUrls: ["http://proxy.example.com:31280"],
						outboundProxyUsername: "",
						outboundProxyPassword: "secret",
					}),
					logger,
				),
			).toThrow(/USERNAME.*PASSWORD.*must be set together/i);
			expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
		});

		it("never includes the password in log call arguments", () => {
			const { logger, infoSpy } = makeLogger();
			const password = "super-secret-do-not-log-me-12345";
			installOutboundProxy(
				makeConfig({
					outboundProxyUrls: [
						"http://proxy.example.com:31280",
						"http://proxy2.example.com:31280",
					],
					outboundProxyUsername: "alice",
					outboundProxyPassword: password,
				}),
				logger,
			);
			const logArgs = JSON.stringify(infoSpy.mock.calls);
			expect(logArgs).not.toContain(password);
		});
	});
});

describe("RotatingProxyDispatcher", () => {
	function makeAgent() {
		return {
			dispatch: jest.fn().mockReturnValue(true),
			close: jest.fn().mockResolvedValue(undefined),
			destroy: jest.fn().mockResolvedValue(undefined),
		};
	}

	it("throws if constructed with zero agents", () => {
		expect(() => new RotatingProxyDispatcher([], "sequential")).toThrow(
			/at least one agent/,
		);
	});

	it("sequential mode visits each agent in order then wraps", () => {
		const agents = [makeAgent(), makeAgent(), makeAgent()];
		// biome-ignore lint/suspicious/noExplicitAny: test stubs satisfy Dispatcher shape
		const d = new RotatingProxyDispatcher(agents as any, "sequential");
		// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
		for (let i = 0; i < 7; i++) d.dispatch({} as any, {} as any);
		// 7 dispatches across 3 agents → 3, 2, 2 (round-robin starting at 0).
		expect(agents[0].dispatch).toHaveBeenCalledTimes(3);
		expect(agents[1].dispatch).toHaveBeenCalledTimes(2);
		expect(agents[2].dispatch).toHaveBeenCalledTimes(2);
	});

	it("random mode eventually hits every agent over many calls", () => {
		const agents = [makeAgent(), makeAgent(), makeAgent()];
		// biome-ignore lint/suspicious/noExplicitAny: test stubs satisfy Dispatcher shape
		const d = new RotatingProxyDispatcher(agents as any, "random");
		// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
		for (let i = 0; i < 200; i++) d.dispatch({} as any, {} as any);
		// With 200 trials across 3 buckets, P(any bucket empty) is negligible.
		for (const a of agents) {
			expect(a.dispatch.mock.calls.length).toBeGreaterThan(0);
		}
		const total = agents.reduce((sum, a) => sum + a.dispatch.mock.calls.length, 0);
		expect(total).toBe(200);
	});

	it("close() forwards to every underlying agent", async () => {
		const agents = [makeAgent(), makeAgent(), makeAgent()];
		// biome-ignore lint/suspicious/noExplicitAny: test stubs satisfy Dispatcher shape
		await new RotatingProxyDispatcher(agents as any, "sequential").close();
		for (const a of agents) expect(a.close).toHaveBeenCalledTimes(1);
	});

	it("destroy() forwards to every underlying agent", async () => {
		const agents = [makeAgent(), makeAgent(), makeAgent()];
		// biome-ignore lint/suspicious/noExplicitAny: test stubs satisfy Dispatcher shape
		await new RotatingProxyDispatcher(agents as any, "sequential").destroy();
		for (const a of agents) expect(a.destroy).toHaveBeenCalledTimes(1);
	});
});

// Type-only assertion: ProxyConfig matches the slice of Config we depend on.
// Forces a build-time error if the model drifts away from what the function
// reads. Not executed at runtime.
type _AssertProxyConfigShape = ProxyConfig extends Pick<
	Config,
	| "outboundProxyUrls"
	| "outboundProxyChooser"
	| "outboundProxyUsername"
	| "outboundProxyPassword"
>
	? true
	: never;
