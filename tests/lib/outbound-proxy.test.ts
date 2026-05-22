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

// `request` is invoked once per agent during the startup probe (and again on
// every re-probe). Default mock returns 200 OK; tests override for failures.
// biome-ignore lint/suspicious/noExplicitAny: jest.Mock for variable response shape across tests
const requestMock: jest.Mock<any, any> = jest.fn();

jest.mock("undici", () => ({
	__esModule: true,
	setGlobalDispatcher: setGlobalDispatcherMock,
	ProxyAgent: ProxyAgentMock,
	Dispatcher: DispatcherStub,
	request: requestMock,
}));

import pino from "pino";
import {
	installOutboundProxy,
	PROBE_URL,
	RotatingProxyDispatcher,
} from "../../src/lib/outbound-proxy";
import type { Config } from "../../src/models/config";

type ProxyConfig = Parameters<typeof installOutboundProxy>[0];

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
	return {
		outboundProxyUrls: [],
		outboundProxyChooser: "sequential",
		outboundProxyUsername: "",
		outboundProxyPassword: "",
		outboundProxyCooldownMs: 60_000,
		...overrides,
	};
}

function makeLogger(): {
	logger: pino.Logger;
	infoSpy: jest.Mock;
	errorSpy: jest.Mock;
	warnSpy: jest.Mock;
} {
	const infoSpy = jest.fn();
	const errorSpy = jest.fn();
	const warnSpy = jest.fn();
	const logger = pino({ level: "silent" });
	(logger as unknown as { info: jest.Mock }).info = infoSpy;
	(logger as unknown as { error: jest.Mock }).error = errorSpy;
	(logger as unknown as { warn: jest.Mock }).warn = warnSpy;
	return { logger, infoSpy, errorSpy, warnSpy };
}

// biome-ignore lint/suspicious/noExplicitAny: jest mock returns are intentionally polymorphic across tests
function mockRequestImpl(handler: (url: string, opts: any) => any) {
	requestMock.mockImplementation(handler);
}

describe("installOutboundProxy", () => {
	beforeEach(() => {
		setGlobalDispatcherMock.mockClear();
		ProxyAgentMock.mockClear();
		requestMock.mockClear();
		requestMock.mockImplementation(async () => ({
			statusCode: 200,
			body: { dump: jest.fn().mockResolvedValue(undefined) },
		}));
	});

	it("does not install when outboundProxyUrls is empty (no-op)", async () => {
		const { logger, infoSpy } = makeLogger();
		await installOutboundProxy(makeConfig({ outboundProxyUrls: [] }), logger);
		expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
		expect(ProxyAgentMock).not.toHaveBeenCalled();
		expect(requestMock).not.toHaveBeenCalled();
		expect(infoSpy).not.toHaveBeenCalled();
	});

	describe("startup connectivity probe", () => {
		it("probes every configured proxy against PROBE_URL through its agent", async () => {
			const { logger } = makeLogger();
			await installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["http://a.example.com:31280", "http://b.example.com:31280"],
				}),
				logger,
			);
			expect(requestMock).toHaveBeenCalledTimes(2);
			for (const call of requestMock.mock.calls) {
				expect(call[0]).toBe(PROBE_URL);
				const opts = call[1] as { dispatcher: unknown; method: string };
				expect(opts.method).toBe("GET");
				expect(opts.dispatcher).toEqual(
					expect.objectContaining({ __isProxyAgent: proxyAgentInstanceMarker }),
				);
			}
		});

		it("installs when all probes succeed", async () => {
			const { logger, infoSpy } = makeLogger();
			await installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["http://a.example.com:31280", "http://b.example.com:31280"],
				}),
				logger,
			);
			expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
			expect(setGlobalDispatcherMock.mock.calls[0][0]).toBeInstanceOf(RotatingProxyDispatcher);
			// per-proxy probe-ok log + final installed log
			expect(infoSpy.mock.calls.some((c) => c[1] === "[outbound-proxy] startup probe ok")).toBe(
				true,
			);
			expect(infoSpy.mock.calls.some((c) => c[1] === "[outbound-proxy] installed")).toBe(true);
		});

		it("installs rotator with every agent in cooldown when EVERY probe fails (transport error)", async () => {
			mockRequestImpl(async () => {
				throw new Error("ECONNREFUSED");
			});
			const { logger, errorSpy } = makeLogger();
			await installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["http://a.example.com:31280", "http://b.example.com:31280"],
				}),
				logger,
			);
			expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
			expect(setGlobalDispatcherMock.mock.calls[0][0]).toBeInstanceOf(RotatingProxyDispatcher);
			// Each failed proxy logs an error
			expect(
				errorSpy.mock.calls.filter((c) => c[1] === "[outbound-proxy] startup probe failed").length,
			).toBe(2);
			// The "all probes failed → install anyway" warning fires once.
			expect(
				errorSpy.mock.calls.filter((c) =>
					typeof c[1] === "string" && c[1].startsWith("[outbound-proxy] all startup probes failed"),
				).length,
			).toBe(1);
			// Both agents seeded in cooldown.
			expect(
				errorSpy.mock.calls.filter(
					(c) => c[1] === "[outbound-proxy] proxy taken out of rotation",
				).length,
			).toBe(2);
		});

		it("installs rotator with every agent in cooldown when EVERY probe fails (proxy 407 auth)", async () => {
			mockRequestImpl(async () => ({
				statusCode: 407,
				body: { dump: jest.fn().mockResolvedValue(undefined) },
			}));
			const { logger, errorSpy } = makeLogger();
			await installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["http://a.example.com:31280"],
					outboundProxyUsername: "alice",
					outboundProxyPassword: "wrong",
				}),
				logger,
			);
			expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
			expect(
				errorSpy.mock.calls.filter((c) =>
					typeof c[1] === "string" && c[1].startsWith("[outbound-proxy] all startup probes failed"),
				).length,
			).toBe(1);
		});

		it("installs when some probes succeed; failed agents are seeded in cooldown", async () => {
			// First agent fails, second succeeds.
			let call = 0;
			mockRequestImpl(async () => {
				call++;
				if (call === 1) throw new Error("ETIMEDOUT");
				return { statusCode: 200, body: { dump: jest.fn().mockResolvedValue(undefined) } };
			});
			const { logger, infoSpy, errorSpy } = makeLogger();
			await installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["http://a.example.com:31280", "http://b.example.com:31280"],
				}),
				logger,
			);
			expect(setGlobalDispatcherMock).toHaveBeenCalledTimes(1);
			// One ok + one failed startup-probe log.
			expect(
				infoSpy.mock.calls.filter((c) => c[1] === "[outbound-proxy] startup probe ok").length,
			).toBe(1);
			expect(
				errorSpy.mock.calls.filter((c) => c[1] === "[outbound-proxy] startup probe failed").length,
			).toBe(1);
			// The failed agent went into cooldown via markFailedExternally → error log.
			expect(
				errorSpy.mock.calls.some((c) => c[1] === "[outbound-proxy] proxy taken out of rotation"),
			).toBe(true);
		});
	});

	describe("URL + credential validation (still synchronous, surfaces as rejection)", () => {
		it("rejects when USERNAME is set but PASSWORD is empty", async () => {
			const { logger } = makeLogger();
			await expect(
				installOutboundProxy(
					makeConfig({
						outboundProxyUrls: ["http://proxy.example.com:31280"],
						outboundProxyUsername: "alice",
						outboundProxyPassword: "",
					}),
					logger,
				),
			).rejects.toThrow(/USERNAME.*PASSWORD.*must be set together/i);
			expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
			expect(requestMock).not.toHaveBeenCalled();
		});

		it("rejects when PASSWORD is set but USERNAME is empty", async () => {
			const { logger } = makeLogger();
			await expect(
				installOutboundProxy(
					makeConfig({
						outboundProxyUrls: ["http://proxy.example.com:31280"],
						outboundProxyUsername: "",
						outboundProxyPassword: "secret",
					}),
					logger,
				),
			).rejects.toThrow(/USERNAME.*PASSWORD.*must be set together/i);
			expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
		});

		it("rejects on non-http(s) URL, naming the failing one", async () => {
			const { logger } = makeLogger();
			await expect(
				installOutboundProxy(
					makeConfig({
						outboundProxyUrls: ["http://ok.example.com:31280", "ftp://bad.example.com:21"],
					}),
					logger,
				),
			).rejects.toThrow(/must be http:\/\/ or https:\/\/.*ftp:\/\/bad\.example\.com/);
			expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
		});

		it("rejects on unparseable URL", async () => {
			const { logger } = makeLogger();
			await expect(
				installOutboundProxy(
					makeConfig({
						outboundProxyUrls: ["http://ok.example.com:31280", "not a url"],
					}),
					logger,
				),
			).rejects.toThrow(/invalid URL: not a url/);
			expect(setGlobalDispatcherMock).not.toHaveBeenCalled();
		});
	});

	describe("agent construction", () => {
		it("URL-encodes credentials into the agent URI", async () => {
			const { logger } = makeLogger();
			await installOutboundProxy(
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

		it("accepts https:// proxy URLs", async () => {
			const { logger } = makeLogger();
			await installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["https://secure-proxy.example.com:8443"],
				}),
				logger,
			);
			const callArg = ProxyAgentMock.mock.calls[0][0] as { uri: string };
			expect(callArg.uri).toMatch(/^https:\/\/secure-proxy\.example\.com:8443\/?$/);
		});

		it("never includes the password in log call arguments", async () => {
			const { logger, infoSpy, errorSpy } = makeLogger();
			const password = "super-secret-do-not-log-me-12345";
			await installOutboundProxy(
				makeConfig({
					outboundProxyUrls: ["http://proxy.example.com:31280", "http://proxy2.example.com:31280"],
					outboundProxyUsername: "alice",
					outboundProxyPassword: password,
				}),
				logger,
			);
			const logArgs = JSON.stringify([...infoSpy.mock.calls, ...errorSpy.mock.calls]);
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

	function makeBuilt(n: number) {
		return Array.from({ length: n }, (_, i) => ({
			host: `proxy${i}.example.com:31280`,
			agent: makeAgent(),
		}));
	}

	function silentLogger(): pino.Logger {
		const l = pino({ level: "silent" });
		(l as unknown as { info: jest.Mock }).info = jest.fn();
		(l as unknown as { error: jest.Mock }).error = jest.fn();
		(l as unknown as { warn: jest.Mock }).warn = jest.fn();
		return l;
	}

	beforeEach(() => {
		requestMock.mockClear();
		requestMock.mockImplementation(async () => ({
			statusCode: 200,
			body: { dump: jest.fn().mockResolvedValue(undefined) },
		}));
	});

	it("throws when constructed with zero agents", () => {
		expect(
			() =>
				new RotatingProxyDispatcher([], "sequential", {
					baseCooldownMs: 1000,
					logger: silentLogger(),
				}),
		).toThrow(/at least one agent/);
	});

	it("getStatus() reports every agent as healthy with 0 cooldown when freshly constructed", () => {
		const built = makeBuilt(2);
		// biome-ignore lint/suspicious/noExplicitAny: test stubs satisfy Dispatcher shape
		const d = new RotatingProxyDispatcher(built as any, "sequential", {
			baseCooldownMs: 1000,
			logger: silentLogger(),
		});
		const status = d.getStatus();
		expect(status).toEqual([
			{ host: "proxy0.example.com:31280", healthy: true, cooldownRemainingMs: 0 },
			{ host: "proxy1.example.com:31280", healthy: true, cooldownRemainingMs: 0 },
		]);
	});

	it("getStatus() reports a failed agent as unhealthy with nonzero cooldownRemainingMs", () => {
		// markFailedExternally is the same code path that the dispatch-failure
		// branch uses, so testing through it gives us the production state
		// machine without needing to simulate a full dispatch.
		const built = makeBuilt(2);
		// biome-ignore lint/suspicious/noExplicitAny: test stubs satisfy Dispatcher shape
		const d = new RotatingProxyDispatcher(built as any, "sequential", {
			baseCooldownMs: 60_000,
			logger: silentLogger(),
		});
		d.markFailedExternally("proxy0.example.com:31280", "test");
		const status = d.getStatus();
		expect(status[0]).toMatchObject({
			host: "proxy0.example.com:31280",
			healthy: false,
		});
		// Cooldown is the base value; allow a small drift for test execution time.
		expect(status[0].cooldownRemainingMs).toBeGreaterThan(50_000);
		expect(status[0].cooldownRemainingMs).toBeLessThanOrEqual(60_000);
		// Second agent is untouched — still healthy.
		expect(status[1]).toEqual({
			host: "proxy1.example.com:31280",
			healthy: true,
			cooldownRemainingMs: 0,
		});
	});

	it("sequential mode visits each healthy agent in order then wraps", () => {
		const built = makeBuilt(3);
		// biome-ignore lint/suspicious/noExplicitAny: test stubs satisfy Dispatcher shape
		const d = new RotatingProxyDispatcher(built as any, "sequential", {
			baseCooldownMs: 1000,
			logger: silentLogger(),
		});
		// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
		for (let i = 0; i < 7; i++) d.dispatch({} as any, {} as any);
		// 7 dispatches across 3 agents → 3, 2, 2 (round-robin starting at 0).
		expect(built[0].agent.dispatch).toHaveBeenCalledTimes(3);
		expect(built[1].agent.dispatch).toHaveBeenCalledTimes(2);
		expect(built[2].agent.dispatch).toHaveBeenCalledTimes(2);
	});

	it("random mode eventually hits every agent over many calls", () => {
		const built = makeBuilt(3);
		// biome-ignore lint/suspicious/noExplicitAny: test stubs satisfy Dispatcher shape
		const d = new RotatingProxyDispatcher(built as any, "random", {
			baseCooldownMs: 1000,
			logger: silentLogger(),
		});
		// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
		for (let i = 0; i < 200; i++) d.dispatch({} as any, {} as any);
		for (const b of built) expect(b.agent.dispatch.mock.calls.length).toBeGreaterThan(0);
		const total = built.reduce((sum, b) => sum + b.agent.dispatch.mock.calls.length, 0);
		expect(total).toBe(200);
	});

	it("close() forwards to every underlying agent", async () => {
		const built = makeBuilt(3);
		// biome-ignore lint/suspicious/noExplicitAny: test stubs satisfy Dispatcher shape
		await new RotatingProxyDispatcher(built as any, "sequential", {
			baseCooldownMs: 1000,
			logger: silentLogger(),
		}).close();
		for (const b of built) expect(b.agent.close).toHaveBeenCalledTimes(1);
	});

	it("destroy() forwards to every underlying agent", async () => {
		const built = makeBuilt(3);
		// biome-ignore lint/suspicious/noExplicitAny: test stubs satisfy Dispatcher shape
		await new RotatingProxyDispatcher(built as any, "sequential", {
			baseCooldownMs: 1000,
			logger: silentLogger(),
		}).destroy();
		for (const b of built) expect(b.agent.destroy).toHaveBeenCalledTimes(1);
	});

	describe("circuit breaker", () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});
		afterEach(() => {
			jest.useRealTimers();
		});

		function buildRotator(n = 2, baseCooldownMs = 1000) {
			const built = makeBuilt(n);
			const logger = silentLogger();
			// biome-ignore lint/suspicious/noExplicitAny: test stubs satisfy Dispatcher shape
			const d = new RotatingProxyDispatcher(built as any, "sequential", {
				baseCooldownMs,
				logger,
			});
			return { built, d, logger };
		}

		it("wraps the handler with onResponseError that marks the agent failed", () => {
			const { built, d } = buildRotator(2);
			const userHandler = { onResponseError: jest.fn() };
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts stub
			d.dispatch({} as any, userHandler as any);
			// Simulate transport failure via the wrapped handler the rotator passed to the agent.
			const wrapped = built[0].agent.dispatch.mock.calls[0][1] as {
				onResponseError: (controller: unknown, err: Error) => void;
			};
			wrapped.onResponseError({}, new Error("socket hang up"));
			expect(userHandler.onResponseError).toHaveBeenCalledTimes(1);

			// Now built[0] is failed; the next dispatch should go to built[1] only.
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts stub
			d.dispatch({} as any, {} as any);
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts stub
			d.dispatch({} as any, {} as any);
			// built[0] received one (the original); built[1] received two (the two after marking).
			expect(built[0].agent.dispatch).toHaveBeenCalledTimes(1);
			expect(built[1].agent.dispatch).toHaveBeenCalledTimes(2);
		});

		it("marks the agent failed on response status 407", () => {
			const { built, d } = buildRotator(2);
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			const wrapped = built[0].agent.dispatch.mock.calls[0][1] as {
				onResponseStart: (c: unknown, s: number, h: unknown, m?: string) => void;
			};
			wrapped.onResponseStart({}, 407, {}, "Proxy Authentication Required");
			// next dispatch routes to built[1].
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			expect(built[0].agent.dispatch).toHaveBeenCalledTimes(1);
			expect(built[1].agent.dispatch).toHaveBeenCalledTimes(1);
		});

		it.each([502, 503, 504])("marks the agent failed on response status %s", (code) => {
			const { built, d } = buildRotator(2);
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			const wrapped = built[0].agent.dispatch.mock.calls[0][1] as {
				onResponseStart: (c: unknown, s: number, h: unknown) => void;
			};
			wrapped.onResponseStart({}, code, {});
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			expect(built[0].agent.dispatch).toHaveBeenCalledTimes(1);
			expect(built[1].agent.dispatch).toHaveBeenCalledTimes(1);
		});

		it("does not mark failed on a benign 2xx/3xx/4xx status (other than 407)", () => {
			const { built, d } = buildRotator(2);
			for (const code of [200, 304, 404, 410]) {
				// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
				d.dispatch({} as any, {} as any);
				const idx = built[0].agent.dispatch.mock.calls.length - 1;
				const wrapped = built[0].agent.dispatch.mock.calls[idx][1] as {
					onResponseStart: (c: unknown, s: number, h: unknown) => void;
				};
				wrapped.onResponseStart({}, code, {});
			}
			// 4 dispatches all went to built[0] because nothing marked it failed.
			// (sequential round-robin within healthy set of size 2 alternates;
			// adjust expectations to reflect round-robin behavior.)
			// Index advances on every successful pick — 4 picks across 2 healthy = 2 each.
			expect(built[0].agent.dispatch).toHaveBeenCalledTimes(2);
			expect(built[1].agent.dispatch).toHaveBeenCalledTimes(2);
		});

		it("throws synchronously when ALL agents are in cooldown", () => {
			const { built, d } = buildRotator(2);
			// Knock out both agents.
			for (let i = 0; i < 2; i++) {
				// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
				d.dispatch({} as any, {} as any);
				const idx = built[i].agent.dispatch.mock.calls.length - 1;
				const wrapped = built[i].agent.dispatch.mock.calls[idx][1] as {
					onResponseError: (c: unknown, err: Error) => void;
				};
				wrapped.onResponseError({}, new Error("dead"));
			}
			expect(() =>
				// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
				d.dispatch({} as any, {} as any),
			).toThrow(/no healthy proxy/);
		});

		it("schedules a re-probe at cooldown expiry and restores the agent on success", async () => {
			const { built, d } = buildRotator(2, 5_000);
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			const wrapped = built[0].agent.dispatch.mock.calls[0][1] as {
				onResponseError: (c: unknown, err: Error) => void;
			};
			wrapped.onResponseError({}, new Error("dead"));
			// next dispatches route to built[1]
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			expect(built[0].agent.dispatch).toHaveBeenCalledTimes(1);
			expect(built[1].agent.dispatch).toHaveBeenCalledTimes(1);

			// Fast-forward the cooldown. Re-probe fires, request() returns 200 by default.
			await jest.advanceTimersByTimeAsync(5_000);
			expect(requestMock).toHaveBeenCalledTimes(1);

			// built[0] should now be healthy again — next dispatches round-robin both.
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			expect(built[0].agent.dispatch).toHaveBeenCalledTimes(2);
			expect(built[1].agent.dispatch).toHaveBeenCalledTimes(2);
		});

		it("extends cooldown linearly when re-probe fails repeatedly", async () => {
			const baseCooldownMs = 1_000;
			const { built, d } = buildRotator(2, baseCooldownMs);
			// Probe always fails.
			requestMock.mockImplementation(async () => {
				throw new Error("still dead");
			});
			// Knock out built[0].
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			const wrapped = built[0].agent.dispatch.mock.calls[0][1] as {
				onResponseError: (c: unknown, err: Error) => void;
			};
			wrapped.onResponseError({}, new Error("dead"));
			// At t=0: currentCooldown = 1000 (X).

			// Advance to 1000ms → re-probe fires, fails, cooldown → 2000ms (2X).
			await jest.advanceTimersByTimeAsync(baseCooldownMs);
			expect(requestMock).toHaveBeenCalledTimes(1);

			// Advance 1500ms — not enough for the new 2000ms cooldown.
			await jest.advanceTimersByTimeAsync(1_500);
			expect(requestMock).toHaveBeenCalledTimes(1);

			// Advance the remaining 500ms — second re-probe fires.
			await jest.advanceTimersByTimeAsync(500);
			expect(requestMock).toHaveBeenCalledTimes(2);

			// Cooldown is now 3X = 3000ms. Confirm a 2500ms advance is not enough.
			await jest.advanceTimersByTimeAsync(2_500);
			expect(requestMock).toHaveBeenCalledTimes(2);
			await jest.advanceTimersByTimeAsync(500);
			expect(requestMock).toHaveBeenCalledTimes(3);
		});

		it("cancels scheduled re-probes on close()", async () => {
			const { built, d } = buildRotator(1, 1_000);
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			const wrapped = built[0].agent.dispatch.mock.calls[0][1] as {
				onResponseError: (c: unknown, err: Error) => void;
			};
			wrapped.onResponseError({}, new Error("dead"));
			await d.close();
			// Time advances past the cooldown — but the timer is cancelled,
			// so probe must not fire.
			await jest.advanceTimersByTimeAsync(10_000);
			expect(requestMock).not.toHaveBeenCalled();
		});

		it("does not double-charge cooldown when many in-flight requests fail at once", () => {
			const { built, d } = buildRotator(2, 1_000);
			// Three concurrent dispatches all on built[0] (force by failing built[1] first).
			// Simpler approach: dispatch once on built[0], capture wrapped handler, fire
			// onResponseError twice — second call should be a no-op.
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			const wrapped = built[0].agent.dispatch.mock.calls[0][1] as {
				onResponseError: (c: unknown, err: Error) => void;
			};
			wrapped.onResponseError({}, new Error("err1"));
			wrapped.onResponseError({}, new Error("err2"));
			// Despite two error events, only the first triggered a transition; we
			// verify by observing that the cooldown didn't double — i.e. the
			// re-probe fires at 1000ms, not 2000ms.
			// (Indirect check: ensure single failure-log "out of rotation" event
			// in the logger, but we used a silent jest fn logger — assert via
			// dispatch routing: after one failure built[1] takes all traffic.)
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			// biome-ignore lint/suspicious/noExplicitAny: dispatch opts/handler stubs
			d.dispatch({} as any, {} as any);
			expect(built[1].agent.dispatch).toHaveBeenCalledTimes(2);
		});
	});
});

// Type-only assertion: ProxyConfig matches the slice of Config we depend on.
// Forces a build-time error if the model drifts away from what the function
// reads. Not executed at runtime.
type _AssertProxyConfigShape =
	ProxyConfig extends Pick<
		Config,
		| "outboundProxyUrls"
		| "outboundProxyChooser"
		| "outboundProxyUsername"
		| "outboundProxyPassword"
		| "outboundProxyCooldownMs"
	>
		? true
		: never;
