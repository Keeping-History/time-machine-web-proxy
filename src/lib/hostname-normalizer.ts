export const CDN_SUFFIXES = [
	".edgesuite.net",
	".edgekey.net",
	".akamaiedge.net",
	".akamaihd.net",
	".akamai.net",
];

// After stripping a CDN suffix, the remaining prefix must look like a real
// origin host — at least one dot and a final label of 2+ letters (a plausible
// TLD). This is what distinguishes the two Akamai URL shapes:
//   - hostname-prefix:  www.msnbc.com.edgesuite.net → strip → "www.msnbc.com" ✓
//   - path-embedded:    a772.g.akamai.net/.../www.apple.com/x.gif → "a772.g" ✗
// The path-embedded kind leaves an edge-node name like "a772.g" once the suffix
// is gone; that is not the origin (which lives in the URL path). We leave such
// URLs untouched here so extractCdnEmbeddedUrl can unwrap the path downstream.
const RE_PLAUSIBLE_ORIGIN_HOST = /\.[a-z]{2,63}$/i;

export function parseDomainRemap(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	const result: Record<string, string> = {};
	for (const pair of raw.split(",")) {
		const trimmed = pair.trim();
		const eq = trimmed.indexOf("=");
		if (eq < 1) continue;
		const from = trimmed.slice(0, eq).trim();
		const to = trimmed.slice(eq + 1).trim();
		if (from && to) result[from] = to;
	}
	return result;
}

/**
 * Rewrites the hostname of a target URL using two mechanisms, in priority order:
 *   1. Explicit domain remap (config-driven, exact match)
 *   2. CDN suffix stripping (e.g. www.example.com.edgesuite.net → www.example.com)
 *
 * Returns the original string unchanged if the URL is unparseable or no rule matches.
 */
export function normalizeHostname(rawUrl: string, domainRemap: Record<string, string>): string {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return rawUrl;
	}

	const { hostname } = parsed;

	const remapped = domainRemap[hostname];
	if (remapped) {
		parsed.hostname = remapped;
		return parsed.toString();
	}

	for (const suffix of CDN_SUFFIXES) {
		if (hostname.endsWith(suffix)) {
			const stripped = hostname.slice(0, -suffix.length);
			if (stripped && RE_PLAUSIBLE_ORIGIN_HOST.test(stripped)) {
				parsed.hostname = stripped;
				return parsed.toString();
			}
		}
	}

	return rawUrl;
}
