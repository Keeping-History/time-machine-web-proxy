// Akamai and similar CDN hostnames that embed the origin URL in their path.
// Matches *.akamai.net, *.akamaiedge.net, *.akamaihd.net, *.edgekey.net,
// *.edgesuite.net. Intentionally conservative — we'd rather skip unwrapping
// a CDN URL than misidentify a real host.
const RE_CDN_HOST =
	/\.akamai(?:edge|hd|technologies)?\.(?:net|com)$|\.(?:edgekey|edgesuite|akadns)\.net$/i;

// A path segment that could be an embedded hostname: has at least one dot,
// all labels valid (alphanumeric + hyphens), last label is not a file extension.
// Scanning left-to-right, the embedded hostname always precedes the real path,
// so we take the first match.
const RE_HOSTNAME_SEGMENT = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const RE_FILE_EXTENSION =
	/^(?:gif|jpe?g|png|webp|svg|ico|bmp|tiff?|avif|css|js|mjs|map|woff2?|ttf|eot|otf|mp[34]|webm|ogg|wav|flac|m4[av]|pdf|zip|tar|gz|bz2|swf|flv|avi|mov|mkv|ts|m3u8|vtt|srt|json|xml|txt|html?|ashx|aspx|php|cgi|cfm)$/i;

/**
 * If `url` is a CDN URL with an embedded origin URL in its path (e.g. Akamai
 * `/7/284/3299/<hash>/www.example.com/image.gif`), returns the reconstructed
 * origin URL. Returns null when the pattern is not recognised.
 *
 * Used as a fallback when the CDN-addressed URL is not in the archive but the
 * direct origin URL might be.
 */
export function extractCdnEmbeddedUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (!RE_CDN_HOST.test(parsed.hostname)) return null;

	const segments = parsed.pathname.split("/").filter(Boolean);
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (!RE_HOSTNAME_SEGMENT.test(seg)) continue;
		const lastLabel = seg.slice(seg.lastIndexOf(".") + 1);
		if (RE_FILE_EXTENSION.test(lastLabel)) continue;
		const rest = segments.slice(i + 1);
		return `${parsed.protocol}//${seg}/${rest.join("/")}${parsed.search}`;
	}
	return null;
}

// Well-known tracking/redirect URL patterns. Each regex captures the
// destination URL in group 1. Patterns are applied in order; first match wins.
const REDIRECT_PATTERNS: RegExp[] = [
	// Yahoo click-tracking: host is srd.yahoo.com or rd.yahoo.com, path
	// contains *{actual_url}. The greedy .* finds the last * in the path so
	// chained redirects (/*a/*http://...) still resolve correctly.
	/^https?:\/\/(?:srd|rd)\.yahoo\.com\/.*\*(https?:\/\/.+)$/i,
	// AOL click-tracking: r.aol.com/cgi/redir-complex?url={actual_url}&sid=...
	// Without this, every redir-complex URL collapses to the same cache key
	// and serves the first-visited destination for all subsequent visits.
	/^https?:\/\/r\.aol\.com\/cgi\/redir-complex\?url=(https?:\/\/.+)$/i,
	// AOL dynamic redirector: dynamic.aol.com/cgi/redir?{actual_url}. The
	// destination URL sits directly in the query string with no key=, so
	// match it raw after the `?`.
	/^https?:\/\/dynamic\.aol\.com\/cgi\/redir\?(https?:\/\/.+)$/i,
	// Excite click-tracking: r.excite.com/r/{params};{actual_url}. The
	// destination URL follows a semicolon within the path segment.
	/^https?:\/\/r\.excite\.com\/r\/[^;]*;(https?:\/\/.+)$/i,
];

/**
 * If rawUrl matches a known tracking/redirect pattern, returns the embedded
 * destination URL. Otherwise returns rawUrl unchanged.
 */
export function unwrapRedirectUrl(rawUrl: string): string {
	for (const pattern of REDIRECT_PATTERNS) {
		const m = rawUrl.match(pattern);
		if (m?.[1]) return m[1];
	}
	return rawUrl;
}
