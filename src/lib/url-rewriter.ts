import { parse, serialize, type DefaultTreeAdapterTypes } from "parse5";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const RE_LEADING_WHITESPACE = /^[\s\t\r\n]+</i;
const RE_WAYBACK_JS_HEAD = /((?:<head[^>]*>))[\s\S]*?<!-- End Wayback Rewrite JS Include -->/i;
const RE_WAYBACK_JS_HTML = /((?:<html[^>]*>))[\s\S]*?<!-- End Wayback Rewrite JS Include -->/i;
const RE_WAYBACK_TOOLBAR =
	/<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/gi;

// Wayback archive URL (absolute or path-relative), with optional 1-3 char
// content-type modifier (im_, cs_, js_, if_, fw_, …) between timestamp and
// the original URL. Capture: (timestamp, originalUrl).
const RE_ARCHIVE_URL =
	/^(?:https?:\/\/web\.archive\.org)?\/web\/(\d{1,14})(?:[a-z]{1,3}_)?\/(https?:\/\/.+)$/i;

// Proxy path-format request: /web/{14-digit-ts}{optional 1-3 char mod}_/{url}.
// Modifier (if present) is tolerated and discarded — the proxy serves the
// same rewritten payload regardless of asset type. URL is captured raw so
// the caller can append req.url's query string to preserve the target's
// own ?foo=bar parameters.
const RE_WAYBACK_PATH = /^\/web\/(\d{14})(?:[a-z]{1,3}_)?\/(.+)$/i;

const RE_CSS_URL = /(url\s*\(\s*['"]?)([^'")]+?)(['"]?\s*\))/gi;

// Schemes/anchors that must never be rewritten.
const RE_SKIP_PREFIX = /^(?:data:|mailto:|tel:|javascript:|blob:|about:|#)/i;

const TAG_URL_ATTRS: Record<string, readonly string[]> = {
	a: ["href"],
	area: ["href"],
	audio: ["src"],
	base: ["href"],
	button: ["formaction"],
	embed: ["src"],
	form: ["action"],
	iframe: ["src"],
	img: ["src", "srcset"],
	input: ["src", "formaction"],
	link: ["href"],
	object: ["data"],
	script: ["src"],
	source: ["src", "srcset"],
	track: ["src"],
	video: ["poster", "src"],
};

const SRCSET_ATTRS = new Set(["srcset"]);

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
		if (nested.hostname !== proxyBaseHostname) return { url, time: fallbackTime };

		// Legacy /?url=<enc>&time=<ts> format
		if (nested.searchParams.has("url")) {
			const inner = nested.searchParams.get("url");
			if (inner) {
				const innerTime = nested.searchParams.get("time");
				return {
					url: inner,
					time: innerTime && /^\d{14}$/.test(innerTime) ? innerTime : fallbackTime,
				};
			}
		}

		// New /web/<ts>/<url> format. Append nested.search so the target URL's
		// own query string (which lives on the proxy URL after path-based
		// rewriting) is preserved.
		const pathMatch = nested.pathname.match(RE_WAYBACK_PATH);
		if (pathMatch) {
			return { url: `${pathMatch[2]}${nested.search}`, time: pathMatch[1] };
		}
	} catch {
		/* not a valid absolute URL — use as-is */
	}
	return { url, time: fallbackTime };
};

/**
 * Parse the proxy's path-based input format `/web/{ts}{mod?}_/{url}`.
 *
 * Pass the raw `req.url` (NOT a value that has been through `new URL()`)
 * so the target URL's own query string is preserved untouched — `new URL()`
 * would split at the first `?` and treat the target's query as the proxy's.
 *
 * Returns null when the path does not match this format.
 */
export const parseWaybackPath = (rawReqUrl: string): { time: string; url: string } | null => {
	const m = rawReqUrl.match(RE_WAYBACK_PATH);
	return m ? { time: m[1], url: m[2] } : null;
};

const buildProxyUrl = (originalUrl: string, time: string): string =>
	`/web/${time}/${originalUrl}`;

const rewriteOneUrl = (raw: string, targetUrl: string, fallbackTime: string): string => {
	if (!raw) return raw;
	const trimmed = raw.trim();
	if (!trimmed || RE_SKIP_PREFIX.test(trimmed)) return raw;

	const archive = trimmed.match(RE_ARCHIVE_URL);
	if (archive) return buildProxyUrl(archive[2], archive[1]);

	try {
		const resolved = new URL(trimmed, targetUrl);
		return buildProxyUrl(resolved.toString(), fallbackTime);
	} catch {
		return raw;
	}
};

const rewriteSrcsetValue = (srcset: string, targetUrl: string, time: string): string =>
	srcset
		.split(",")
		.map((part) => {
			const trimmed = part.trim();
			if (!trimmed) return "";
			const match = trimmed.match(/^(\S+)(\s+.+)?$/);
			if (!match) return trimmed;
			return `${rewriteOneUrl(match[1], targetUrl, time)}${match[2] ?? ""}`;
		})
		.filter(Boolean)
		.join(", ");

export const rewriteCssUrls = (css: string, targetUrl: string, time: string): string =>
	css.replace(RE_CSS_URL, (_, before, url, after) => {
		const rewritten = rewriteOneUrl(url, targetUrl, time);
		return `${before}${rewritten}${after}`;
	});

const isElement = (node: Node): node is Element =>
	typeof (node as Partial<Element>).tagName === "string";

const isTextNode = (node: Node): node is TextNode => node.nodeName === "#text";

const hasChildNodes = (node: Node): node is ParentNode =>
	Array.isArray((node as Partial<ParentNode>).childNodes);

const visit = (node: Node, targetUrl: string, time: string): void => {
	if (isElement(node)) {
		const tag = node.tagName.toLowerCase();
		const urlAttrs = TAG_URL_ATTRS[tag];
		for (const attr of node.attrs) {
			if (urlAttrs?.includes(attr.name)) {
				attr.value = SRCSET_ATTRS.has(attr.name)
					? rewriteSrcsetValue(attr.value, targetUrl, time)
					: rewriteOneUrl(attr.value, targetUrl, time);
			} else if (attr.name === "style") {
				attr.value = rewriteCssUrls(attr.value, targetUrl, time);
			}
		}
		if (tag === "style") {
			for (const child of node.childNodes) {
				if (isTextNode(child)) {
					child.value = rewriteCssUrls(child.value, targetUrl, time);
				}
			}
		}
	}
	if (hasChildNodes(node)) {
		for (const child of node.childNodes) visit(child, targetUrl, time);
	}
};

export const rewriteHtmlUrls = (html: string, targetUrl: string, time: string): string => {
	const doc = parse(html);
	visit(doc, targetUrl, time);
	return serialize(doc);
};

export const stripWaybackToolbar = (html: string): string =>
	html
		.replace(RE_LEADING_WHITESPACE, "<")
		.replace(RE_WAYBACK_JS_HEAD, "$1")
		.replace(RE_WAYBACK_JS_HTML, "$1")
		.replace(RE_WAYBACK_TOOLBAR, "");
