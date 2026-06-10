import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parse, serialize } from "parse5";
import { extractCdnEmbeddedUrl, unwrapRedirectUrl } from "./redirect-unwrapper";
import { generateShimScript } from "./runtime-shim";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const RE_LEADING_WHITESPACE = /^[\s\t\r\n]+</i;
const RE_WAYBACK_JS_HEAD = /((?:<head[^>]*>))[\s\S]*?<!-- End Wayback Rewrite JS Include -->/i;
const RE_WAYBACK_JS_HTML = /((?:<html[^>]*>))[\s\S]*?<!-- End Wayback Rewrite JS Include -->/i;
const RE_WAYBACK_TOOLBAR =
	/<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/gi;

// Wayback archive URL (absolute, protocol-relative, or path-relative), with
// optional 1-3 char content-type modifier (im_, cs_, js_, if_, fw_, …)
// between timestamp and the original URL. Capture: (timestamp, originalUrl).
// Protocol-relative `//web.archive.org/...` shows up in cached HTML because
// Wayback rewrites absolute archive references that way; missing it caused
// the rewriter to fall through to new URL() resolution and emit
// doubly-wrapped paths that the router 404s on.
const RE_ARCHIVE_URL =
	/^(?:(?:https?:)?\/\/web\.archive\.org)?\/web\/(\d{1,14})(?:[a-z]{1,3}_)?\/(https?:\/\/.+)$/i;

// Proxy path-format request: /web/{14-digit-ts}{optional 1-3 char mod}_/{url}.
// Modifier (if present) is tolerated and discarded — the proxy serves the
// same rewritten payload regardless of asset type. URL is captured raw so
// the caller can append req.url's query string to preserve the target's
// own ?foo=bar parameters.
//
// Timestamp segment is optional: `/web/{url}` is accepted and signals that
// the caller wants the configured default time (ARCHIVE_TIME). The URL
// group is constrained to start with http:// or https:// so malformed
// timestamps like `/web/2002/http://x` still parse as null rather than
// silently treating "2002/http://x" as the target URL.
const RE_WAYBACK_PATH = /^\/web\/(?:(\d{14})(?:[a-z]{1,3}_)?\/)?(https?:\/\/.+)$/i;

// Extensions whose presence flips the snapshot resolver to bidirectional
// ("closest snapshot") mode. Asset captures rarely line up with the
// page-level requested timestamp, so a strict at-or-before match would
// 404 sub-resources that exist a few hours/days later. HTML pages and
// extensionless paths stay strict so the user sees the page state they
// asked for. Lowercased; case-insensitive match in isAssetUrl.
const ASSET_EXTENSIONS = new Set([
	"gif",
	"jpg",
	"jpeg",
	"png",
	"webp",
	"svg",
	"ico",
	"bmp",
	"tiff",
	"avif",
	"css",
	"js",
	"mjs",
	"map",
	"woff",
	"woff2",
	"ttf",
	"eot",
	"otf",
	"mp3",
	"mp4",
	"webm",
	"ogg",
	"wav",
	"flac",
	"m4a",
	"m4v",
	"pdf",
]);

export const isAssetUrl = (url: string): boolean => {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return false;
	}
	const lastSlash = pathname.lastIndexOf("/");
	const lastSegment = lastSlash === -1 ? pathname : pathname.slice(lastSlash + 1);
	const lastDot = lastSegment.lastIndexOf(".");
	if (lastDot <= 0) return false;
	return ASSET_EXTENSIONS.has(lastSegment.slice(lastDot + 1).toLowerCase());
};

const RE_CSS_URL = /(url\s*\(\s*['"]?)([^'")]+?)(['"]?\s*\))/gi;

export interface DiscoveredAsset {
	url: string;
	embeddedTs: string;
}

/** Deduplication key for discovered assets */
const assetKey = (a: DiscoveredAsset): string => `${a.embeddedTs}:${a.url}`;

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
		// rewriting) is preserved. Timestamp may be absent (`/web/<url>`), in
		// which case the fallback time supplied by the caller wins.
		const pathMatch = nested.pathname.match(RE_WAYBACK_PATH);
		if (pathMatch) {
			return { url: `${pathMatch[2]}${nested.search}`, time: pathMatch[1] ?? fallbackTime };
		}
	} catch {
		/* not a valid absolute URL — use as-is */
	}
	return { url, time: fallbackTime };
};

/**
 * Parse the proxy's path-based input format `/web/{ts}{mod?}_/{url}` or
 * its no-timestamp variant `/web/{url}`.
 *
 * Pass the raw `req.url` (NOT a value that has been through `new URL()`)
 * so the target URL's own query string is preserved untouched — `new URL()`
 * would split at the first `?` and treat the target's query as the proxy's.
 *
 * When the timestamp segment is absent, `time` is null and the caller is
 * expected to substitute the configured default (ARCHIVE_TIME).
 *
 * Returns null when the path does not match either format.
 */
export const parseWaybackPath = (
	rawReqUrl: string,
): { time: string | null; url: string } | null => {
	const m = rawReqUrl.match(RE_WAYBACK_PATH);
	return m ? { time: m[1] ?? null, url: m[2] } : null;
};

const buildProxyUrl = (originalUrl: string, time: string, lockTime: boolean, proxyBase = ""): string => {
	const path = lockTime ? `/web/${originalUrl}` : `/web/${time}/${originalUrl}`;
	return proxyBase ? `${proxyBase}${path}` : path;
};

const rewriteOneUrl = (
	raw: string,
	targetUrl: string,
	fallbackTime: string,
	lockTime: boolean,
	collect?: Set<string>,
	assets?: DiscoveredAsset[],
	proxyBase = "",
): string => {
	if (!raw) return raw;
	const trimmed = raw.trim();
	if (!trimmed || RE_SKIP_PREFIX.test(trimmed)) return raw;

	// Already proxied through this proxy instance: unwrap and re-wrap so
	// lockTime / proxyBase changes apply uniformly and double-wrapping is avoided.
	// A URL in the form `{proxyBase}/web/{ts}/{url}` must be treated as if it
	// arrived as a plain archive reference — extract ts + inner url, then emit
	// a single clean proxy URL. Without this, a <link href> that the rewriter
	// already emitted in absolute-proxy form gets wrapped again, producing
	// `/web/<ts>/http://localhost:8080/web/<ts>/<url>`.
	if (proxyBase && trimmed.startsWith(proxyBase)) {
		const suffix = trimmed.slice(proxyBase.length);
		const alreadyProxied = suffix.match(RE_WAYBACK_PATH);
		if (alreadyProxied) {
			const [, ts, innerUrl] = alreadyProxied;
			const resolvedTs = ts ?? fallbackTime;
			return buildProxyUrl(innerUrl, resolvedTs, lockTime, proxyBase);
		}
	}

	const archive = trimmed.match(RE_ARCHIVE_URL);
	if (archive) {
		const [, ts, rawOriginal] = archive;
		// Akamai-style CDN URLs embed the origin in their path
		// (`a388.g.akamai.net/f/.../www.cnn.com/img.gif`). Unwrap here so the
		// emitted proxy URL — and the prewarm asset record — point at the origin
		// the browser actually wants, not the CDN address that's unlikely to be
		// archived under that exact form.
		const originalUrl = extractCdnEmbeddedUrl(rawOriginal) ?? rawOriginal;
		// Only record when the embedded timestamp is a valid 14-digit string.
		// Prewarm discovery still uses the embedded ts even when lockTime drops
		// it from the emitted URL — the source-of-truth capture time is needed
		// to actually fetch the asset from the archive.
		if (collect !== undefined && assets !== undefined && /^\d{14}$/.test(ts)) {
			const asset: DiscoveredAsset = { url: originalUrl, embeddedTs: ts };
			const key = assetKey(asset);
			if (!collect.has(key)) {
				collect.add(key);
				assets.push(asset);
			}
		}
		return buildProxyUrl(originalUrl, ts, lockTime, proxyBase);
	}

	try {
		const unwrapped = unwrapRedirectUrl(trimmed);
		const cdnUnwrapped = extractCdnEmbeddedUrl(unwrapped) ?? unwrapped;
		const resolved = new URL(cdnUnwrapped, targetUrl);
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return raw;
		return buildProxyUrl(resolved.toString(), fallbackTime, lockTime, proxyBase);
	} catch {
		return raw;
	}
};

const rewriteSrcsetValue = (
	srcset: string,
	targetUrl: string,
	time: string,
	lockTime: boolean,
	collect?: Set<string>,
	assets?: DiscoveredAsset[],
	proxyBase = "",
): string =>
	srcset
		.split(",")
		.map((part) => {
			const trimmed = part.trim();
			if (!trimmed) return "";
			const match = trimmed.match(/^(\S+)(\s+.+)?$/);
			if (!match) return trimmed;
			return `${rewriteOneUrl(match[1], targetUrl, time, lockTime, collect, assets, proxyBase)}${match[2] ?? ""}`;
		})
		.filter(Boolean)
		.join(", ");

export const rewriteCssUrls = (
	css: string,
	targetUrl: string,
	time: string,
	lockTime = false,
	collect?: Set<string>,
	assets?: DiscoveredAsset[],
	proxyBase = "",
): string =>
	css.replace(RE_CSS_URL, (_, before, url, after) => {
		const rewritten = rewriteOneUrl(url, targetUrl, time, lockTime, collect, assets, proxyBase);
		return `${before}${rewritten}${after}`;
	});

const rewriteMetaRefresh = (
	content: string,
	targetUrl: string,
	time: string,
	lockTime: boolean,
	collect?: Set<string>,
	assets?: DiscoveredAsset[],
	proxyBase = "",
): string => {
	const m = content.match(META_REFRESH_RE);
	if (!m) return content;
	const prefix = m[1];
	let url = m[2];
	let quote = "";
	if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
		quote = url[0];
		url = url.slice(1, -1);
	}
	return `${prefix}${quote}${rewriteOneUrl(url, targetUrl, time, lockTime, collect, assets, proxyBase)}${quote}`;
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
//
// Wayback's default rendering injects a `<base href="https://web.archive.org/
// web/<ts>/<original>/">` into many archived pages. Resolving relative URLs
// against that wrapped base produces doubly-wrapped absolute URLs that the
// per-URL rewriter then proxies verbatim (e.g. `/web/<page-ts>/https://web.
// archive.org/web/<inner-ts>/<original>/r/ar`). Unwrap the wayback prefix
// here so relative URLs resolve against the original site, not the wrapper.
const consumeBaseTag = (node: Node, currentBase: string): string => {
	let effectiveBase = currentBase;
	if (!hasChildNodes(node)) return effectiveBase;
	const remaining = node.childNodes.filter((child) => {
		if (isElement(child) && child.tagName.toLowerCase() === "base") {
			const hrefAttr = child.attrs.find((a) => a.name === "href");
			if (hrefAttr?.value) {
				try {
					const resolved = new URL(hrefAttr.value, currentBase).href;
					const archive = resolved.match(RE_ARCHIVE_URL);
					effectiveBase = archive ? archive[2] : resolved;
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

const visit = (
	node: Node,
	targetUrl: string,
	time: string,
	lockTime: boolean,
	collect: Set<string>,
	assets: DiscoveredAsset[],
	proxyBase = "",
): void => {
	if (isElement(node)) {
		const tag = node.tagName.toLowerCase();
		const urlAttrs = TAG_URL_ATTRS[tag];
		const metaRefresh = isMetaRefresh(node);
		for (const attr of node.attrs) {
			if (urlAttrs?.includes(attr.name)) {
				attr.value = SRCSET_ATTRS.has(attr.name)
					? rewriteSrcsetValue(attr.value, targetUrl, time, lockTime, collect, assets, proxyBase)
					: rewriteOneUrl(attr.value, targetUrl, time, lockTime, collect, assets, proxyBase);
			} else if (metaRefresh && attr.name === "content") {
				attr.value = rewriteMetaRefresh(attr.value, targetUrl, time, lockTime, collect, assets, proxyBase);
			} else if (attr.name === "style") {
				attr.value = rewriteCssUrls(attr.value, targetUrl, time, lockTime, collect, assets, proxyBase);
			}
		}
		if (tag === "style") {
			for (const child of node.childNodes) {
				if (isTextNode(child)) {
					child.value = rewriteCssUrls(child.value, targetUrl, time, lockTime, collect, assets, proxyBase);
				}
			}
		}
	}
	if (hasChildNodes(node)) {
		for (const child of node.childNodes) visit(child, targetUrl, time, lockTime, collect, assets, proxyBase);
	}
};

export interface RewriteHtmlResult {
	html: string;
	discoveredAssets: DiscoveredAsset[];
}

// Walk the tree depth-first to find the first element with the given tag name.
const findElement = (node: Node, tag: string): Element | null => {
	if (isElement(node) && node.tagName.toLowerCase() === tag) return node;
	if (hasChildNodes(node)) {
		for (const child of node.childNodes) {
			const found = findElement(child, tag);
			if (found) return found;
		}
	}
	return null;
};

// Inject <meta name="wayback-context"> and the runtime shim <script> as the
// first two children of <head>, so they execute before any page scripts.
const injectShim = (doc: ParentNode, targetUrl: string, time: string, lockTime: boolean): void => {
	const head = findElement(doc, "head");
	if (!head) return;

	// Build <meta name="wayback-context" data-ts="..." data-url="..." data-lock-time="...">
	const metaNode = defaultTreeAdapter.createElement(
		"meta", // parse5's NS enum is not in its public exports; the HTML namespace URI is the correct runtime value
		"http://www.w3.org/1999/xhtml" as unknown as Parameters<
			typeof defaultTreeAdapter.createElement
		>[1],
		[
			{ name: "name", value: "wayback-context" },
			{ name: "data-ts", value: time },
			{ name: "data-url", value: targetUrl },
			{ name: "data-lock-time", value: lockTime ? "true" : "false" },
		],
	);

	// Build <script>...</script> containing the shim IIFE
	const scriptNode = defaultTreeAdapter.createElement(
		"script", // parse5's NS enum is not in its public exports; the HTML namespace URI is the correct runtime value
		"http://www.w3.org/1999/xhtml" as unknown as Parameters<
			typeof defaultTreeAdapter.createElement
		>[1],
		[],
	);
	const scriptText = defaultTreeAdapter.createTextNode(
		generateShimScript(time, targetUrl, lockTime),
	);
	defaultTreeAdapter.appendChild(scriptNode, scriptText);

	// Insert as first two children of <head>
	const firstChild = head.childNodes[0];
	if (firstChild) {
		defaultTreeAdapter.insertBefore(head, metaNode, firstChild);
		// After inserting metaNode, the new first child we want to insert before is
		// what was originally firstChild, now at index 1.
		defaultTreeAdapter.insertBefore(head, scriptNode, firstChild);
	} else {
		defaultTreeAdapter.appendChild(head, metaNode);
		defaultTreeAdapter.appendChild(head, scriptNode);
	}
};

export const rewriteHtmlUrls = (
	html: string,
	targetUrl: string,
	time: string,
	lockTime = false,
	proxyBase = "",
): RewriteHtmlResult => {
	const collect = new Set<string>();
	const assets: DiscoveredAsset[] = [];
	const doc = parse(html);
	// <base href> handling first so its effective base is used during visit().
	const effectiveBase = consumeBaseTag(doc, targetUrl);
	visit(doc, effectiveBase, time, lockTime, collect, assets, proxyBase);
	injectShim(doc, targetUrl, time, lockTime);
	return { html: serialize(doc), discoveredAssets: assets };
};

export const stripWaybackToolbar = (html: string): string =>
	html
		.replace(RE_LEADING_WHITESPACE, "<")
		.replace(RE_WAYBACK_JS_HEAD, "$1")
		.replace(RE_WAYBACK_JS_HTML, "$1")
		.replace(RE_WAYBACK_TOOLBAR, "");

const isStylesheetLink = (node: Node): node is Element => {
	if (!isElement(node) || node.tagName.toLowerCase() !== "link") return false;
	const rel = node.attrs.find((a) => a.name === "rel")?.value ?? "";
	const tokens = rel.trim().toLowerCase().split(/\s+/);
	return tokens.length === 1 && tokens[0] === "stylesheet";
};

export const inlineCssLinks = async (
	html: string,
	fetchCss: (cssUrl: string, ts: string) => Promise<string | null>,
	time: string,
	lockTime: boolean,
	proxyBase: string,
): Promise<string> => {
	const doc = parse(html);
	const linkNodes: Element[] = [];

	const collectLinks = (node: Node): void => {
		if (isStylesheetLink(node)) {
			linkNodes.push(node as Element);
		}
		if (hasChildNodes(node)) {
			for (const child of node.childNodes) collectLinks(child);
		}
	};
	collectLinks(doc);

	for (const link of linkNodes) {
		const hrefAttr = link.attrs.find((a) => a.name === "href");
		if (!hrefAttr?.value) continue;

		const rawHref = hrefAttr.value;
		const path =
			proxyBase && rawHref.startsWith(proxyBase) ? rawHref.slice(proxyBase.length) : rawHref;
		const match = path.match(RE_WAYBACK_PATH);
		if (!match) continue;

		const [, ts, cssUrl] = match;
		const resolvedTs = ts ?? time;

		const cssContent = await fetchCss(cssUrl, resolvedTs);
		if (!cssContent) continue;

		const rewritten = rewriteCssUrls(cssContent, cssUrl, resolvedTs, lockTime, undefined, undefined, proxyBase);

		const styleNode = defaultTreeAdapter.createElement(
			"style",
			"http://www.w3.org/1999/xhtml" as unknown as Parameters<
				typeof defaultTreeAdapter.createElement
			>[1],
			[],
		);

		const mediaAttr = link.attrs.find((a) => a.name === "media");
		if (mediaAttr) {
			styleNode.attrs.push({ name: "media", value: mediaAttr.value });
		}

		const textNode = defaultTreeAdapter.createTextNode(rewritten);
		defaultTreeAdapter.appendChild(styleNode, textNode);

		const parent = link.parentNode;
		if (!parent) continue;
		const idx = (parent as ParentNode).childNodes.indexOf(link);
		(parent as ParentNode).childNodes.splice(idx, 1, styleNode);
		styleNode.parentNode = parent as ParentNode;
	}

	return serialize(doc);
};
