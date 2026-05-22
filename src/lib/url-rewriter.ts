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

// Schemes/anchors that must never be rewritten — opaque or non-network
// protocols whose semantics break if proxied. List ported from main:
// covers data URIs, mail/JS/dial/SMS handlers, blob/about/file/ftp,
// websockets, magnet links, and platform/extension-internal URIs.
const RE_SKIP_PREFIX =
	/^(?:data:|mailto:|javascript:|tel:|sms:|blob:|about:|file:|ftp:|geo:|ws:|wss:|magnet:|view-source:|chrome:|safari-extension:|#)/i;

// Tag → URL-bearing attributes. `<base>` is intentionally excluded: its href
// is honored as the effective base for relative-URL resolution inside
// rewriteHtmlUrls, then the tag is REMOVED entirely so the live browser
// can't fall back to the archived origin for any unrewritten refs.
const TAG_URL_ATTRS: Record<string, readonly string[]> = {
	a: ["href"],
	area: ["href"],
	audio: ["src"],
	blockquote: ["cite"],
	body: ["background"],
	button: ["formaction"],
	del: ["cite"],
	embed: ["src"],
	form: ["action"],
	frame: ["src", "longdesc"],
	html: ["manifest"],
	iframe: ["src", "longdesc"],
	img: ["src", "srcset", "longdesc"],
	input: ["src", "formaction"],
	ins: ["cite"],
	link: ["href"],
	object: ["data"],
	q: ["cite"],
	script: ["src"],
	source: ["src", "srcset"],
	table: ["background"],
	td: ["background"],
	th: ["background"],
	track: ["src"],
	tr: ["background"],
	video: ["poster", "src"],
};

const SRCSET_ATTRS = new Set(["srcset"]);

// `<meta http-equiv="refresh" content="<delay>;url=<url>">`. The URL portion
// may be absent (refresh same page) — return unchanged then. Case-insensitive
// on the `url=` separator; tolerates surrounding single/double quotes.
const META_REFRESH_RE = /^(\s*\d+\s*;\s*url\s*=\s*)(.+?)\s*$/i;

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
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return raw;
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

const rewriteMetaRefresh = (content: string, targetUrl: string, time: string): string => {
	const m = content.match(META_REFRESH_RE);
	if (!m) return content;
	const prefix = m[1];
	let url = m[2];
	let quote = "";
	if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
		quote = url[0];
		url = url.slice(1, -1);
	}
	return `${prefix}${quote}${rewriteOneUrl(url, targetUrl, time)}${quote}`;
};

const isElement = (node: Node): node is Element =>
	typeof (node as Partial<Element>).tagName === "string";

const isTextNode = (node: Node): node is TextNode => node.nodeName === "#text";

const hasChildNodes = (node: Node): node is ParentNode =>
	Array.isArray((node as Partial<ParentNode>).childNodes);

// Honor any <base href> the archived page set (the original browser would
// have done the same), then return the new effective base. Removes the
// <base> tag(s) from the tree so the live browser can't fall back to the
// archived origin for any unrewritten refs.
const consumeBaseTag = (node: Node, currentBase: string): string => {
	let effectiveBase = currentBase;
	if (!hasChildNodes(node)) return effectiveBase;
	const remaining = node.childNodes.filter((child) => {
		if (isElement(child) && child.tagName.toLowerCase() === "base") {
			const hrefAttr = child.attrs.find((a) => a.name === "href");
			if (hrefAttr?.value) {
				try {
					effectiveBase = new URL(hrefAttr.value, currentBase).href;
				} catch {
					/* keep currentBase */
				}
			}
			return false;
		}
		if (hasChildNodes(child)) {
			effectiveBase = consumeBaseTag(child, effectiveBase);
		}
		return true;
	});
	node.childNodes = remaining;
	return effectiveBase;
};

const isMetaRefresh = (el: Element): boolean => {
	if (el.tagName.toLowerCase() !== "meta") return false;
	const httpEquiv = el.attrs.find((a) => a.name === "http-equiv");
	return httpEquiv?.value.toLowerCase() === "refresh";
};

const visit = (node: Node, targetUrl: string, time: string): void => {
	if (isElement(node)) {
		const tag = node.tagName.toLowerCase();
		const urlAttrs = TAG_URL_ATTRS[tag];
		const metaRefresh = isMetaRefresh(node);
		for (const attr of node.attrs) {
			if (urlAttrs?.includes(attr.name)) {
				attr.value = SRCSET_ATTRS.has(attr.name)
					? rewriteSrcsetValue(attr.value, targetUrl, time)
					: rewriteOneUrl(attr.value, targetUrl, time);
			} else if (metaRefresh && attr.name === "content") {
				attr.value = rewriteMetaRefresh(attr.value, targetUrl, time);
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
	// <base href> handling first so its effective base is used during visit().
	const effectiveBase = consumeBaseTag(doc, targetUrl);
	visit(doc, effectiveBase, time);
	return serialize(doc);
};

export const stripWaybackToolbar = (html: string): string =>
	html
		.replace(RE_LEADING_WHITESPACE, "<")
		.replace(RE_WAYBACK_JS_HEAD, "$1")
		.replace(RE_WAYBACK_JS_HTML, "$1")
		.replace(RE_WAYBACK_TOOLBAR, "");
