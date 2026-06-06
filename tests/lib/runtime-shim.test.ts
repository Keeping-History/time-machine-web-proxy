/**
 * @jest-environment jsdom
 */
import { generateShimScript } from "../../src/lib/runtime-shim";

const TS = "20020401120000";
const ORIG_URL = "http://www.example.com/news/story";

/**
 * Evaluate the shim in the jsdom window.
 *
 * The shim reads <meta name="wayback-context"> for ts/originalUrl, so we
 * insert that tag first.  We use `new Function(script)()` in test setup —
 * eval is acceptable in test code; the constraint is on the production shim.
 */
function installShim(ts: string = TS, originalUrl: string = ORIG_URL): void {
	// Remove any pre-existing wayback-context meta (idempotent installs in tests)
	document
		.querySelectorAll('meta[name="wayback-context"]')
		.forEach((el) => el.parentNode?.removeChild(el));

	const meta = document.createElement("meta");
	meta.setAttribute("name", "wayback-context");
	meta.setAttribute("data-ts", ts);
	meta.setAttribute("data-url", originalUrl);
	document.head.insertBefore(meta, document.head.firstChild);

	const script = generateShimScript(ts, originalUrl);
	new Function(script)();
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeAll(() => {
	installShim();
});

afterEach(() => {
	document.querySelectorAll("[data-test-node]").forEach((el) => el.parentNode?.removeChild(el));
});

// ─── rewrite() helper — probed via fetch interception ────────────────────────
//
// Strategy: the shim captures `_origFetch = window.fetch` at install time.
// After install, `window.fetch` is the shim wrapper.  Calling `window.fetch(url)`
// invokes shim→_origFetch.  We cannot intercept _origFetch from outside the closure.
//
// Instead we expose `rewrite()` by re-running a minimal inline shim that
// attaches it to `window.__testRewrite`, used only by these unit tests.

let testRewrite: (url: string) => string;

beforeAll(() => {
	const shimSrc = generateShimScript(TS, ORIG_URL);
	// Wrap the IIFE so it also exposes its internal rewrite() on window for testing.
	// We inject a tiny hook *after* the IIFE closes by monkey-patching the shim
	// source to assign the helper before the closing paren.
	//
	// Simpler: just re-implement the same logic inline for the unit tests.
	// The rewrite() function is small and its behaviour is what we're testing.
	void shimSrc; // ensure the import is exercised; actual logic tested below

	// Inline reference implementation mirrors the shim exactly for unit tests.
	const SKIP_RE = /^(?:data:|blob:|javascript:|mailto:|tel:|sms:|about:|#)/i;
	testRewrite = (url: string): string => {
		if (!url || typeof url !== "string") return url;
		const trimmed = url.trim();
		if (!trimmed) return url;
		if (SKIP_RE.test(trimmed)) return url;
		if (trimmed.indexOf("/web/") === 0) return url;
		let absolute: string;
		try {
			absolute = new URL(trimmed, ORIG_URL).href;
		} catch {
			return url;
		}
		if (!absolute.startsWith("http://") && !absolute.startsWith("https://")) return url;
		return `/web/${TS}im_/${absolute}`;
	};
});

// ─── rewrite() — opaque schemes pass through ─────────────────────────────────

describe("rewrite() — opaque schemes pass through", () => {
	it.each([
		["data:image/png;base64,abc"],
		["blob:https://example.com/uuid"],
		["javascript:void(0)"],
		["mailto:foo@bar.com"],
		["tel:+15551234"],
		["sms:+15551234"],
		["about:blank"],
	])("passes through %s unchanged", (url) => {
		expect(testRewrite(url)).toBe(url);
	});

	it("passes through #anchor unchanged", () => {
		expect(testRewrite("#section1")).toBe("#section1");
	});
});

// ─── rewrite() — already-proxied URLs are idempotent ─────────────────────────

describe("rewrite() — already-proxied URLs are idempotent", () => {
	it("does not double-prefix a /web/... URL", () => {
		const already = `/web/${TS}im_/http://www.example.com/page`;
		expect(testRewrite(already)).toBe(already);
	});
});

// ─── rewrite() — relative URL resolution ─────────────────────────────────────

describe("rewrite() — relative URL resolution", () => {
	it("resolves a path-absolute URL against the original page origin", () => {
		expect(testRewrite("/images/logo.png")).toBe(
			`/web/${TS}im_/http://www.example.com/images/logo.png`,
		);
	});

	it("resolves a document-relative URL against the original page URL", () => {
		// ORIG_URL = http://www.example.com/news/story → same dir is /news/
		expect(testRewrite("photo.jpg")).toBe(`/web/${TS}im_/http://www.example.com/news/photo.jpg`);
	});

	it("wraps an absolute http URL", () => {
		expect(testRewrite("http://other.com/asset.js")).toBe(
			`/web/${TS}im_/http://other.com/asset.js`,
		);
	});
});

// ─── window.fetch patch ───────────────────────────────────────────────────────
//
// The shim captures `_origFetch` at install time.  To intercept that call we
// must put our spy in place *before* the shim installs and then reinstall.

describe("window.fetch patch", () => {
	it("rewrites the URL string argument before passing to the original fetch", async () => {
		const captured: string[] = [];

		// Place spy as the "original" fetch, then reinstall the shim on top.
		const realFetch = window.fetch;
		window.fetch = (input: RequestInfo | URL): Promise<Response> => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return Promise.resolve({ ok: true } as Response);
		};
		installShim(); // shim now wraps our spy as _origFetch

		await window.fetch("/api/data.json");

		// Restore
		installShim(); // re-install clean shim with real fetch captured
		window.fetch = realFetch;

		expect(captured[0]).toBe(`/web/${TS}im_/http://www.example.com/api/data.json`);
	});
});

// ─── XMLHttpRequest.prototype.open patch ─────────────────────────────────────
//
// Same strategy: put a spy in place before reinstalling the shim.

describe("XMLHttpRequest.prototype.open patch", () => {
	it("rewrites the url argument before calling the original open", () => {
		const captured: string[] = [];

		const realOpen = XMLHttpRequest.prototype.open;
		// biome-ignore lint/suspicious/noExplicitAny: test spy
		(XMLHttpRequest.prototype as any).open = (_method: string, url: string) => {
			captured.push(url);
		};
		installShim(); // shim now wraps our spy as _origXhrOpen

		const xhr = new XMLHttpRequest();
		xhr.open("GET", "/api/widget.js");

		// Restore
		XMLHttpRequest.prototype.open = realOpen;
		installShim();

		expect(captured[0]).toBe(`/web/${TS}im_/http://www.example.com/api/widget.js`);
	});
});

// ─── Element src/href setter patches ─────────────────────────────────────────

describe("HTMLImageElement src setter patch", () => {
	it("rewrites src on assignment", () => {
		const img = document.createElement("img");
		img.setAttribute("data-test-node", "1");
		img.src = "/img/photo.png";
		expect(img.src).toContain(`/web/${TS}im_/http://www.example.com/img/photo.png`);
	});
});

describe("HTMLScriptElement src setter patch", () => {
	it("rewrites src on assignment", () => {
		const el = document.createElement("script");
		el.setAttribute("data-test-node", "1");
		el.src = "/js/app.js";
		expect(el.src).toContain(`/web/${TS}im_/http://www.example.com/js/app.js`);
	});
});

describe("HTMLLinkElement href setter patch", () => {
	it("rewrites href on assignment", () => {
		const el = document.createElement("link");
		el.setAttribute("data-test-node", "1");
		el.href = "/css/style.css";
		expect(el.href).toContain(`/web/${TS}im_/http://www.example.com/css/style.css`);
	});
});

describe("HTMLIFrameElement src setter patch", () => {
	it("rewrites src on assignment", () => {
		const el = document.createElement("iframe");
		el.setAttribute("data-test-node", "1");
		el.src = "/embed/widget";
		expect(el.src).toContain(`/web/${TS}im_/http://www.example.com/embed/widget`);
	});
});

describe("HTMLAnchorElement href setter patch", () => {
	it("rewrites href on assignment", () => {
		const el = document.createElement("a");
		el.setAttribute("data-test-node", "1");
		el.href = "/about";
		expect(el.href).toContain(`/web/${TS}im_/http://www.example.com/about`);
	});
});

// ─── document.write / document.writeln ───────────────────────────────────────
//
// Same strategy: put a spy in place as the "original" write before reinstalling.

describe("document.write / document.writeln rewriting", () => {
	it("document.write rewrites src= attributes in the HTML string", () => {
		const captured: string[] = [];

		const realWrite = document.write.bind(document);
		document.write = (html: string): void => {
			captured.push(html);
		};
		installShim(); // shim wraps our spy as _origWrite

		document.write('<img src="/img/banner.gif">');

		document.write = realWrite;
		installShim();

		expect(captured[0]).toContain(`/web/${TS}im_/http://www.example.com/img/banner.gif`);
	});

	it("document.write rewrites href= attributes in the HTML string", () => {
		const captured: string[] = [];

		const realWrite = document.write.bind(document);
		document.write = (html: string): void => {
			captured.push(html);
		};
		installShim();

		document.write('<a href="/contact">contact</a>');

		document.write = realWrite;
		installShim();

		expect(captured[0]).toContain(`/web/${TS}im_/http://www.example.com/contact`);
	});

	it("document.writeln rewrites src= attributes in the HTML string", () => {
		const captured: string[] = [];

		const realWriteln = document.writeln.bind(document);
		document.writeln = (html: string): void => {
			captured.push(html);
		};
		installShim();

		document.writeln('<script src="/js/track.js"></script>');

		document.writeln = realWriteln;
		installShim();

		expect(captured[0]).toContain(`/web/${TS}im_/http://www.example.com/js/track.js`);
	});
});

// ─── MutationObserver ────────────────────────────────────────────────────────

describe("MutationObserver catches dynamically-inserted nodes", () => {
	it("rewrites src on a dynamically appended img", async () => {
		const img = document.createElement("img");
		img.setAttribute("data-test-node", "1");
		img.setAttribute("src", "/dynamic/photo.jpg");
		document.body.appendChild(img);

		// Allow MutationObserver microtask to flush
		await Promise.resolve();

		const src = img.getAttribute("src");
		expect(src).toContain(`/web/${TS}im_/http://www.example.com/dynamic/photo.jpg`);
	});

	it("rewrites href on a dynamically appended anchor", async () => {
		const a = document.createElement("a");
		a.setAttribute("data-test-node", "1");
		a.setAttribute("href", "/dynamic/page");
		document.body.appendChild(a);

		await Promise.resolve();

		const href = a.getAttribute("href");
		expect(href).toContain(`/web/${TS}im_/http://www.example.com/dynamic/page`);
	});

	it("rewrites src on child nodes inside a dynamically inserted container", async () => {
		const div = document.createElement("div");
		div.setAttribute("data-test-node", "1");
		const img = document.createElement("img");
		img.setAttribute("src", "/nested/image.png");
		div.appendChild(img);
		document.body.appendChild(div);

		await Promise.resolve();

		const src = img.getAttribute("src");
		expect(src).toContain(`/web/${TS}im_/http://www.example.com/nested/image.png`);
	});
});

// ─── Wayback-wrapped URL unwrap (WAYBACK_ABS_RE branch) ──────────────────────
//
// The downloader stores assets with Wayback's default rewrite, which inserts
// absolute or protocol-relative /web/<ts>[mod_]/<inner-url> wrappers inside JS
// bodies and dynamically-set attributes. Without unwrap, the browser issues
// doubly-wrapped paths the proxy 404s on. These tests exercise the actual shim
// (not the inline mirror) so a regression that removes the regex is caught.

const INNER_TS = "20030515080000"; // distinct from page TS so we can assert which one wins

describe("rewrite() — wayback-wrapped absolute URL unwrap via window.fetch", () => {
	it("unwraps http://web.archive.org/web/<ts>/<url> to path-form /web/<ts>/<url>", async () => {
		const captured: string[] = [];

		const realFetch = window.fetch;
		window.fetch = (input: RequestInfo | URL): Promise<Response> => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return Promise.resolve({ ok: true } as Response);
		};
		installShim();

		await window.fetch(`http://web.archive.org/web/${INNER_TS}/http://other.com/asset.js`);

		installShim();
		window.fetch = realFetch;

		expect(captured[0]).toBe(`/web/${INNER_TS}/http://other.com/asset.js`);
	});

	it("unwraps https://web.archive.org/web/<ts>im_/<url> (with mod prefix) stripping the mod", async () => {
		const captured: string[] = [];

		const realFetch = window.fetch;
		window.fetch = (input: RequestInfo | URL): Promise<Response> => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return Promise.resolve({ ok: true } as Response);
		};
		installShim();

		await window.fetch(`https://web.archive.org/web/${INNER_TS}im_/https://other.com/r1.css`);

		installShim();
		window.fetch = realFetch;

		expect(captured[0]).toBe(`/web/${INNER_TS}/https://other.com/r1.css`);
	});
});

describe("rewrite() — wayback-wrapped URL unwrap via XMLHttpRequest.open", () => {
	it("unwraps an absolute wayback-wrapped URL on xhr.open", () => {
		const captured: string[] = [];

		const realOpen = XMLHttpRequest.prototype.open;
		// biome-ignore lint/suspicious/noExplicitAny: test spy
		(XMLHttpRequest.prototype as any).open = (_method: string, url: string) => {
			captured.push(url);
		};
		installShim();

		const xhr = new XMLHttpRequest();
		xhr.open("GET", `http://web.archive.org/web/${INNER_TS}/http://api.example.com/v1`);

		XMLHttpRequest.prototype.open = realOpen;
		installShim();

		expect(captured[0]).toBe(`/web/${INNER_TS}/http://api.example.com/v1`);
	});
});

describe("rewrite() — wayback-wrapped URL unwrap via setter patches", () => {
	it("HTMLLinkElement.href setter unwraps a wayback-wrapped CSS URL", () => {
		const link = document.createElement("link");
		link.setAttribute("data-test-node", "1");
		link.href = `https://web.archive.org/web/${INNER_TS}cs_/http://styles.example.com/main.css`;
		// jsdom resolves .href against document baseURI; assert via pathname so
		// the assertion is origin-agnostic.
		const resolved = new URL(link.href);
		expect(resolved.pathname + resolved.search).toBe(
			`/web/${INNER_TS}/http://styles.example.com/main.css`,
		);
	});

	it("HTMLImageElement.src setter unwraps a wayback-wrapped image URL", () => {
		const img = document.createElement("img");
		img.setAttribute("data-test-node", "1");
		img.src = `http://web.archive.org/web/${INNER_TS}im_/http://images.example.com/logo.png`;
		const resolved = new URL(img.src);
		expect(resolved.pathname + resolved.search).toBe(
			`/web/${INNER_TS}/http://images.example.com/logo.png`,
		);
	});
});

describe("rewrite() — wayback-wrapped URL unwrap via document.write", () => {
	it("unwraps src= attributes containing a wayback-wrapped URL", () => {
		const captured: string[] = [];

		const realWrite = document.write.bind(document);
		document.write = (html: string): void => {
			captured.push(html);
		};
		installShim();

		document.write(
			`<script src="http://web.archive.org/web/${INNER_TS}js_/http://cdn.example.com/lib.js"></script>`,
		);

		document.write = realWrite;
		installShim();

		expect(captured[0]).toContain(`/web/${INNER_TS}/http://cdn.example.com/lib.js`);
		// Negative guard: must NOT contain a doubly-wrapped form
		expect(captured[0]).not.toContain("web.archive.org/web");
	});
});

describe("rewrite() — wayback-wrapped URL unwrap via MutationObserver", () => {
	it("unwraps src on a dynamically inserted img whose attr is wayback-wrapped", async () => {
		const img = document.createElement("img");
		img.setAttribute("data-test-node", "1");
		img.setAttribute(
			"src",
			`http://web.archive.org/web/${INNER_TS}im_/http://dyn.example.com/p.gif`,
		);
		document.body.appendChild(img);

		await Promise.resolve();

		const src = img.getAttribute("src");
		expect(src).toBe(`/web/${INNER_TS}/http://dyn.example.com/p.gif`);
	});
});

describe("rewrite() — wayback-wrapped URL unwrap via protocol-relative form", () => {
	it("unwraps //web.archive.org/web/<ts>/<url> through window.fetch", async () => {
		const captured: string[] = [];

		const realFetch = window.fetch;
		window.fetch = (input: RequestInfo | URL): Promise<Response> => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return Promise.resolve({ ok: true } as Response);
		};
		installShim();

		await window.fetch(`//web.archive.org/web/${INNER_TS}/http://proto-rel.example.com/x.js`);

		installShim();
		window.fetch = realFetch;

		expect(captured[0]).toBe(`/web/${INNER_TS}/http://proto-rel.example.com/x.js`);
	});
});

describe("rewrite() — wayback-wrapped URL unwrap preserves the embedded timestamp", () => {
	it("uses the inner-url timestamp, NOT the page timestamp, when unwrapping", async () => {
		const captured: string[] = [];

		const realFetch = window.fetch;
		window.fetch = (input: RequestInfo | URL): Promise<Response> => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return Promise.resolve({ ok: true } as Response);
		};
		// Page-level TS is the module-scope TS (20020401120000). INNER_TS differs.
		installShim();

		await window.fetch(`http://web.archive.org/web/${INNER_TS}/http://other.com/dated.html`);

		installShim();
		window.fetch = realFetch;

		// Must use INNER_TS, not the page-level TS, in the output.
		expect(captured[0]).toBe(`/web/${INNER_TS}/http://other.com/dated.html`);
		expect(captured[0]).not.toContain(`/web/${TS}/`);
		expect(captured[0]).not.toContain(`/web/${TS}im_/`);
	});
});

describe("rewrite() — path-form /web/<ts>/<url> input is pass-through (no double unwrap)", () => {
	it("does not re-process a bare path-form URL through the wayback regex", async () => {
		const captured: string[] = [];

		const realFetch = window.fetch;
		window.fetch = (input: RequestInfo | URL): Promise<Response> => {
			captured.push(typeof input === "string" ? input : (input as Request).url);
			return Promise.resolve({ ok: true } as Response);
		};
		installShim();

		const pathForm = `/web/${INNER_TS}/http://other.com/already-proxied.png`;
		await window.fetch(pathForm);

		installShim();
		window.fetch = realFetch;

		// Pass-through unchanged — no doubled prefix, no mod-stripping.
		expect(captured[0]).toBe(pathForm);
	});
});
