import { type HTMLElement, parse } from "node-html-parser";

// Schemes that must NEVER be proxied — data URIs, mail links, JS pseudo-URLs,
// dial/SMS handlers, opaque protocols. The list is conservative; anything not
// matched falls through to the http(s) check inside toProxyUrl.
const NON_PROXYABLE_SCHEME_RE =
	/^(data|mailto|javascript|tel|sms|blob|about|file|ftp|geo|ws|wss|magnet|view-source|chrome|safari-extension):/i;

// Wayback URLs look like `https://web.archive.org/web/<timestamp>[flags]/<original>`.
// The downloader runs in `rewrite_mode: "as-is"`, but the saved HTML can still
// contain Wayback URLs in places the downloader didn't touch — unwrap them so
// the proxy target is always the ORIGINAL URL with the user's requested time.
const WAYBACK_PREFIX_RE =
	/^https?:\/\/web\.archive\.org\/web\/\d{1,14}(?:[^/]*)?\/(https?:\/\/.+)$/i;

export const sanitizeTimeParam = (rawTime: string | null, defaultTime: string): string => {
	if (!rawTime) return defaultTime;
	if (/^\d{14}$/.test(rawTime)) return rawTime;
	throw new Error("Invalid time parameter");
};

export const unwrapNestedProxyUrl = (
	url: string,
	fallbackTime: string,
	proxyBaseHostname: string,
): { url: string; time: string } => {
	try {
		const nested = new URL(url);
		if (nested.hostname === proxyBaseHostname && nested.searchParams.has("url")) {
			const inner = nested.searchParams.get("url");
			if (inner) {
				const innerTime = nested.searchParams.get("time");
				return {
					url: inner,
					time: innerTime && /^\d{14}$/.test(innerTime) ? innerTime : fallbackTime,
				};
			}
		}
	} catch {
		/* not a valid absolute URL — use as-is */
	}
	return { url, time: fallbackTime };
};

/**
 * Build a proxy URL from a raw reference encountered in archived HTML/CSS.
 * Returns null for non-proxyable refs (data:, mailto:, javascript:, tel:,
 * fragments, non-http(s) URLs). Resolves relative refs against `pageUrl`.
 * Unwraps any Wayback prefix so the proxy target is always the ORIGINAL URL.
 */
function toProxyUrl(
	ref: string | undefined | null,
	pageUrl: string,
	proxyBase: string,
	time: string,
): string | null {
	if (!ref) return null;
	const trimmed = ref.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#")) return null;
	if (NON_PROXYABLE_SCHEME_RE.test(trimmed)) return null;
	let resolved: URL;
	try {
		resolved = new URL(trimmed, pageUrl);
	} catch {
		return null;
	}
	if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
	let target = resolved.href;
	const wb = target.match(WAYBACK_PREFIX_RE);
	if (wb) target = wb[1];
	return `${proxyBase}/?url=${encodeURIComponent(target)}&time=${time}`;
}

// HTML attributes by tag that carry URLs. We intentionally exclude <base>:
// the rewriter strips it entirely (rewritten URLs are absolute proxy URLs,
// and a stray base href would send any unrewritten refs to the live web).
const URL_ATTRS_BY_TAG: ReadonlyMap<string, readonly string[]> = new Map([
	["a", ["href"]],
	["area", ["href"]],
	["link", ["href"]],
	["img", ["src", "longdesc"]],
	["iframe", ["src", "longdesc"]],
	["frame", ["src", "longdesc"]],
	["embed", ["src"]],
	["input", ["src", "formaction"]],
	["button", ["formaction"]],
	["track", ["src"]],
	["video", ["src", "poster"]],
	["audio", ["src"]],
	["source", ["src"]],
	["script", ["src"]],
	["object", ["data"]],
	["form", ["action"]],
	["blockquote", ["cite"]],
	["q", ["cite"]],
	["del", ["cite"]],
	["ins", ["cite"]],
	["html", ["manifest"]],
	["body", ["background"]],
	["table", ["background"]],
	["td", ["background"]],
	["th", ["background"]],
	["tr", ["background"]],
]);

const SRCSET_TAGS = ["img", "source"] as const;

function rewriteSrcset(value: string, pageUrl: string, proxyBase: string, time: string): string {
	return value
		.split(",")
		.map((entry) => {
			const trimmed = entry.trim();
			if (!trimmed) return entry;
			const space = trimmed.search(/\s/);
			const url = space === -1 ? trimmed : trimmed.slice(0, space);
			const descriptor = space === -1 ? "" : trimmed.slice(space);
			const proxied = toProxyUrl(url, pageUrl, proxyBase, time);
			return proxied ? `${proxied}${descriptor}` : entry;
		})
		.join(", ");
}

// `<meta http-equiv="refresh" content="<delay>;url=<url>">`. The URL portion
// may be absent (refresh same page) — return unchanged then. Case-insensitive
// on the `url=` separator; tolerates surrounding single/double quotes.
const META_REFRESH_RE = /^(\s*\d+\s*;\s*url\s*=\s*)(.+?)\s*$/i;

function rewriteMetaRefresh(
	content: string,
	pageUrl: string,
	proxyBase: string,
	time: string,
): string {
	const m = content.match(META_REFRESH_RE);
	if (!m) return content;
	const prefix = m[1];
	let url = m[2];
	let quote = "";
	if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
		quote = url[0];
		url = url.slice(1, -1);
	}
	const proxied = toProxyUrl(url, pageUrl, proxyBase, time);
	if (!proxied) return content;
	return `${prefix}${quote}${proxied}${quote}`;
}

// CSS `url(...)` — handles quoted (single/double) and unquoted forms.
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi;

export function rewriteCssUrls(
	css: string,
	pageUrl: string,
	proxyBase: string,
	time: string,
): string {
	return css.replace(CSS_URL_RE, (match, quote, raw) => {
		const proxied = toProxyUrl(raw, pageUrl, proxyBase, time);
		if (!proxied) return match;
		return `url(${quote}${proxied}${quote})`;
	});
}

/**
 * Rewrite every URL reference in `html` to point at the TimeMachine proxy.
 *
 * - URL-bearing attributes (href, src, srcset, action, formaction, poster,
 *   data, manifest, background, cite, longdesc) on the standard HTML tags
 *   are resolved against the effective base and replaced with absolute
 *   proxy URLs.
 * - `<meta http-equiv="refresh">` is parsed and the URL portion is rewritten.
 * - `<style>` blocks and inline `style=""` attributes have their `url(...)`
 *   refs rewritten via {@link rewriteCssUrls}.
 * - Any `<base href>` set by the archived page is honored as the effective
 *   base for relative-URL resolution, then the `<base>` tag is REMOVED from
 *   the output. We never want the live browser resolving against the
 *   original origin — all emitted URLs are absolute proxy URLs.
 *
 * JS string literals (`window.location = "…"` etc.) are intentionally not
 * rewritten — safe rewriting requires AST parsing of arbitrary JavaScript,
 * which is out of scope.
 */
export function rewriteHtmlUrls(
	html: string,
	pageUrl: string,
	proxyBase: string,
	time: string,
): string {
	const root = parse(html);

	// Honor any <base href> the archived page set (the original browser would
	// have done the same), then remove the <base> tag from the output.
	let effectiveBase = pageUrl;
	for (const b of root.querySelectorAll("base")) {
		const href = b.getAttribute("href");
		if (href) {
			try {
				effectiveBase = new URL(href, pageUrl).href;
			} catch {
				/* malformed base href — keep pageUrl */
			}
		}
		b.remove();
	}

	for (const [tag, attrs] of URL_ATTRS_BY_TAG) {
		for (const el of root.querySelectorAll(tag)) {
			for (const attr of attrs) {
				const v = el.getAttribute(attr);
				if (!v) continue;
				const proxied = toProxyUrl(v, effectiveBase, proxyBase, time);
				if (proxied) el.setAttribute(attr, proxied);
			}
		}
	}

	for (const tag of SRCSET_TAGS) {
		for (const el of root.querySelectorAll(tag)) {
			const v = el.getAttribute("srcset");
			if (v) el.setAttribute("srcset", rewriteSrcset(v, effectiveBase, proxyBase, time));
		}
	}

	for (const m of root.querySelectorAll("meta")) {
		const equiv = m.getAttribute("http-equiv");
		if (equiv && equiv.toLowerCase() === "refresh") {
			const c = m.getAttribute("content");
			if (c) m.setAttribute("content", rewriteMetaRefresh(c, effectiveBase, proxyBase, time));
		}
	}

	for (const s of root.querySelectorAll("style")) {
		const css = s.innerHTML;
		if (css) s.set_content(rewriteCssUrls(css, effectiveBase, proxyBase, time));
	}

	// Inline style="" — walk the tree once. node-html-parser doesn't expose a
	// global attribute selector, so we recurse over element nodes.
	const visit = (node: HTMLElement): void => {
		const style = node.getAttribute("style");
		if (style) node.setAttribute("style", rewriteCssUrls(style, effectiveBase, proxyBase, time));
		for (const child of node.childNodes) {
			if ((child as { nodeType?: number }).nodeType === 1) {
				visit(child as HTMLElement);
			}
		}
	};
	for (const child of root.childNodes) {
		if ((child as { nodeType?: number }).nodeType === 1) {
			visit(child as HTMLElement);
		}
	}

	return root.toString();
}

const RE_LEADING_WHITESPACE = /^[\s\t\r\n]+</i;
const RE_WAYBACK_JS_HEAD = /((?:<head[^>]*>))[\s\S]*?<!-- End Wayback Rewrite JS Include -->/i;
const RE_WAYBACK_JS_HTML = /((?:<html[^>]*>))[\s\S]*?<!-- End Wayback Rewrite JS Include -->/i;
const RE_WAYBACK_TOOLBAR =
	/<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/gi;

/**
 * Strip Wayback Machine markers the downloader sometimes leaves behind:
 *   - the toolbar HTML block,
 *   - the JS rewrite include in <head> / <html>,
 *   - leading whitespace before the first tag.
 *
 * Does NOT inject a `<base href>` (it used to). The URL rewriter emits
 * absolute proxy URLs for every reference, and a stray <base> pointing at
 * the original origin would send any unrewritten relative reference (e.g.
 * inside JavaScript) to the live web.
 */
export const stripWaybackToolbar = (html: string): string =>
	html
		.replace(RE_LEADING_WHITESPACE, "<")
		.replace(RE_WAYBACK_JS_HEAD, "$1")
		.replace(RE_WAYBACK_JS_HTML, "$1")
		.replace(RE_WAYBACK_TOOLBAR, "");
