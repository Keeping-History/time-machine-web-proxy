const RE_ARCHIVE_ABSOLUTE =
	/(<a\b[^>]*\bhref\s*=\s*["'])https?:\/\/web\.archive\.org\/web\/(\d{1,14})\/(https?:\/\/[^"']*)(["'])/gi;
const RE_ARCHIVE_RELATIVE =
	/(<a\b[^>]*\bhref\s*=\s*["'])\/web\/(\d{1,14})\/(https?:\/\/[^"']*)(["'])/gi;
const RE_CSS_URL_ABSOLUTE =
	/(url\s*\(\s*['"]?)https?:\/\/web\.archive\.org\/web\/\d{1,14}[^/]*\/(https?:\/\/[^"')]*?)(['"]?\s*\))/gi;
const RE_CSS_URL_RELATIVE =
	/(url\s*\(\s*['"]?)\/web\/\d{1,14}[^/]*\/(https?:\/\/[^"')]*?)(['"]?\s*\))/gi;
const RE_LEADING_WHITESPACE = /^[\s\t\r\n]+</i;
const RE_WAYBACK_JS_HEAD = /((?:<head[^>]*>))[\s\S]*?<!-- End Wayback Rewrite JS Include -->/i;
const RE_WAYBACK_JS_HTML = /((?:<html[^>]*>))[\s\S]*?<!-- End Wayback Rewrite JS Include -->/i;
const RE_WAYBACK_TOOLBAR =
	/<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/gi;
const RE_HEAD_TAG = /(<head[^>]*>)/i;

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

export const rewriteArchiveLinks = (html: string, proxyBase: string): string =>
	html
		.replace(
			RE_ARCHIVE_ABSOLUTE,
			(_, before, archiveTime, originalUrl, after) =>
				`${before}${proxyBase}/?url=${encodeURIComponent(originalUrl)}&time=${archiveTime}${after}`,
		)
		.replace(
			RE_ARCHIVE_RELATIVE,
			(_, before, archiveTime, originalUrl, after) =>
				`${before}${proxyBase}/?url=${encodeURIComponent(originalUrl)}&time=${archiveTime}${after}`,
		);

export const rewriteCssUrls = (css: string, proxyBase: string, time: string): string =>
	css
		.replace(
			RE_CSS_URL_ABSOLUTE,
			(_, before, originalUrl, after) =>
				`${before}${proxyBase}/?url=${encodeURIComponent(originalUrl)}&time=${time}${after}`,
		)
		.replace(
			RE_CSS_URL_RELATIVE,
			(_, before, originalUrl, after) =>
				`${before}${proxyBase}/?url=${encodeURIComponent(originalUrl)}&time=${time}${after}`,
		);

export const stripWaybackToolbar = (html: string, baseUrl: string): string => {
	const safeBase = baseUrl
		.replace(/&/g, "%26")
		.replace(/"/g, "%22")
		.replace(/'/g, "%27")
		.replace(/</g, "%3C")
		.replace(/>/g, "%3E");
	return html
		.replace(RE_LEADING_WHITESPACE, "<")
		.replace(RE_WAYBACK_JS_HEAD, "$1")
		.replace(RE_WAYBACK_JS_HTML, "$1")
		.replace(RE_WAYBACK_TOOLBAR, "")
		.replace(RE_HEAD_TAG, `$1<base href="${safeBase}">`);
};
